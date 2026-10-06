import { z } from 'zod';
import { isObject, str, type Provider } from './types';

// Microsoft Teams Rooms. Microsoft offers no supported Graph API for room health (the beta
// teamworkDevice API is deprecated), so this works the other way round: the customer points the Teams
// Rooms Pro Management incident webhook (or the older Teams admin center device-offline webhook) at a
// URL Kestrel gives them, and every event becomes a Kestrel incident or device state. No gateway.

export const teams: Provider<Record<string, never>> = {
  id: 'teams',
  label: 'Microsoft Teams Rooms',
  mode: 'push',
  credentials: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  async test() {},
  async list() {
    return [];
  },
};

export type TeamsSeverity = 'info' | 'warning' | 'critical';

/** One thing Microsoft told us, in Kestrel's words. */
export type TeamsEvent =
  | {
      kind: 'incident';
      incidentId: string;
      /** The Pro Management device id, then the room account and hostname: any of them may be what a device is paired by. */
      keys: string[];
      name: string;
      signal: string;
      description: string | null;
      severity: TeamsSeverity;
      /** An open incident keeps a problem open; a resolved or closed one clears it. */
      open: boolean;
    }
  | { kind: 'state'; key: string; name: string; online: boolean };

const SEVERITY: Record<string, TeamsSeverity> = {
  critical: 'critical',
  important: 'warning',
  warning: 'warning',
  security: 'warning',
  recommendation: 'info',
};
const OPEN_STATES = new Set(['watching', 'new', 'investigating']);
const CLOSED_STATES = new Set(['resolved', 'closed']);

/** Turns a webhook body into events. Anything it does not recognise gives no events. */
export function parseTeamsEvents(body: unknown): TeamsEvent[] {
  if (!isObject(body)) return [];

  // Teams Rooms Pro Management: { eventType: "Incident", data: "<json string>" } (data may also be an object).
  if (str(body.eventType)?.toLowerCase() === 'incident') {
    let data: unknown = body.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        return [];
      }
    }
    if (!isObject(data)) return [];
    const incidentId = str(data.ID) ?? str(data.id);
    const state = (str(data.state) ?? '').toLowerCase();
    if (!incidentId || !(OPEN_STATES.has(state) || CLOSED_STATES.has(state))) return [];
    const devices = (Array.isArray(data.devices) ? data.devices : []).filter(isObject);
    if (devices.length === 0) return [];
    const signal = str(data.signal) ?? 'Teams Rooms problem';
    const severity = SEVERITY[(str(data.severity) ?? '').toLowerCase()] ?? 'warning';
    return devices.map((d) => ({
      kind: 'incident' as const,
      incidentId,
      keys: [str(d.ID), str(d.roomAccount), str(d.hostname)].filter((k): k is string => !!k),
      name: str(d.displayName) ?? str(d.hostname) ?? 'Teams Room',
      signal,
      description: str(data.description),
      severity,
      open: OPEN_STATES.has(state),
    }));
  }

  // Teams admin center device state rule: { DeviceId, AlertTitle, MetricValues: { DeviceHealthStatus } }.
  const health = isObject(body.MetricValues) ? str(body.MetricValues.DeviceHealthStatus) : null;
  const deviceId = str(body.DeviceId);
  if (health && deviceId) {
    const online = health.toLowerCase() === 'online';
    if (!online && health.toLowerCase() !== 'offline') return [];
    const title = str(body.AlertTitle);
    return [
      {
        kind: 'state',
        key: deviceId,
        // "<device> of <user> has become offline": the device name is the part before " of ".
        name: title?.split(' of ')[0]?.replace(/ has become .*/i, '') || 'Teams Room',
        online,
      },
    ];
  }
  return [];
}
