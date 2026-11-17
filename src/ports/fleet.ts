import type { FleetIdentity, FleetReceipt, NativeEngine } from '../shared/fleet.ts';
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
  engine: NativeEngine;
  profile: string | null;
  instruction: string;
}

export interface FleetRun {
  deviceId: string;
  identityId: string;
  hostname: string;
  id: string;
  digest: string;
  engine: NativeEngine;
  pid: number | null;
}

export interface FleetProvider {
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
    claimed: (pid: number) => Promise<void>,
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
