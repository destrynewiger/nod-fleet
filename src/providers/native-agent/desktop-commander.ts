import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { desktopCommanderEndpoint } from '../../shared/fleet.ts';
import {
  FleetDispatchError,
  type FleetConnection,
  type FleetIdentity,
  type FleetProvider,
  type FleetReceipt,
  type FleetRun,
} from '../../ports/fleet.ts';

export { desktopCommanderEndpoint };

const identitySchema = z.object({
  id: z.uuid(),
  hostname: z.string().min(1).max(255),
  platform: z.enum(['darwin', 'win32', 'linux']),
  engines: z.array(z.enum(['muse', 'hermes', 'claude'])),
});
const receiptSchema = z.object({
  id: z.uuid(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  identityId: z.uuid(),
  hostname: z.string(),
  engine: z.enum(['muse', 'hermes', 'claude']),
  status: z.enum(['running', 'finished', 'failed', 'stopped', 'uncertain']),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  output: z.string().max(32768).optional(),
  error: z.string().optional(),
});
type Call = (
  connection: FleetConnection,
  tool: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

function resultText(result: unknown) {
  const parsed = z
    .object({
      isError: z.boolean().optional(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
    })
    .parse(result);
  const text = parsed.content
    .flatMap((item) => (item.type === 'text' ? [item.text ?? ''] : []))
    .join('\n');
  if (parsed.isError) throw new Error('Desktop Commander: ' + text.slice(0, 4000));
  return text;
}

export function parseFleetDevices(result: unknown) {
  const text = resultText(result);
  const devices = [
    ...text.matchAll(
      /^\d+\.\s+(.+)\r?\n\s+Status:\s+(Online|Offline)\r?\n\s+ID:\s+([0-9a-f-]{36})/gim,
    ),
  ].map((match) => ({
    id: z.uuid().parse(match[3]),
    name: match[1]!.trim(),
    online: match[2]!.toLowerCase() === 'online',
  }));
  if (!devices.length && !/no (?:connected )?devices/i.test(text))
    throw new Error('Desktop Commander did not return a readable device inventory.');
  if (new Set(devices.map((device) => device.id)).size !== devices.length)
    throw new Error('Desktop Commander returned duplicate device identifiers.');
  return devices;
}

function events(text: string): Array<Record<string, unknown>> {
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith('NOD_FLEET:')) return [];
    return [z.record(z.string(), z.unknown()).parse(JSON.parse(line.slice(10)))];
  });
}

function receipt(
  text: string,
  expected: Pick<FleetRun, 'id' | 'digest' | 'identityId' | 'hostname'>,
) {
  const messages = events(text);
  const failure = messages.find((message) => message.type === 'error');
  if (failure) throw new FleetDispatchError(String(failure.error), failure.dispatched !== false);
  const item = messages.findLast((message) => message.type === 'receipt');
  if (!item?.receipt) return null;
  const value = receiptSchema.parse(item.receipt);
  if (
    value.id !== expected.id ||
    value.digest !== expected.digest ||
    value.identityId !== expected.identityId ||
    value.hostname !== expected.hostname
  )
    throw new FleetDispatchError(
      'The native receipt does not match the assigned task and computer.',
      true,
    );
  return value;
}

