import { z } from 'zod';
import {
  FleetDispatchError,
  type FleetConnection,
  type FleetProvider,
  type FleetReceipt,
  type FleetRun,
  type FleetSpec,
} from '../../ports/fleet.ts';
import type { FleetDirectory } from '../../shared/fleet.ts';

type Call = (
  connection: FleetConnection,
  tool: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;
const taskSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string(),
  details: z.string(),
  status: z.enum(['open', 'done']),
  for: z.string(),
  crosswalk: z.string(),
  created_at: z.string(),
  done_at: z.string().optional(),
  done_note: z.string().nullable().optional(),
  claimed_by: z.string().nullable().optional(),
});
type RemoteTask = z.infer<typeof taskSchema>;
const title = (spec: Pick<FleetSpec, 'id' | 'instruction'>) =>
  spec.instruction.split(/\r?\n/)[0]!.trim().slice(0, 120) + ' [Nod ' + spec.id + ']';
const stopTitle = (spec: Pick<FleetSpec, 'id' | 'instruction'>) =>
  title(spec) + ' · stop requested';

function result(value: unknown): Record<string, unknown> {
  const envelope = z
    .object({
      isError: z.boolean().optional(),
      structuredContent: z.unknown().optional(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    })
    .parse(value);
  const text =
    envelope.content
      ?.flatMap((item) => (item.type === 'text' ? [item.text ?? ''] : []))
      .join('\n') ?? '';
  if (envelope.isError) throw new Error('Crosswalk: ' + text.slice(0, 4000));
  if (text.length > 256000)
    throw new Error('Crosswalk returned more task data than this request can safely reconcile.');
  return z.record(z.string(), z.unknown()).parse(envelope.structuredContent ?? JSON.parse(text));
}

function details(spec: FleetSpec, digest: string) {
  return [
    'Nod request: ' + spec.id,
    'Request digest: ' + digest,
    'Agent: ' + spec.engine,
    'Recipient number: ' + spec.handoff!.recipient,
    'Crosswalk account: ' + spec.handoff!.username,
    'Private workspace: ' + spec.handoff!.space,
    'Requested computer: ' + spec.hostname,
    'Computer ID: ' + spec.deviceId,
    '',
    'Task:',
    spec.instruction,
    '',
    'Use only the requested computer for physical computer actions. If that is unavailable, report the limitation and do not substitute another computer.',
    'Keep existing account and approval boundaries. Do not create schedules or expand access.',
    'Return the actual result and its limits in the task completion note. A claimed task is not completed work.',
    'If the task title says stop requested, stop work and report any partial effects.',
  ].join('\n');
}

export function createCrosswalkFleet(native: FleetProvider, call: Call): FleetProvider {
  const directories = new Map<string, { expires: number; value: FleetDirectory }>();
  async function directory(
    connection: FleetConnection,
    signal?: AbortSignal,
    fresh = false,
  ): Promise<FleetDirectory> {
    if (connection.kind !== 'crosswalk')
      throw new FleetDispatchError('Select a connected Crosswalk account.', false);
    const key = JSON.stringify([connection.connectionId, connection.pathId, connection.binding]);
    const cached = directories.get(key);
    if (!fresh && cached && cached.expires > Date.now()) return cached.value;
    const [accountData, numbersData] = await Promise.all([
      call(connection, 'account', { action: 'whoami' }, signal).then(result),
      call(connection, 'account', { action: 'numbers' }, signal).then(result),
    ]);
    const account = z
      .object({
        username: z.string().min(1),
        crosswalks: z.array(
          z.object({
            slug: z.string().min(1),
            visibility: z.string(),
            own: z.boolean().optional(),
          }),
        ),
      })
      .parse(accountData);
    const numbers = z
      .object({
        you: z.string().regex(/^(?:\d{16}|\d{4}(?:-\d{4}){3})$/),
        numbers: z.array(
          z.object({
            agent: z.string().min(1),
            number: z.string().regex(/^(?:\d{16}|\d{4}(?:-\d{4}){3})$/),
            also_answers_as: z.array(z.string()).optional(),
          }),
        ),
      })
      .parse(numbersData);
    const recipients = numbers.numbers
      .map((entry) => ({
        id: entry.number.replaceAll('-', ''),
        name: entry.agent,
        aliases: (entry.also_answers_as ?? []).slice().sort(),
      }))
      .filter((entry) => entry.id !== numbers.you.replaceAll('-', ''));
    if (new Set(recipients.map((entry) => entry.id)).size !== recipients.length)
      throw new FleetDispatchError(
        'Crosswalk returned duplicate agent numbers. No task was sent.',
        false,
      );
    const value = {
      username: account.username,
      recipients,
      spaces: account.crosswalks
        .filter((space) => space.own === true && space.visibility === 'private')
        .map((space) => space.slug),
    };
    if (directories.size > 20) directories.clear();
    directories.set(key, { value, expires: Date.now() + 30000 });
    return value;
  }

  async function verify(spec: FleetSpec, signal?: AbortSignal) {
    const route = spec.handoff;
    if (!route || route.connection.connectionId !== route.connectionId)
      throw new FleetDispatchError(
        'The saved Crosswalk route is invalid. No task was sent.',
        false,
      );
    const current = await directory(route.connection, signal, true);
    const recipient = current.recipients.find((entry) => entry.id === route.recipient);
    if (
      recipient &&
      current.recipients.some(
        (other) =>
          other.id !== recipient.id &&
          [other.name, ...other.aliases].some((name) =>
            [recipient.name, ...recipient.aliases].includes(name),
          ),
      )
    )
      throw new FleetDispatchError(
        'This Crosswalk agent has names shared by another number. Choose a dedicated agent number before sending.',
        false,
      );
    if (
      current.username !== route.username ||
      !current.spaces.includes(route.space) ||
      !recipient ||
      recipient.name !== route.recipientName ||
      JSON.stringify(recipient.aliases) !== JSON.stringify(route.aliases)
    )
      throw new FleetDispatchError(
        'The Crosswalk account, private workspace or agent identity changed. Verify the bot assignment again.',
        false,
      );
    return route;
  }

  function checkedTask(value: unknown, run: FleetRun): RemoteTask {
    const task = taskSchema.parse(value);
    const route = run.handoff!;
    const number = task.for.replaceAll('-', '');
    if (
      task.crosswalk !== route.space ||
      ![title(run), stopTitle(run)].includes(task.title) ||
      task.details !== details(run, run.digest) ||
      !(number === route.recipient || [route.recipientName, ...route.aliases].includes(task.for))
    )
      throw new FleetDispatchError(
        'The Crosswalk task does not match this request, recipient and private workspace.',
        true,
      );
    return task;
  }

  async function readTask(run: FleetRun, signal?: AbortSignal) {
    const connection = run.handoff!.connection;
    if (run.remoteId) {
      const found = result(
        await call(connection, 'tasks', { action: 'get', id: run.remoteId }, signal),
      );
      return checkedTask(found.task ?? found, run);
    }
    const found = result(
      await call(
        connection,
        'tasks',
        { action: 'list', crosswalk: run.handoff!.space, status: 'all' },
        signal,
      ),
    );
    const candidates = ['for_you', 'open', 'done'].flatMap((name) =>
      z.array(z.unknown()).parse(found[name] ?? []),
    );
    const unique = new Map<string, RemoteTask>();
    for (const candidate of candidates) {
      const summary = z.object({ id: z.string(), title: z.string() }).parse(candidate);
      if ([title(run), stopTitle(run)].includes(summary.title))
        unique.set(summary.id, checkedTask(candidate, run));
    }
    if (unique.size !== 1)
      throw new FleetDispatchError(
        unique.size
          ? 'Crosswalk has multiple matching task records. Review them before another request.'
          : 'Crosswalk has no confirmed task for this request. Its delivery remains unresolved; it was not sent again.',
        true,
      );
    return [...unique.values()][0]!;
  }

  function receipt(task: RemoteTask, run: FleetRun): FleetReceipt {
    const unconfirmedStop =
      run.stopRequested && task.status !== 'done' && task.title !== stopTitle(run);
    return {
      id: run.id,
      digest: run.digest,
      identityId: run.identityId,
      hostname: run.hostname,
      engine: run.engine,
      remoteId: task.id,
      startedAt: task.created_at,
      ...(task.done_at ? { finishedAt: task.done_at } : {}),
      status: unconfirmedStop
        ? 'uncertain'
        : task.status === 'done'
          ? 'reported'
          : task.claimed_by
            ? 'claimed'
            : 'queued',
      ...(task.done_note ? { output: task.done_note.slice(0, 32000) } : {}),
      ...(unconfirmedStop
        ? {
            error:
              'The remote stop request is not confirmed. The agent may still work on this task.',
          }
        : {}),
    };
  }

  return {
    ...native,
    directory,
    async start(connection, spec, digest, claimed, signal) {
      if (!spec.handoff) return native.start(connection, spec, digest, claimed, signal);
      const route = await verify(spec, signal);
      if (details(spec, digest).length > 20000)
        throw new FleetDispatchError(
          'The Crosswalk task exceeds its 20,000-character limit. Shorten the task before sending.',
          false,
        );
      const computer = await native.probe(connection, spec.deviceId, signal);
      if (computer.id !== spec.identityId || computer.hostname !== spec.hostname)
        throw new FleetDispatchError(
          'The assigned computer identity changed. No handoff was sent.',
          false,
        );
      await claimed(null);
      if (signal?.aborted)
        throw new FleetDispatchError('The handoff stopped before dispatch.', false);
      try {
        const answer = result(
          await call(
            route.connection,
            'tasks',
            {
              action: 'add',
              crosswalk: route.space,
              for: route.recipient,
              title: title(spec),
              details: details(spec, digest),
              invite: false,
            },
            signal,
          ),
        );
        const data = z.object({ id: z.string().min(1) }).parse(answer.task ?? answer);
        const run = { ...spec, digest, pid: null, remoteId: data.id };
        return receipt(await readTask(run, signal), run);
      } catch (error) {
        throw new FleetDispatchError(error instanceof Error ? error.message : String(error), true);
      }
    },
    async receipt(connection, run, signal) {
      if (!run.handoff) return native.receipt(connection, run, signal);
      await verify(run, signal);
      return receipt(await readTask(run, signal), run);
    },
    async stop(connection, run, signal) {
      if (!run.handoff) return native.stop(connection, run, signal);
      const route = await verify(run, signal);
      const task = await readTask(run, signal);
      if (task.status === 'done' || task.title === stopTitle(run))
        return receipt(task, { ...run, stopRequested: true });
      try {
        await call(
          route.connection,
          'tasks',
          { action: 'update', id: task.id, title: stopTitle(run) },
          signal,
        );
        const stopped = { ...run, remoteId: task.id, stopRequested: true };
        return receipt(await readTask(stopped, signal), stopped);
      } catch (error) {
        throw new FleetDispatchError(error instanceof Error ? error.message : String(error), true);
      }
    },
  };
}
