export const nativeEngines = ['muse', 'hermes', 'claude'] as const;
export const desktopCommanderEndpoint = 'https://mcp.desktopcommander.app/mcp';
export type NativeEngine = (typeof nativeEngines)[number];
export type FleetEngine =
  NativeEngine | 'muse-web' | 'grok-bot' | 'instinct' | 'claude-duet' | 'dots';

export interface FleetIdentity {
  id: string;
  hostname: string;
  platform: string;
  engines: NativeEngine[];
}

export interface FleetReceipt {
  id: string;
  digest: string;
  identityId: string;
  hostname: string;
  engine: NativeEngine;
  status: 'running' | 'finished' | 'failed' | 'stopped' | 'uncertain';
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  output?: string;
  error?: string;
}

export interface FleetBot {
  id: string;
  name: string;
  engine: FleetEngine;
  profile: string | null;
  deviceId: string | null;
  computerName: string;
  identity: FleetIdentity | null;
  revision: number;
}

export interface FleetJob {
  id: string;
  botId: string;
  botName: string;
  computerName: string;
  engine: FleetEngine;
  instruction: string;
  status: 'starting' | 'running' | 'stopping' | 'finished' | 'failed' | 'stopped' | 'uncertain';
  receipt: FleetReceipt | null;
  error: string | null;
  createdAt: string;
}

export interface FleetView {
  connectionId: string | null;
  connections: Array<{ id: string; name: string }>;
  devices: Array<{ id: string; name: string; online: boolean }>;
  bots: FleetBot[];
  jobs: FleetJob[];
  error: string | null;
}
