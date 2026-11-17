export const nativeEngines = ['muse', 'hermes', 'claude'] as const;
export const desktopCommanderEndpoint = 'https://mcp.desktopcommander.app/mcp';
export const crosswalkEndpoint = 'https://mcp.crosswalk.to';
export type NativeEngine = (typeof nativeEngines)[number];
export type FleetEngine =
  NativeEngine | 'muse-web' | 'grok-bot' | 'instinct' | 'claude-duet' | 'dots';

export interface FleetHandoff {
  connectionId: string;
  username: string;
  recipient: string;
  recipientName: string;
  aliases: string[];
  space: string;
}

export interface FleetDirectory {
  username: string;
  recipients: Array<{ id: string; name: string; aliases: string[] }>;
  spaces: string[];
}

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
  engine: FleetEngine;
  status:
    'queued' | 'claimed' | 'reported' | 'running' | 'finished' | 'failed' | 'stopped' | 'uncertain';
  remoteId?: string;
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
  delivery: 'native' | 'crosswalk';
  profile: string | null;
  deviceId: string | null;
  computerName: string;
  identity: FleetIdentity | null;
  revision: number;
  handoff: FleetHandoff | null;
}

export interface FleetJob {
  id: string;
  botId: string;
  botName: string;
  deviceId: string;
  computerName: string;
  engine: FleetEngine;
  instruction: string;
  delivery: 'native' | 'crosswalk';
  recipient?: string;
  status: FleetReceipt['status'] | 'starting' | 'stopping';
  receipt: FleetReceipt | null;
  error: string | null;
  createdAt: string;
}

export interface FleetView {
  connectionId: string | null;
  connections: Array<{ id: string; name: string }>;
  handoffConnections: Array<{ id: string; name: string }>;
  devices: Array<{ id: string; name: string; online: boolean }>;
  bots: FleetBot[];
  jobs: FleetJob[];
  error: string | null;
}
