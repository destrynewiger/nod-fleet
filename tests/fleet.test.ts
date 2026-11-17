import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import type { FleetConnection } from '../src/ports/fleet.ts';
import {
  createDesktopCommanderFleet,
  parseFleetDevices,
} from '../src/providers/native-agent/desktop-commander.ts';
import { createFleet } from '../src/server/fleet.ts';
import { createCrosswalkFleet } from '../src/providers/crosswalk/fleet.ts';
import type { FleetBot, FleetJob, FleetView } from '../src/shared/fleet.ts';
import type { FleetSpec } from '../src/ports/fleet.ts';
import { fleetResult } from '../src/web/lib/fleet-result.ts';

test('Hermes receipts show the final protocol reply and retain non-protocol output', () => {
  const reply = 'The requested result.\nA second line.';
  const output = [
    'A synthetic startup warning.',
    JSON.stringify({ type: 'text', text: 'A partial reply.' }),
    JSON.stringify({ type: 'result', text: reply, exit_code: 0 }),
    'session_id: synthetic-session',
  ].join('\r\n');
  assert.equal(fleetResult('hermes', output), reply);
  const failure = JSON.stringify({
    type: 'result',
    text: 'Sign in to the selected provider.',
    exit_code: 1,
  });
  assert.equal(fleetResult('hermes', failure), 'Sign in to the selected provider.');
  assert.equal(fleetResult('hermes', 'Unstructured engine output.'), 'Unstructured engine output.');
  assert.equal(fleetResult('hermes', '{"type":"result","text":42}'), '{"type":"result","text":42}');
  assert.equal(fleetResult('claude', output), output);
});

const content = (text: string) => ({ content: [{ type: 'text', text }] });
const specHash = (spec: FleetSpec) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        spec.id,
        spec.deviceId,
        spec.identityId,
        spec.hostname,
        spec.engine,
        spec.profile,
        spec.instruction,
      ]),
    )
    .digest('hex');
const deviceId = '10000000-0000-4000-8000-000000000001';
const connection: FleetConnection = {
  connectionId: '20000000-0000-4000-8000-000000000001',
  pathId: '30000000-0000-4000-8000-000000000001',
  name: 'Example computer account',
  binding: 'example-binding',
};
async function eventually<T>(read: () => Promise<T | undefined>, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error('The expected native state did not arrive.');
}

