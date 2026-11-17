import type {
  FleetDirectory,
  FleetEngine,
  FleetHandoff,
  FleetIdentity,
  FleetReceipt,
} from '../shared/fleet.ts';
export { nativeEngines } from '../shared/fleet.ts';
export type { FleetEngine, FleetIdentity, FleetReceipt, NativeEngine } from '../shared/fleet.ts';

export class FleetDispatchError extends Error {
  constructor(
    message: string,
    readonly uncertain: boolean,
  ) {
    super(message);
    this.name = 'FleetDispatchError';
  }
}

export interface FleetConnection {
  kind?: 'desktop-commander' | 'crosswalk';
  connectionId: string;
  pathId: string;
  name: string;
  binding: string;
}

export interface FleetDevice {
  id: string;
  name: string;
  online: boolean;
}

export interface FleetSpec {
  id: string;
  deviceId: string;
  identityId: string;
  hostname: string;
  engine: FleetEngine;
  profile: string | null;
  instruction: string;
  handoff?: FleetHandoff & { connection: FleetConnection };
}

export interface FleetRun extends FleetSpec {
  digest: string;
  pid: number | null;
  remoteId?: string;
  stopRequested?: boolean;
}

export interface FleetProvider {
  directory?(connection: FleetConnection, signal?: AbortSignal): Promise<FleetDirectory>;
  devices(connection: FleetConnection, signal?: AbortSignal): Promise<FleetDevice[]>;
  probe(
    connection: FleetConnection,
    deviceId: string,
    signal?: AbortSignal,
  ): Promise<FleetIdentity>;
  start(
    connection: FleetConnection,
    spec: FleetSpec,
    digest: string,
    claimed: (pid: number | null) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<FleetReceipt | null>;
  receipt(
    connection: FleetConnection,
    run: FleetRun,
    signal?: AbortSignal,
  ): Promise<FleetReceipt | null>;
  stop(
    connection: FleetConnection,
    run: FleetRun,
    signal?: AbortSignal,
  ): Promise<FleetReceipt | null>;
}
