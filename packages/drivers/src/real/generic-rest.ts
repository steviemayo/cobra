import { DriverSpec, type Device, type DriverAction } from '@kestrel/model';
import { DeclarativeDriver } from './declarative';
import type { DriverContext } from './types';

/**
 * Generic REST control, configured entirely from the device's settings, for devices with a simple
 * HTTP API and no driver:
 *   host, port, https (false), headers ({"authorization": "Bearer ..."}), timeoutMs,
 *   commands: { "power.on": { "method": "POST", "path": "/api/power", "body": "{\"on\":true}", "expect": "ok" }, ... }
 *   poll: { "path": "/api/state", "everyMs": 5000, "patterns": [{ "match": "\"on\":(true|false)", "set": "power", "value": "$1" }] }
 * It is the Kestrel driver format written inline, so the same rules and escaping apply.
 */
export function genericRestDriver(device: Device, ctx: DriverContext): DeclarativeDriver | null {
  const s = device.settings as Record<string, unknown>;
  const commands = (s.commands ?? {}) as Record<string, DriverAction>;
  const poll = s.poll as { path?: string; everyMs?: number; patterns?: unknown[] } | undefined;
  const parsed = DriverSpec.safeParse({
    id: 'generic-rest',
    name: device.name,
    transport: {
      type: 'http',
      https: s.https === true,
      headers: (s.headers ?? {}) as Record<string, string>,
      ...(typeof s.timeoutMs === 'number' ? { timeoutMs: s.timeoutMs } : {}),
    },
    commands,
    feedback: poll?.path
      ? {
          poll: [{ action: { method: 'GET', path: poll.path }, everyMs: poll.everyMs ?? 5000 }],
          patterns: poll.patterns ?? [],
        }
      : { poll: [], patterns: [] },
  });
  if (!parsed.success) {
    ctx.log('warn', 'This device’s REST settings are not valid', { device: device.name, problem: parsed.error.issues[0]?.message });
    return null;
  }
  return new DeclarativeDriver(device, ctx, parsed.data);
}