export function createDesktopCommanderFleet(call: Call): FleetProvider {
  let source: Promise<string> | undefined;
  const workerCommand = async () => {
    source ??= readFile(new URL('./worker.mjs', import.meta.url), 'utf8');
    return (
      'node -e "import(\'data:text/javascript;base64,' +
      Buffer.from(await source).toString('base64') +
      '\')"'
    );
  };

  async function open(connection: FleetConnection, deviceId: string, signal?: AbortSignal) {
    const initial = resultText(
      await call(
        connection,
        'start_process',
        { deviceId, command: await workerCommand(), timeout_ms: 1000 },
        signal,
      ),
    );
    const pid = Number(initial.match(/Process started with PID (\d+)/)?.[1]);
    if (!Number.isSafeInteger(pid) || pid < 1)
      throw new FleetDispatchError(
        'Desktop Commander did not return a native worker process identifier.',
        false,
      );
    let text = initial;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ready = events(text).find((message) => message.type === 'ready');
      if (ready) return { pid, identity: identitySchema.parse(ready.identity) };
      text +=
        '\n' +
        resultText(
          await call(
            connection,
            'read_process_output',
            { deviceId, pid, timeout_ms: 1000, length: 100 },
            signal,
          ),
        );
    }
    throw new FleetDispatchError(
      'The native worker did not return its computer identity. No task was sent.',
      false,
    );
  }

  async function send(
    connection: FleetConnection,
    deviceId: string,
    pid: number,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    return resultText(
      await call(
        connection,
        'interact_with_process',
        {
          deviceId,
          pid,
          input: JSON.stringify(input) + '\n',
          timeout_ms: 1000,
        },
        signal,
      ),
    );
  }

  async function same(
    connection: FleetConnection,
    expected: Pick<FleetRun, 'deviceId' | 'identityId' | 'hostname'>,
    signal?: AbortSignal,
  ) {
    const worker = await open(connection, expected.deviceId, signal);
    if (
      worker.identity.id !== expected.identityId ||
      worker.identity.hostname !== expected.hostname
    ) {
      await send(connection, expected.deviceId, worker.pid, { operation: 'close' }, signal).catch(
        () => {},
      );
      throw new FleetDispatchError(
        'The assigned computer identity changed. Verify the assignment before another task.',
        false,
      );
    }
    return worker;
  }

  async function request(
    connection: FleetConnection,
    run: FleetRun,
    operation: 'receipt' | 'stop',
    signal?: AbortSignal,
  ) {
    const worker = await same(connection, run, signal);
    let text = await send(
      connection,
      run.deviceId,
      worker.pid,
      {
        operation,
        id: run.id,
        digest: run.digest,
        identityId: run.identityId,
        hostname: run.hostname,
      },
      signal,
    );
    if (
      !events(text).some(
        (event) =>
          event.type === 'receipt' || event.type === 'stop_requested' || event.type === 'error',
      )
    )
      text +=
        '\n' +
        resultText(
          await call(
            connection,
            'read_process_output',
            { deviceId: run.deviceId, pid: worker.pid, timeout_ms: 1000, length: 100 },
            signal,
          ),
        );
    return receipt(text, run);
  }

  return {
    devices: async (connection, signal) =>
      parseFleetDevices(await call(connection, 'list_devices', {}, signal)),
    async probe(connection, deviceId, signal): Promise<FleetIdentity> {
      const worker = await open(connection, deviceId, signal);
      await send(connection, deviceId, worker.pid, { operation: 'probe' }, signal);
      return worker.identity;
    },
    async start(connection, spec, digest, claimed, signal) {
      const worker = await same(connection, spec, signal);
      if (spec.handoff || !worker.identity.engines.some((engine) => engine === spec.engine)) {
        await send(connection, spec.deviceId, worker.pid, { operation: 'close' }, signal).catch(
          () => {},
        );
        throw new FleetDispatchError(
          'The selected native agent is not installed on this computer.',
          false,
        );
      }
      try {
        await claimed(worker.pid);
      } catch (error) {
        await send(connection, spec.deviceId, worker.pid, { operation: 'close' }).catch(() => {});
        throw error;
      }
      try {
        const text = await send(
          connection,
          spec.deviceId,
          worker.pid,
          {
            operation: 'start',
            id: spec.id,
            identityId: spec.identityId,
            hostname: spec.hostname,
            digest,
            spec,
          },
          signal,
        );
        return receipt(text, { ...spec, digest });
      } catch (error) {
        if (error instanceof FleetDispatchError) throw error;
        throw new FleetDispatchError(error instanceof Error ? error.message : String(error), true);
      }
    },
    async receipt(connection, run, signal): Promise<FleetReceipt | null> {
      if (run.pid) {
        try {
          const text = resultText(
            await call(
              connection,
              'read_process_output',
              {
                deviceId: run.deviceId,
                pid: run.pid,
                timeout_ms: 1000,
                length: 200,
              },
              signal,
            ),
          );
          const found = receipt(text, run);
          if (found) return found;
          if (/process is (?:still )?running|process is waiting|timeout/i.test(text)) return null;
        } catch (error) {
          if (error instanceof FleetDispatchError) throw error;
        }
      }
      return request(connection, run, 'receipt', signal);
    },
    stop: (connection, run, signal) => request(connection, run, 'stop', signal),
  };
}