async function desktopFixture() {
  const root = await mkdtemp(join(tmpdir(), 'nod-fleet-contract-'));
  const home = join(root, 'home');
  const bin = join(home, '.local', 'bin');
  const workerRoot = join(root, 'worker');
  const counter = join(root, 'executions.jsonl');
  await mkdir(bin, { recursive: true });
  const program = [
    '#!' + process.execPath,
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    'if (args.some(arg => ["--yolo", "--disable-approval", "--disable-sandbox", "--dangerously-skip-permissions", "--accept-hooks"].includes(arg))) process.exit(90);',
    'const index = args.indexOf("--prompt-file");',
    'const text = fs.readFileSync(args[index + 1], "utf8");',
    'fs.appendFileSync(process.env.FLEET_COUNTER, JSON.stringify({ pid: process.pid, text, args }) + "\\n");',
    'if (text === "hold" || text === "hold-ignore") { if (text === "hold-ignore") process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }',
    'else if (text === "secret") console.log(process.env.EXAMPLE_API_KEY);',
    'else { console.log(JSON.stringify({ type: "result", text })); if (text === "fail") process.exitCode = 7; }',
  ].join('\n');
  const binary = join(bin, 'muse');
  await writeFile(binary, program, { mode: 0o700 });
  await chmod(binary, 0o700);
  type Session = {
    child: ChildProcessWithoutNullStreams;
    output: string;
    code: number | null | undefined;
  };
  const sessions = new Map<number, Session>();
  let currentBinding = connection.binding;
  let online = true;
  async function output(session: Session, wait = true) {
    if (wait && !session.output && session.code === undefined)
      await eventually(
        async () => (session.output || session.code !== undefined ? true : undefined),
        1000,
      ).catch(() => {});
    const text = session.output;
    session.output = '';
    return (
      text +
      '\n' +
      (session.code === undefined
        ? 'Process is running.'
        : 'Process completed with exit code ' + session.code)
    );
  }
  const provider = createDesktopCommanderFleet(async (selected, tool, input) => {
    if (selected.binding !== currentBinding) throw new Error('The saved connection changed.');
    if (tool === 'list_devices')
      return content(
        'Desktop Commander devices\n\n1. Example Computer\n   Status: ' +
          (online ? 'Online' : 'Offline') +
          '\n   ID: ' +
          deviceId,
      );
    assert.equal(input.deviceId, deviceId);
    if (tool === 'start_process') {
      const code = String(input.command).match(/data:text\/javascript;base64,([a-z0-9+/=]+)/i)?.[1];
      assert.ok(code, 'The launcher contains only the fixed worker source.');
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', 'import("data:text/javascript;base64,' + code + '")'],
        {
          cwd: root,
          env: {
            PATH: bin + ':' + dirname(process.execPath) + ':/usr/bin:/bin',
            HOME: home,
            USERPROFILE: home,
            LOCALAPPDATA: join(root, 'local-app-data'),
            NOD_FLEET_WORKER_ROOT: workerRoot,
            FLEET_COUNTER: counter,
            EXAMPLE_API_KEY: 'synthetic-private-value-12345',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      const session: Session = { child, output: '', code: undefined };
      sessions.set(child.pid!, session);
      child.stdout.on('data', (chunk) => {
        session.output += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        session.output += chunk.toString();
      });
      child.on('exit', (code) => {
        session.code = code;
      });
      await eventually(async () => (session.output.includes('NOD_FLEET:') ? true : undefined));
      return content(
        'Process started with PID ' +
          child.pid +
          '\nInitial output:\n' +
          (await output(session, false)),
      );
    }
    const session = sessions.get(Number(input.pid));
    if (!session) throw new Error('Process is no longer in the process inventory.');
    if (tool === 'interact_with_process') {
      session.child.stdin.write(String(input.input));
      return content(await output(session));
    }
    if (tool === 'read_process_output') return content(await output(session));
    throw new Error('The fixture does not support ' + tool);
  });
  return {
    provider,
    workerRoot,
    count: async () =>
      (await readFile(counter, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length,
    setOnline: (value: boolean) => {
      online = value;
    },
    setBinding: (value: string) => {
      currentBinding = value;
    },
    async close() {
      const activeFile = await readFile(join(workerRoot, 'active'), 'utf8').catch(() => '');
      if (activeFile) {
        await writeFile(join(workerRoot, activeFile + '.stop'), '');
        await eventually(async () => {
          const row = JSON.parse(await readFile(join(workerRoot, activeFile + '.json'), 'utf8'));
          return row.status !== 'running' ? true : undefined;
        }).catch(() => {});
      }
      for (const session of sessions.values())
        if (session.code === undefined) session.child.kill('SIGTERM');
      await Promise.allSettled(
        [...sessions.values()].map(async (session) => {
          await eventually(async () => (session.code !== undefined ? true : undefined));
        }),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('fleet device discovery rejects ambiguous identifiers and unreadable inventories', () => {
  assert.deepEqual(
    parseFleetDevices(content('1. Example Computer\n Status: Online\n ID: ' + deviceId)),
    [{ id: deviceId, name: 'Example Computer', online: true }],
  );
  assert.throws(
    () => parseFleetDevices(content('The inventory is unavailable.')),
    /readable device inventory/,
  );
  assert.throws(
    () =>
      parseFleetDevices(
        content(
          '1. First\n Status: Online\n ID: ' +
            deviceId +
            '\n2. Second\n Status: Offline\n ID: ' +
            deviceId,
        ),
      ),
    /duplicate device/,
  );
});

test(
  'native worker binds requests to its computer and never executes an identifier twice',
  { skip: process.platform === 'win32' },
  async (t) => {
    const fixture = await desktopFixture();
    t.after(() => fixture.close());
    const identity = await fixture.provider.probe(connection, deviceId);
    assert.ok(identity.engines.includes('muse'));
    const spec = {
      id: randomUUID(),
      deviceId,
      identityId: identity.id,
      hostname: identity.hostname,
      engine: 'muse' as const,
      profile: null,
      instruction: 'literal $(not-a-command) "quoted text"',
    };
    const digest = specHash(spec);
    let pid = 0;
    let result = await fixture.provider.start(connection, spec, digest, async (value) => {
      pid = value ?? 0;
    });
    result ??= await eventually(async () => {
      const found = await fixture.provider.receipt(connection, { ...spec, digest, pid });
      return found && found.status !== 'running' ? found : undefined;
    });
    assert.equal(result.status, 'finished');
    assert.match(result.output!, /not-a-command/);
    assert.equal(await fixture.count(), 1);
    const again = await fixture.provider.start(connection, spec, digest, async () => {});
    assert.equal(again?.status, 'finished');
    assert.equal(await fixture.count(), 1);
    await assert.rejects(
      fixture.provider.start(
        connection,
        { ...spec, identityId: randomUUID() },
        digest,
        async () => {},
      ),
      /computer identity changed/,
    );
    assert.equal(await fixture.count(), 1);
  },
);

test(
  'native worker preserves approval defaults, redacts host keys and stops only its active child',
  { skip: process.platform === 'win32' },
  async (t) => {
    const fixture = await desktopFixture();
    t.after(() => fixture.close());
    const identity = await fixture.provider.probe(connection, deviceId);
    async function start(instruction: string) {
      const spec = {
        id: randomUUID(),
        deviceId,
        identityId: identity.id,
        hostname: identity.hostname,
        engine: 'muse' as const,
        profile: null,
        instruction,
      };
      const digest = specHash(spec);
      let pid = 0;
      const first = await fixture.provider.start(connection, spec, digest, async (value) => {
        pid = value ?? 0;
      });
      return { run: { ...spec, digest, pid }, first };
    }
    const secret = await start('secret');
    const redacted =
      secret.first ??
      (await eventually(async () => {
        const result = await fixture.provider.receipt(connection, secret.run);
        return result && result.status !== 'running' ? result : undefined;
      }));
    assert.equal(redacted.status, 'finished');
    assert.match(redacted.output!, /\[redacted\]/);
    assert.doesNotMatch(JSON.stringify(redacted), /synthetic-private-value/);
    const held = await start('hold-ignore');
    await eventually(async () => ((await fixture.count()) === 2 ? true : undefined));
    await fixture.provider.stop(connection, held.run);
    const stopped = await eventually(async () => {
      const result = await fixture.provider.receipt(connection, held.run);
      return result?.status === 'stopped' ? result : undefined;
    });
    assert.match(stopped.error!, /owner stopped/);
    assert.equal(await fixture.count(), 2);
  },
);

test(
  'fleet API preserves owner isolation, assignment revisions, receipts and unresolved dispatch fences',
  { skip: !process.env.TEST_DATABASE_URL || process.platform === 'win32' },
  async (t) => {
    const fixture = await desktopFixture();
    const schema = 'fleet_' + randomUUID().replaceAll('-', '');
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: '-c search_path=' + schema,
    });
    const applications: Array<{
      app: ReturnType<typeof Fastify>;
      fleet: Awaited<ReturnType<typeof createFleet>>;
    }> = [];
    t.after(async () => {
      for (const item of applications) {
        await item.fleet.stopAll();
        await item.fleet.close();
        await item.app.close();
      }
      await fixture.close();
      await pool.end();
      await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
      await admin.end();
    });
    async function application(ownerId: string) {
      const fleet = await createFleet(pool, {
        ownerId,
        provider: fixture.provider,
        connections: async () => [connection],
        refresh() {},
      });
      const app = Fastify();
      fleet.registerRoutes(app);
      applications.push({ app, fleet });
      await app.inject({
        method: 'PUT',
        url: '/api/fleet/connection',
        payload: { connectionId: connection.connectionId },
      });
      return { app, fleet };
    }
    const a = await application('example-owner-a');
    const b = await application('example-owner-b');
    const id = randomUUID();
    const assignment = {
      name: 'Example bot',
      engine: 'muse',
      profile: null,
      deviceId,
      revision: 0,
    };
    const saved = await a.app.inject({
      method: 'PUT',
      url: '/api/fleet/bots/' + id,
      payload: assignment,
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const bot = saved.json<FleetBot>();
    assert.equal(bot.revision, 1);
    assert.equal((await b.fleet.view()).bots.length, 0);
    const stale = await a.app.inject({
      method: 'PUT',
      url: '/api/fleet/bots/' + id,
      payload: assignment,
    });
    assert.equal(stale.statusCode, 409);
    fixture.setOnline(false);
    const offline = await a.app.inject({
      method: 'PUT',
      url: '/api/fleet/bots/' + id,
      payload: { ...assignment, revision: 1 },
    });
    assert.equal(offline.statusCode, 409);
    fixture.setOnline(true);
    const input = { id: randomUUID(), revision: 1, instruction: 'first request' };
    const first = await a.app.inject({
      method: 'POST',
      url: '/api/fleet/bots/' + id + '/jobs',
      payload: input,
    });
    assert.equal(first.statusCode, 200, first.body);
    const repeated = await a.app.inject({
      method: 'POST',
      url: '/api/fleet/bots/' + id + '/jobs',
      payload: input,
    });
    assert.equal(repeated.json<FleetJob>().id, input.id);
    const changed = await a.app.inject({
      method: 'POST',
      url: '/api/fleet/bots/' + id + '/jobs',
      payload: { ...input, instruction: 'changed request' },
    });
    assert.equal(changed.statusCode, 409);
    const foreign = await b.app.inject({ method: 'GET', url: '/api/fleet/jobs/' + input.id });
    assert.equal(foreign.statusCode, 404);
    const finished = await eventually(async () => {
      const result = await a.fleet.check(input.id);
      return result.status === 'finished' ? result : undefined;
    });
    assert.equal(finished.computerName, 'Example Computer');
    assert.equal(await fixture.count(), 1);
    const held = { id: randomUUID(), revision: 1, instruction: 'hold' };
    await a.app.inject({ method: 'POST', url: '/api/fleet/bots/' + id + '/jobs', payload: held });
    await eventually(async () => ((await fixture.count()) === 2 ? true : undefined));
    const busy = await a.app.inject({
      method: 'POST',
      url: '/api/fleet/bots/' + id + '/jobs',
      payload: { ...held, id: randomUUID() },
    });
    assert.equal(busy.statusCode, 409);
    const reassigned = await a.app.inject({
      method: 'PUT',
      url: '/api/fleet/bots/' + id,
      payload: { ...assignment, revision: 1 },
    });
    assert.equal(reassigned.statusCode, 409);
    fixture.setBinding('changed-binding');
    assert.equal((await a.fleet.check(held.id)).status, 'uncertain');
    const retry = await a.app.inject({
      method: 'POST',
      url: '/api/fleet/bots/' + id + '/jobs',
      payload: { ...held, id: randomUUID() },
    });
    assert.equal(retry.statusCode, 409);
    assert.equal(await fixture.count(), 2);
    fixture.setBinding(connection.binding);
    assert.equal((await a.fleet.check(held.id)).status, 'running');
    await a.fleet.stop(held.id);
    await eventually(async () =>
      (await a.fleet.check(held.id)).status === 'stopped' ? true : undefined,
    );
    const view = (await a.app.inject('/api/fleet')).json<FleetView>();
    assert.equal(view.jobs.length, 2);
    assert.equal((await b.fleet.view()).jobs.length, 0);
    const unsupportedId = randomUUID();
    const unsupported = await a.fleet.saveBot(unsupportedId, {
      ...assignment,
      name: 'Cloud agent',
      engine: 'muse-web',
    });
    await assert.rejects(
      a.fleet.submit(unsupportedId, {
        id: randomUUID(),
        revision: unsupported.revision,
        instruction: 'No implicit CLI substitution',
      }),
      /Crosswalk route/,
    );
    const missingId = randomUUID();
    const missing = await a.fleet.saveBot(missingId, {
      ...assignment,
      name: 'Unverified bot',
      deviceId: null,
      computerName: 'Expected computer',
    });
    await assert.rejects(
      a.fleet.submit(missingId, {
        id: randomUUID(),
        revision: missing.revision,
        instruction: 'No substitute computer',
      }),
      /verify this bot/,
    );
    assert.equal(await fixture.count(), 2);
    const failedId = randomUUID();
    await a.fleet.submit(id, { id: failedId, revision: 1, instruction: 'fail' });
    const failed = await eventually(async () => {
      const result = await a.fleet.check(failedId);
      return result.status === 'failed' ? result : undefined;
    });
    assert.equal(failed.receipt?.exitCode, 7);
    assert.equal(await fixture.count(), 3);
    const recoveredId = randomUUID();
    await a.fleet.submit(id, { id: recoveredId, revision: 1, instruction: 'hold' });
    await eventually(async () => ((await fixture.count()) === 4 ? true : undefined));
    await a.fleet.close();
    const restarted = await application('example-owner-a');
    const restored = await restarted.app.inject('/api/fleet/jobs/' + recoveredId);
    assert.equal(restored.json<FleetJob>().status, 'uncertain');
    assert.equal((await restarted.fleet.check(recoveredId)).status, 'running');
    assert.equal(await fixture.count(), 4);
    await restarted.fleet.stopAll();
    await eventually(async () =>
      (await restarted.fleet.check(recoveredId)).status === 'stopped' ? true : undefined,
    );
    assert.equal(await fixture.count(), 4);
  },
);

test(
  'Crosswalk handoffs bind private recipients, reconcile a lost reply without resending, and preserve remote stop semantics',
  { skip: !process.env.TEST_DATABASE_URL || process.platform === 'win32' },
  async (t) => {
    const desktop = await desktopFixture();
    const schema = 'fleet_relay_' + randomUUID().replaceAll('-', '');
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: '-c search_path=' + schema,
    });
    await pool.query(
      'CREATE TABLE fixture_crosswalk_tasks(id text PRIMARY KEY,data jsonb NOT NULL)',
    );
    const relayConnection: FleetConnection = {
      kind: 'crosswalk',
      connectionId: '40000000-0000-4000-8000-000000000001',
      pathId: '50000000-0000-4000-8000-000000000001',
      name: 'Example handoff account',
      binding: 'fixture-relay-binding',
    };
    const recipient = '1111000011110001';
    let username = 'example-owner';
    let loseReply = false;
    let aliasCollision = false;
    const remote = Fastify();
    remote.post<{ Body: { tool: string; input: Record<string, unknown> } }>(
      '/mcp-call',
      async (request, reply) => {
        const { tool, input } = request.body;
        const response = (data: unknown) => content(JSON.stringify(data));
        assert.ok(tool === 'account' || tool === 'tasks');
        if (tool === 'account' && input.action === 'whoami')
          return response({
            username,
            crosswalks: [
              { slug: 'example-private', visibility: 'private', own: true },
              { slug: 'example-public', visibility: 'public', own: true },
              { slug: 'someone-else', visibility: 'private' },
            ],
          });
        if (tool === 'account' && input.action === 'numbers')
          return response({
            you: '1111000000000000',
            numbers: [
              { agent: 'Example sender', number: '1111000000000000' },
              { agent: 'Example agent', number: recipient },
              ...(aliasCollision
                ? [
                    {
                      agent: 'Other agent',
                      number: '1111000011110002',
                      also_answers_as: ['Example agent'],
                    },
                  ]
                : []),
            ],
          });
        assert.equal(tool, 'tasks');
        if (input.action === 'add') {
          assert.equal(input.crosswalk, 'example-private');
          assert.equal(input.for, recipient);
          assert.equal(input.invite, false);
          const id = randomUUID();
          const task = {
            id,
            title: input.title,
            details: input.details,
            for: input.for,
            crosswalk: input.crosswalk,
            status: 'open',
            created_at: new Date().toISOString(),
          };
          await pool.query('INSERT INTO fixture_crosswalk_tasks(id,data) VALUES($1,$2)', [
            id,
            JSON.stringify(task),
          ]);
          if (loseReply) {
            loseReply = false;
            return reply
              .code(503)
              .send({ error: 'Synthetic reply lost after committing the remote task.' });
          }
          return response({ kind: 'task_added', task });
        }
        if (input.action === 'list') {
          assert.equal(input.crosswalk, 'example-private');
          const tasks = (
            await pool.query<{ data: Record<string, unknown> }>(
              'SELECT data FROM fixture_crosswalk_tasks ORDER BY id',
            )
          ).rows.map((row) => row.data);
          return response({
            for_you: [],
            open: tasks.filter((task) => task.status === 'open'),
            done: tasks.filter((task) => task.status === 'done'),
          });
        }
        const task = (
          await pool.query<{ data: Record<string, unknown> }>(
            'SELECT data FROM fixture_crosswalk_tasks WHERE id=$1',
            [input.id],
          )
        ).rows[0]?.data;
        assert.ok(task);
        if (input.action === 'get') return response({ kind: 'task', task });
        assert.equal(input.action, 'update');
        assert.deepEqual(Object.keys(input).sort(), ['action', 'id', 'title']);
        const updated = { ...task, title: input.title };
        await pool.query('UPDATE fixture_crosswalk_tasks SET data=$2 WHERE id=$1', [
          input.id,
          JSON.stringify(updated),
        ]);
        return response({ kind: 'task_updated', task: updated });
      },
    );
    await remote.listen({ host: '127.0.0.1', port: 0 });
    const address = remote.server.address();
    assert.ok(address && typeof address === 'object');
    const provider = createCrosswalkFleet(
      desktop.provider,
      async (selected, tool, input, signal) => {
        assert.equal(selected.connectionId, relayConnection.connectionId);
        assert.equal(selected.binding, relayConnection.binding);
        const response = await fetch('http://127.0.0.1:' + address.port + '/mcp-call', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tool, input }),
          signal,
        });
        if (!response.ok) throw new Error('Synthetic Crosswalk HTTP ' + response.status);
        return response.json();
      },
    );
    const applications: Array<{
      app: ReturnType<typeof Fastify>;
      fleet: Awaited<ReturnType<typeof createFleet>>;
    }> = [];
    t.after(async () => {
      for (const item of applications) {
        await item.fleet.stopAll();
        await item.fleet.close();
        await item.app.close();
      }
      await remote.close();
      await desktop.close();
      await pool.end();
      await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
      await admin.end();
    });
    async function application(ownerId: string) {
      const fleet = await createFleet(pool, {
        ownerId,
        provider,
        connections: async () => [connection, relayConnection],
        refresh() {},
      });
      const app = Fastify();
      fleet.registerRoutes(app);
      applications.push({ app, fleet });
      await app.inject({
        method: 'PUT',
        url: '/api/fleet/connection',
        payload: { connectionId: connection.connectionId },
      });
      return { app, fleet };
    }
    let sut = await application('relay-owner-a');
    const directory = await provider.directory!(relayConnection);
    assert.deepEqual(
      directory.recipients.map((agent) => agent.id),
      [recipient],
    );
    assert.deepEqual(directory.spaces, ['example-private']);
    const id = randomUUID();
    const assignment = {
      name: 'Example app agent',
      engine: 'muse-web',
      delivery: 'crosswalk',
      profile: null,
      deviceId,
      revision: 0,
      handoff: { connectionId: relayConnection.connectionId, recipient, space: 'example-private' },
    };
    const saved = await sut.fleet.saveBot(id, assignment);
    assert.equal(saved.handoff?.username, 'example-owner');
    const count = async () =>
      (
        await pool.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM fixture_crosswalk_tasks',
        )
      ).rows[0]!.count;
    const input = {
      id: randomUUID(),
      revision: 1,
      instruction: 'Return a synthetic readiness result. Do not use any real service.',
    };
    loseReply = true;
    await sut.fleet.submit(id, input);
    await eventually(async () =>
      (await sut.app.inject('/api/fleet/jobs/' + input.id)).json<FleetJob>().status === 'uncertain'
        ? true
        : undefined,
    );
    assert.equal(await count(), 1);
    await sut.fleet.close();
    sut = await application('relay-owner-a');
    const replay = await sut.fleet.submit(id, input);
    assert.equal(replay.status, 'uncertain');
    assert.equal(await count(), 1);
    await assert.rejects(
      sut.fleet.submit(id, { ...input, instruction: 'A different request' }),
      /different request/,
    );
    const queued = await sut.fleet.check(input.id);
    assert.equal(queued.status, 'queued');
    assert.equal(queued.delivery, 'crosswalk');
    assert.equal(queued.recipient, 'Example agent');
    assert.equal(await count(), 1);
    const remoteId = queued.receipt!.remoteId!;
    const changeTask = async (change: Record<string, unknown>) =>
      pool.query('UPDATE fixture_crosswalk_tasks SET data=data || $2::jsonb WHERE id=$1', [
        remoteId,
        JSON.stringify(change),
      ]);
    await changeTask({ for: 'Unrelated agent' });
    assert.equal((await sut.fleet.check(input.id)).status, 'uncertain');
    await changeTask({ for: recipient, claimed_by: 'Example agent' });
    assert.equal((await sut.fleet.check(input.id)).status, 'claimed');
    await assert.rejects(sut.fleet.saveBot(id, { ...assignment, revision: 1 }), /current task/);
    await changeTask({
      status: 'done',
      done_at: new Date().toISOString(),
      done_note: 'Synthetic readiness result only.',
    });
    const reported = await sut.fleet.check(input.id);
    assert.equal(reported.status, 'reported');
    assert.equal(reported.receipt?.output, 'Synthetic readiness result only.');
    assert.equal(await desktop.count(), 0);
    const pendingId = randomUUID();
    await sut.fleet.saveBot(pendingId, {
      ...assignment,
      name: 'Pending Hermes relay',
      engine: 'hermes',
      handoff: null,
    });
    await assert.rejects(
      sut.fleet.submit(pendingId, { ...input, id: randomUUID() }),
      /Crosswalk route/,
    );
    await assert.rejects(
      sut.fleet.saveBot(randomUUID(), {
        ...assignment,
        name: 'Public room',
        handoff: { ...assignment.handoff, space: 'example-public' },
      }),
      /owned private/,
    );
    const foreign = await application('relay-owner-b');
    assert.equal((await foreign.app.inject('/api/fleet/jobs/' + input.id)).statusCode, 404);
    username = 'changed-account';
    const refused = { ...input, id: randomUUID() };
    await sut.fleet.submit(id, refused);
    await eventually(async () =>
      (await sut.app.inject('/api/fleet/jobs/' + refused.id)).json<FleetJob>().status === 'failed'
        ? true
        : undefined,
    );
    assert.equal(await count(), 1);
    username = 'example-owner';
    aliasCollision = true;
    const ambiguous = { ...input, id: randomUUID() };
    await sut.fleet.submit(id, ambiguous);
    await eventually(async () =>
      (await sut.app.inject('/api/fleet/jobs/' + ambiguous.id)).json<FleetJob>().status === 'failed'
        ? true
        : undefined,
    );
    assert.equal(await count(), 1);
    aliasCollision = false;
    const stoppedInput = { ...input, id: randomUUID() };
    await sut.fleet.submit(id, stoppedInput);
    const stoppable = await eventually(async () => {
      const job = (await sut.app.inject('/api/fleet/jobs/' + stoppedInput.id)).json<FleetJob>();
      return job.status === 'queued' ? job : undefined;
    });
    await sut.fleet.stopAll();
    await eventually(async () => {
      const record = (
        await pool.query<{ data: { title: string } }>(
          'SELECT data FROM fixture_crosswalk_tasks WHERE id=$1',
          [stoppable.receipt!.remoteId],
        )
      ).rows[0]!.data;
      return record.title.endsWith('stop requested') ? true : undefined;
    });
    assert.equal((await sut.fleet.check(stoppedInput.id)).status, 'stopping');
    await pool.query('UPDATE fixture_crosswalk_tasks SET data=data || $2::jsonb WHERE id=$1', [
      stoppable.receipt!.remoteId,
      JSON.stringify({
        status: 'done',
        done_at: new Date().toISOString(),
        done_note: 'Stopped before any action.',
      }),
    ]);
    assert.equal((await sut.fleet.check(stoppedInput.id)).status, 'reported');
    assert.equal(await count(), 2);
    assert.equal(await desktop.count(), 0);
  },
);
