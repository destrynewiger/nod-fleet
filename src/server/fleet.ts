import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  FleetDispatchError,
  nativeEngines,
  type FleetConnection,
  type FleetProvider,
  type FleetReceipt,
  type FleetRun,
  type FleetSpec,
  type NativeEngine,
} from '../ports/fleet.ts';
import type {
  FleetBot,
  FleetDirectory,
  FleetHandoff,
  FleetJob,
  FleetView,
} from '../shared/fleet.ts';
import { transaction } from './transaction.ts';

const active = ['starting', 'running', 'queued', 'claimed', 'stopping', 'uncertain'];
const botInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    engine: z.enum([
      'muse',
      'hermes',
      'claude',
      'muse-web',
      'grok-bot',
      'instinct',
      'claude-duet',
      'dots',
    ]),
    profile: z
      .string()
      .regex(/^[a-z0-9_-]{1,64}$/i)
      .nullable(),
    deviceId: z.uuid().nullable(),
    computerName: z.string().trim().min(1).max(255).optional(),
    revision: z.number().int().min(0),
    delivery: z.enum(['native', 'crosswalk']).optional(),
    handoff: z
      .object({
        connectionId: z.uuid(),
        recipient: z.string().regex(/^\d{16}$/),
        space: z.string().min(1).max(200),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (value) => value.engine === 'hermes' || value.profile === null,
    'Only Hermes uses a named profile.',
  )
  .refine(
    (value) => !(value.handoff || value.delivery === 'crosswalk') || value.profile === null,
    'A Crosswalk handoff uses its recipient profile, not a native CLI profile.',
  );
type JobRow = {
  id: string;
  owner_id: string;
  bot_id: string;
  bot_name: string;
  computer_name: string;
  spec: FleetSpec;
  connection: FleetConnection;
  client_digest: string;
  digest: string;
  pid: number | null;
  stop_requested: boolean;
  status: FleetJob['status'];
  receipt: FleetReceipt | null;
  error: string | null;
  created_at: Date;
};
type BotRow = {
  id: string;
  name: string;
  engine: FleetBot['engine'];
  profile: string | null;
  device_id: string | null;
  computer_name: string;
  identity: FleetBot['identity'];
  revision: number;
  handoff: FleetHandoff | null;
  delivery: FleetBot['delivery'];
};
const failure = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const specHash = (spec: FleetSpec) =>
  hash([
    spec.id,
    spec.deviceId,
    spec.identityId,
    spec.hostname,
    spec.engine,
    spec.profile,
    spec.instruction,
    ...(spec.handoff
      ? [
          spec.handoff.connectionId,
          spec.handoff.connection.pathId,
          spec.handoff.connection.binding,
          spec.handoff.username,
          spec.handoff.recipient,
          spec.handoff.recipientName,
          spec.handoff.aliases,
          spec.handoff.space,
        ]
      : []),
  ]);
const botView = (row: BotRow): FleetBot => ({
  id: row.id,
  name: row.name,
  engine: row.engine,
  delivery: row.delivery,
  profile: row.profile,
  deviceId: row.device_id,
  computerName: row.computer_name,
  identity: row.identity,
  revision: row.revision,
  handoff: row.handoff ?? null,
});
const jobView = (row: JobRow): FleetJob => ({
  id: row.id,
  botId: row.bot_id,
  botName: row.bot_name,
  deviceId: row.spec.deviceId,
  computerName: row.computer_name,
  engine: row.spec.engine,
  instruction: row.spec.instruction,
  delivery: row.spec.handoff ? 'crosswalk' : 'native',
  ...(row.spec.handoff ? { recipient: row.spec.handoff.recipientName } : {}),
  status: row.status,
  receipt: row.receipt,
  error: row.error,
  createdAt: row.created_at.toISOString(),
});

export async function initializeFleetSchema(pool: Pool) {
  await pool.query(
    [
      'CREATE TABLE IF NOT EXISTS fleet_settings (owner_id text PRIMARY KEY, connection_id uuid);',
      'CREATE TABLE IF NOT EXISTS fleet_bots (id uuid NOT NULL,owner_id text NOT NULL,name text NOT NULL,engine text NOT NULL,profile text,device_id uuid,computer_name text NOT NULL,identity jsonb,revision integer NOT NULL,PRIMARY KEY(owner_id,id),UNIQUE(owner_id,name));',
      'ALTER TABLE fleet_bots ADD COLUMN IF NOT EXISTS handoff jsonb;',
      "ALTER TABLE fleet_bots ADD COLUMN IF NOT EXISTS delivery text NOT NULL DEFAULT 'native';",
      'CREATE TABLE IF NOT EXISTS fleet_jobs (id uuid NOT NULL,owner_id text NOT NULL,bot_id uuid NOT NULL,bot_name text NOT NULL,computer_name text NOT NULL,spec jsonb NOT NULL,connection jsonb NOT NULL,client_digest text NOT NULL,digest text NOT NULL,pid integer,stop_requested boolean NOT NULL DEFAULT false,status text NOT NULL,receipt jsonb,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,id),FOREIGN KEY(owner_id,bot_id) REFERENCES fleet_bots(owner_id,id));',
      "CREATE UNIQUE INDEX IF NOT EXISTS fleet_computer_active ON fleet_jobs(owner_id,(spec->>'deviceId')) WHERE status IN ('starting','running','stopping','uncertain');",
      "CREATE UNIQUE INDEX IF NOT EXISTS fleet_computer_pending ON fleet_jobs(owner_id,(spec->>'deviceId')) WHERE status IN ('starting','running','queued','claimed','stopping','uncertain');",
    ].join('\n'),
  );
}

export async function createFleet(
  pool: Pool,
  options: {
    ownerId: string;
    provider: FleetProvider;
    connections(): Promise<FleetConnection[]>;
    refresh(): void;
  },
) {
  await initializeFleetSchema(pool);
  const owner = options.ownerId;
  const controllers = new Map<string, AbortController>();
  const pending = new Set<Promise<void>>();
  const checking = new Map<string, Promise<FleetJob>>();
  let closed = false;
  await pool.query(
    "UPDATE fleet_jobs SET status='uncertain',error='Nod restarted before a final native receipt. Check this task before another run.',updated_at=now() WHERE owner_id=$1 AND status IN ('starting','running','stopping')",
    [owner],
  );
  await pool.query('INSERT INTO fleet_settings(owner_id) VALUES($1) ON CONFLICT DO NOTHING', [
    owner,
  ]);

  async function selected(client: Pool | PoolClient = pool) {
    const { rows } = await client.query<{ connection_id: string | null }>(
      'SELECT connection_id FROM fleet_settings WHERE owner_id=$1',
      [owner],
    );
    const id = rows[0]?.connection_id;
    return id
      ? (await options.connections()).find(
          (connection) => connection.connectionId === id && connection.kind !== 'crosswalk',
        )
      : undefined;
  }

  async function job(id: string) {
    const row = (
      await pool.query<JobRow>('SELECT * FROM fleet_jobs WHERE owner_id=$1 AND id=$2', [owner, id])
    ).rows[0];
    if (!row) throw failure('Native task not found.', 404);
    return row;
  }

  async function accept(row: JobRow, receipt: FleetReceipt | null) {
    if (!receipt) return jobView(await job(row.id));
    if (
      receipt.id !== row.id ||
      receipt.digest !== row.digest ||
      receipt.identityId !== row.spec.identityId ||
      receipt.hostname !== row.spec.hostname ||
      receipt.engine !== row.spec.engine
    )
      throw new FleetDispatchError(
        'The native receipt belongs to a different task or computer.',
        true,
      );
    await pool.query(
      "UPDATE fleet_jobs SET status=CASE WHEN $3 IN ('running','queued','claimed') AND stop_requested THEN 'stopping' ELSE $3 END,receipt=$4,error=$5,updated_at=now() WHERE owner_id=$1 AND id=$2 AND status=ANY($6::text[])",
      [owner, row.id, receipt.status, JSON.stringify(receipt), receipt.error ?? null, active],
    );
    options.refresh();
    return jobView(await job(row.id));
  }

  function run(row: JobRow): FleetRun {
    return {
      ...row.spec,
      digest: row.digest,
      pid: row.status === 'uncertain' ? null : row.pid,
      remoteId: row.receipt?.remoteId,
      stopRequested: row.stop_requested,
    };
  }

  async function execute(row: JobRow) {
    const controller = new AbortController();
    controllers.set(row.id, controller);
    try {
      const receipt = await options.provider.start(
        row.connection,
        row.spec,
        row.digest,
        async (pid) => {
          const result = await pool.query(
            "UPDATE fleet_jobs SET pid=$3,status='running',updated_at=now() WHERE owner_id=$1 AND id=$2 AND status='starting' RETURNING id",
            [owner, row.id, pid],
          );
          if (!result.rowCount || closed || controller.signal.aborted)
            throw new FleetDispatchError('The native task stopped before dispatch.', false);
        },
        controller.signal,
      );
      await accept(await job(row.id), receipt);
      const latest = await job(row.id);
      if (latest.stop_requested && active.includes(latest.status)) await stop(row.id);
    } catch (cause) {
      const current = await job(row.id);
      if (!active.includes(current.status)) return;
      const uncertain =
        cause instanceof FleetDispatchError ? cause.uncertain : current.pid !== null;
      const status = uncertain ? 'uncertain' : current.stop_requested ? 'stopped' : 'failed';
      await pool.query(
        'UPDATE fleet_jobs SET status=$3,error=$4,updated_at=now() WHERE owner_id=$1 AND id=$2 AND status=ANY($5::text[])',
        [owner, row.id, status, cause instanceof Error ? cause.message : String(cause), active],
      );
      options.refresh();
    } finally {
      controllers.delete(row.id);
    }
  }

  function dispatch(row: JobRow) {
    const work = execute(row);
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => {});
  }

  async function view(): Promise<FleetView> {
    const connections = await options.connections();
    const connection = await selected();
    let devices: FleetView['devices'] = [];
    let error: string | null = null;
    if (connection) {
      try {
        devices = await options.provider.devices(connection);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    }
    const [bots, jobs] = await Promise.all([
      pool.query<BotRow>('SELECT * FROM fleet_bots WHERE owner_id=$1 ORDER BY name,id', [owner]),
      pool.query<JobRow>(
        'SELECT * FROM fleet_jobs WHERE owner_id=$1 ORDER BY created_at DESC,id LIMIT 50',
        [owner],
      ),
    ]);
    return {
      connectionId: connection?.connectionId ?? null,
      connections: connections
        .filter((item) => item.kind !== 'crosswalk')
        .map((item) => ({ id: item.connectionId, name: item.name })),
      handoffConnections: connections
        .filter((item) => item.kind === 'crosswalk')
        .map((item) => ({ id: item.connectionId, name: item.name })),
      devices,
      bots: bots.rows.map(botView),
      jobs: jobs.rows.map(jobView),
      error,
    };
  }

  async function saveBot(id: string, raw: unknown) {
    const input = botInput.parse(raw);
    const delivery =
      input.delivery ??
      (input.handoff || !(nativeEngines as readonly string[]).includes(input.engine)
        ? 'crosswalk'
        : 'native');
    if (delivery === 'native' && input.handoff)
      throw failure('A native task cannot also have a Crosswalk route.', 400);
    const connection = await selected();
    const handoffConnection = input.handoff
      ? (await options.connections()).find(
          (candidate) =>
            candidate.kind === 'crosswalk' &&
            candidate.connectionId === input.handoff!.connectionId,
        )
      : undefined;
    let handoff: FleetHandoff | null = null;
    if (input.handoff) {
      if (!handoffConnection || !options.provider.directory)
        throw failure('Connect Crosswalk before saving this handoff.', 409);
      const directory = await options.provider.directory(handoffConnection);
      const recipient = directory.recipients.find((entry) => entry.id === input.handoff!.recipient);
      if (!recipient || !directory.spaces.includes(input.handoff.space))
        throw failure('Choose an existing agent and an owned private Crosswalk workspace.', 409);
      handoff = {
        connectionId: handoffConnection.connectionId,
        username: directory.username,
        recipient: recipient.id,
        recipientName: recipient.name,
        aliases: recipient.aliases,
        space: input.handoff.space,
      };
    }
    if (input.deviceId && !connection)
      throw failure('Connect Desktop Commander and select its account first.', 409);
    const device =
      input.deviceId && connection
        ? (await options.provider.devices(connection)).find((item) => item.id === input.deviceId)
        : undefined;
    if (input.deviceId && !device?.online)
      throw failure('The selected computer is not online. The assignment was not changed.', 409);
    const identity =
      device && connection ? await options.provider.probe(connection, device.id) : null;
    const bot = await transaction(async (client) => {
      await client.query('SELECT owner_id FROM fleet_settings WHERE owner_id=$1 FOR UPDATE', [
        owner,
      ]);
      if (connection && (await selected(client))?.binding !== connection.binding)
        throw failure('The computer connection changed. Select it again.', 409);
      if (
        handoffConnection &&
        !(await options.connections()).some(
          (candidate) =>
            candidate.kind === 'crosswalk' &&
            candidate.connectionId === handoffConnection.connectionId &&
            candidate.binding === handoffConnection.binding,
        )
      )
        throw failure('The Crosswalk connection changed. Verify the route again.', 409);
      const existing = (
        await client.query<BotRow>(
          'SELECT * FROM fleet_bots WHERE owner_id=$1 AND id=$2 FOR UPDATE',
          [owner, id],
        )
      ).rows[0];
      if ((existing?.revision ?? 0) !== input.revision)
        throw failure('This bot assignment changed. Reload it before saving.', 409);
      const busy = await client.query(
        'SELECT id FROM fleet_jobs WHERE owner_id=$1 AND bot_id=$2 AND status=ANY($3::text[]) LIMIT 1',
        [owner, id, active],
      );
      if (busy.rowCount)
        throw failure(
          'Finish or review this bot’s current task before changing its assignment.',
          409,
        );
      const result = await client.query<BotRow>(
        'INSERT INTO fleet_bots(id,owner_id,name,engine,profile,device_id,computer_name,identity,revision,handoff,delivery) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10) ON CONFLICT(owner_id,id) DO UPDATE SET name=EXCLUDED.name,engine=EXCLUDED.engine,profile=EXCLUDED.profile,device_id=EXCLUDED.device_id,computer_name=EXCLUDED.computer_name,identity=EXCLUDED.identity,handoff=EXCLUDED.handoff,delivery=EXCLUDED.delivery,revision=fleet_bots.revision+1 RETURNING *',
        [
          id,
          owner,
          input.name,
          input.engine,
          input.profile,
          device?.id ?? null,
          device?.name ?? input.computerName ?? 'Not assigned',
          identity ? JSON.stringify(identity) : null,
          handoff ? JSON.stringify(handoff) : null,
          delivery,
        ],
      );
      return botView(result.rows[0]!);
    }, pool);
    options.refresh();
    return bot;
  }

  async function submit(botId: string, raw: unknown) {
    if (closed) throw failure('The native task service is stopping.', 503);
    const input = z
      .object({
        id: z.uuid(),
        revision: z.number().int().positive(),
        instruction: z.string().trim().min(1).max(32000),
      })
      .strict()
      .parse(raw);
    const clientDigest = hash({ botId, revision: input.revision, instruction: input.instruction });
    const connection = await selected();
    let created = false;
    const row = await transaction(async (client) => {
      await client.query('SELECT owner_id FROM fleet_settings WHERE owner_id=$1 FOR UPDATE', [
        owner,
      ]);
      const existing = (
        await client.query<JobRow>('SELECT * FROM fleet_jobs WHERE owner_id=$1 AND id=$2', [
          owner,
          input.id,
        ])
      ).rows[0];
      if (existing) {
        if (existing.client_digest !== clientDigest)
          throw failure('This task identifier already belongs to a different request.', 409);
        return existing;
      }
      if (!connection)
        throw failure('Connect Desktop Commander and select its account first.', 409);
      if ((await selected(client))?.binding !== connection.binding)
        throw failure('The computer connection changed. Select it again.', 409);
      const bot = (
        await client.query<BotRow>(
          'SELECT * FROM fleet_bots WHERE owner_id=$1 AND id=$2 FOR UPDATE',
          [owner, botId],
        )
      ).rows[0];
      if (!bot) throw failure('Bot not found.', 404);
      if (bot.revision !== input.revision)
        throw failure('The bot assignment changed. Review its computer before sending.', 409);
      if (!bot.identity || !bot.device_id)
        throw failure('Choose and verify this bot’s computer before sending a task.', 409);
      if (bot.delivery === 'crosswalk' && !bot.handoff)
        throw failure(
          'Configure this bot’s Crosswalk route before sending a task. No native agent was substituted.',
          409,
        );
      if (!bot.handoff && !(nativeEngines as readonly string[]).includes(bot.engine))
        throw failure('This agent needs a supported native adapter before it can run tasks.', 409);
      if (!bot.handoff && !bot.identity.engines.includes(bot.engine as NativeEngine))
        throw failure('This agent is not installed on the assigned computer.', 409);
      const busy = await client.query(
        "SELECT id FROM fleet_jobs WHERE owner_id=$1 AND spec->>'deviceId'=$2 AND status=ANY($3::text[]) LIMIT 1",
        [owner, bot.device_id, active],
      );
      if (busy.rowCount)
        throw failure(
          'This computer has an active or unresolved task. Check its receipt first.',
          409,
        );
      const spec: FleetSpec = {
        id: input.id,
        deviceId: bot.device_id,
        identityId: bot.identity.id,
        hostname: bot.identity.hostname,
        engine: bot.engine,
        profile: bot.profile,
        instruction: input.instruction,
      };
      if (bot.handoff) {
        const relay = (await options.connections()).find(
          (candidate) =>
            candidate.kind === 'crosswalk' && candidate.connectionId === bot.handoff!.connectionId,
        );
        if (!relay || !options.provider.directory)
          throw failure('The saved Crosswalk connection is unavailable. No task was queued.', 409);
        spec.handoff = { ...bot.handoff, connection: relay };
        if (input.instruction.length > 16000)
          throw failure('Shorten the Crosswalk task to 16,000 characters before sending.', 400);
      }
      const result = await client.query<JobRow>(
        "INSERT INTO fleet_jobs(id,owner_id,bot_id,bot_name,computer_name,spec,connection,client_digest,digest,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'starting') RETURNING *",
        [
          input.id,
          owner,
          botId,
          bot.name,
          bot.computer_name,
          JSON.stringify(spec),
          JSON.stringify(connection),
          clientDigest,
          specHash(spec),
        ],
      );
      created = true;
      return result.rows[0]!;
    }, pool);
    if (created) dispatch(row);
    options.refresh();
    return jobView(row);
  }

  async function check(id: string) {
    const inflight = checking.get(id);
    if (inflight) return inflight;
    const work = (async () => {
      const row = await job(id);
      if (!active.includes(row.status) || (row.status === 'starting' && controllers.has(id)))
        return jobView(row);
      try {
        const receipt = await options.provider.receipt(row.connection, run(row));
        if (!receipt && row.status === 'uncertain')
          throw failure(
            'The computer has no final receipt for this request. Its outcome remains unresolved.',
            409,
          );
        return await accept(row, receipt);
      } catch (cause) {
        await pool.query(
          "UPDATE fleet_jobs SET status='uncertain',error=$3,updated_at=now() WHERE owner_id=$1 AND id=$2 AND status=ANY($4::text[])",
          [owner, id, cause instanceof Error ? cause.message : String(cause), active],
        );
        options.refresh();
        return jobView(await job(id));
      }
    })();
    checking.set(id, work);
    try {
      return await work;
    } finally {
      checking.delete(id);
    }
  }

  async function stop(id: string) {
    let row = await job(id);
    if (!active.includes(row.status)) return jobView(row);
    await pool.query(
      "UPDATE fleet_jobs SET status='stopping',stop_requested=true,updated_at=now() WHERE owner_id=$1 AND id=$2 AND status=ANY($3::text[])",
      [owner, id, active],
    );
    controllers.get(id)?.abort();
    row = await job(id);
    if (!row.pid && controllers.has(id)) return jobView(row);
    try {
      return await accept(row, await options.provider.stop(row.connection, run(row)));
    } catch (cause) {
      await pool.query(
        "UPDATE fleet_jobs SET status='uncertain',error=$3,updated_at=now() WHERE owner_id=$1 AND id=$2 AND status=ANY($4::text[])",
        [owner, id, cause instanceof Error ? cause.message : String(cause), active],
      );
      return jobView(await job(id));
    }
  }

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/fleet', view);
    app.get<{ Params: { id: string } }>(
      '/api/fleet/handoffs/:id',
      async (request): Promise<FleetDirectory> => {
        const id = z.uuid().parse(request.params.id);
        const connection = (await options.connections()).find(
          (candidate) => candidate.kind === 'crosswalk' && candidate.connectionId === id,
        );
        if (!connection || !options.provider.directory)
          throw failure('The Crosswalk connection is unavailable.', 404);
        return options.provider.directory(connection);
      },
    );
    app.get<{ Params: { id: string } }>('/api/fleet/jobs/:id', async (request) =>
      jobView(await job(z.uuid().parse(request.params.id))),
    );
    app.put('/api/fleet/connection', async (request) => {
      const input = z.object({ connectionId: z.uuid() }).strict().parse(request.body);
      if (
        !(await options.connections()).some(
          (item) => item.kind !== 'crosswalk' && item.connectionId === input.connectionId,
        )
      )
        throw failure('Choose a connected Desktop Commander account.', 409);
      await transaction(async (client) => {
        await client.query('SELECT owner_id FROM fleet_settings WHERE owner_id=$1 FOR UPDATE', [
          owner,
        ]);
        const busy = await client.query(
          'SELECT id FROM fleet_jobs WHERE owner_id=$1 AND status=ANY($2::text[]) LIMIT 1',
          [owner, active],
        );
        if (busy.rowCount)
          throw failure(
            'Finish or review the active native tasks before changing this connection.',
            409,
          );
        await client.query('UPDATE fleet_settings SET connection_id=$2 WHERE owner_id=$1', [
          owner,
          input.connectionId,
        ]);
      }, pool);
      options.refresh();
      return view();
    });
    app.put<{ Params: { id: string } }>('/api/fleet/bots/:id', (request) =>
      saveBot(z.uuid().parse(request.params.id), request.body),
    );
    app.post<{ Params: { id: string } }>('/api/fleet/bots/:id/jobs', (request) =>
      submit(z.uuid().parse(request.params.id), request.body),
    );
    app.post<{ Params: { id: string } }>('/api/fleet/jobs/:id/check', (request) =>
      check(z.uuid().parse(request.params.id)),
    );
    app.post<{ Params: { id: string } }>('/api/fleet/jobs/:id/stop', (request) =>
      stop(z.uuid().parse(request.params.id)),
    );
  }

  return {
    registerRoutes,
    view,
    saveBot,
    submit,
    check,
    stop,
    async stopAll() {
      const rows = await pool.query<{ id: string }>(
        "UPDATE fleet_jobs SET status='stopping',stop_requested=true,updated_at=now() WHERE owner_id=$1 AND status=ANY($2::text[]) RETURNING id",
        [owner, active],
      );
      for (const row of rows.rows) controllers.get(row.id)?.abort();
      const work = Promise.allSettled(rows.rows.map((row) => stop(row.id))).then(() => {});
      pending.add(work);
      void work.finally(() => pending.delete(work)).catch(() => {});
      options.refresh();
    },
    async close() {
      closed = true;
      for (const controller of controllers.values()) controller.abort();
      await Promise.allSettled(pending);
    },
  };
}
