import type { FleetEngine } from '../../shared/fleet.ts';

export function fleetResult(engine: FleetEngine, output: string): string {
  if (engine !== 'hermes') return output;
  for (const line of output.split(/\r?\n/).reverse()) {
    try {
      const event: unknown = JSON.parse(line);
      if (
        event &&
        typeof event === 'object' &&
        'type' in event &&
        event.type === 'result' &&
        'text' in event &&
        typeof event.text === 'string'
      )
        return event.text;
    } catch {}
  }
  return output;
}
