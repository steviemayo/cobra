import { z } from 'zod';
import type { DeviceCommand } from './runtime/device';

// Device configuration (docs/pivot-monitoring.md, "Configuration and deployment"). A parameter is a
// reading a driver already reports and a command it already accepts, so any driver that supports the
// command can be held to a value with nothing extra to write. Everything here is pure.

export const CONFIG_MODES = ['watch', 'enforce', 'once'] as const;
export const ConfigMode = z.enum(CONFIG_MODES);
export type ConfigMode = z.infer<typeof ConfigMode>;
export const CONFIG_MODE_LABEL: Record<ConfigMode, string> = {
  watch: 'Watch: tell me if it changes',
  enforce: 'Enforce: put it back',
  once: 'Apply once: set it, then leave it',
};

export type ConfigFieldType = 'enum' | 'boolean' | 'number';
export interface ConfigFieldInfo {
  label: string;
  type: ConfigFieldType;
  options?: string[];
  min?: number;
  max?: number;
  /** The command that sets it. */
  set: (value: string | number | boolean) => DeviceCommand | null;
}

/** What can be held to a value. Every one of these is both reported back by drivers and settable. */
export const CONFIG_FIELDS: Record<string, ConfigFieldInfo> = {
  power: {
    label: 'Power',
    type: 'enum',
    options: ['on', 'off'],
    set: (v) => (v === 'on' || v === 'off' ? { type: 'power', on: v === 'on' } : null),
  },
  muted: {
    label: 'Muted',
    type: 'boolean',
    set: (v) => (typeof v === 'boolean' ? { type: 'mute', muted: v } : null),
  },
  volume: {
    label: 'Volume',
    type: 'number',
    min: 0,
    max: 100,
    set: (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 0 && n <= 100 ? { type: 'volume', level: n } : null;
    },
  },
  blanked: {
    label: 'Picture blanked',
    type: 'boolean',
    set: (v) => (typeof v === 'boolean' ? { type: 'blank', on: v } : null),
  },
  recording: {
    label: 'Recording',
    type: 'boolean',
    set: (v) => (typeof v === 'boolean' ? { type: 'record', on: v } : null),
  },
};

export const ConfigParam = z.object({
  field: z.string().min(1).max(40),
  value: z.union([z.string().max(100), z.number(), z.boolean()]),
  mode: ConfigMode.default('watch'),
});
export type ConfigParam = z.infer<typeof ConfigParam>;
export const ConfigParams = z.array(ConfigParam).max(30);

/** A parameter is refused when it names something Kestrel cannot hold or its value cannot be set. */
export function checkConfigParam(p: ConfigParam): string | null {
  const info = CONFIG_FIELDS[p.field];
  if (!info) return `${p.field} cannot be held to a value`;
  if (!info.set(p.value)) return `${info.label} cannot be set to ${String(p.value)}`;
  return null;
}

/**
 * A parameter only applies to a device that reports that reading: what a driver can report decides
 * what can be held. Anything else is set aside (shown as not applicable), never tracked or enforced.
 */
export function splitApplicable(
  params: ConfigParam[],
  reported: Iterable<string>,
): { applies: ConfigParam[]; skipped: ConfigParam[] } {
  const have = new Set(reported);
  const applies: ConfigParam[] = [];
  const skipped: ConfigParam[] = [];
  for (const p of params) (have.has(p.field) ? applies : skipped).push(p);
  return { applies, skipped };
}

/** The settings a device can be held to: those it has reported and that Kestrel knows how to set. */
export function holdableFields(reported: Iterable<string>): string[] {
  return [...new Set(reported)].filter((f) => f in CONFIG_FIELDS);
}

/** The parameters in force for a device: its profile's, with any of its own replacing the same field. */
export function effectiveParams(profile: ConfigParam[], own: ConfigParam[]): ConfigParam[] {
  const byField = new Map(profile.map((p) => [p.field, p]));
  for (const p of own) byField.set(p.field, p);
  return [...byField.values()];
}

const norm = (v: unknown) => String(v).toLowerCase();

/** Whether a reading matches the wanted value. An absent reading is neither: the device said nothing. */
export function paramState(p: ConfigParam, actual: unknown): 'ok' | 'drifted' | 'unknown' {
  if (actual === undefined || actual === null) return 'unknown';
  return norm(actual) === norm(p.value) ? 'ok' : 'drifted';
}

/** The command that puts a parameter right, or null when its value cannot be set. */
export function paramCommand(p: ConfigParam): DeviceCommand | null {
  return CONFIG_FIELDS[p.field]?.set(p.value) ?? null;
}

// ---- What is remembered per held setting -----------------------------------------------------------

export interface ConfigFieldState {
  drifted: boolean;
  desired: string;
  actual: string;
  /** When it first read differently. */
  since: string;
  /** How many times it has been sent back without the reading coming right. */
  attempts: number;
  lastEnforcedAt?: string;
}
export type ConfigState = Record<string, ConfigFieldState>;

export const ENFORCE_COOLDOWN_MS = 60_000;
export const ENFORCE_MAX_ATTEMPTS = 5;

export interface DriftStep {
  state: ConfigState;
  /** A setting that has just gone wrong. */
  newlyDrifted: { field: string; desired: string; actual: string }[];
  /** A setting that has just come right, and whether Kestrel put it there. */
  newlyOk: { field: string; corrected: boolean }[];
  /** Commands to send now to put settings back (enforce mode, outside the cool-down). */
  enforce: { field: string; command: DeviceCommand }[];
  /** Enforced settings that have been sent back too many times to keep trying. */
  giveUp: { field: string; desired: string; actual: string }[];
  /** A setting no longer held (removed from the profile) whose drift should be cleared. */
  cleared: string[];
}

/**
 * One reading against the parameters in force. Watch and enforce settings are tracked; a setting that
 * drifts is reported once when it starts, and (enforce) sent back at most once a minute, up to five
 * times before giving up.
 */
export function stepDrift(
  params: ConfigParam[],
  previous: ConfigState,
  readings: Record<string, unknown>,
  now: number,
): DriftStep {
  const state: ConfigState = {};
  const out: DriftStep = {
    state,
    newlyDrifted: [],
    newlyOk: [],
    enforce: [],
    giveUp: [],
    cleared: [],
  };
  const held = params.filter((p) => p.mode !== 'once');
  for (const p of held) {
    const prev = previous[p.field];
    const actual = readings[p.field];
    const s = paramState(p, actual);
    if (s === 'unknown') {
      // Nothing said: keep what was known.
      if (prev) state[p.field] = prev;
      continue;
    }
    if (s === 'ok') {
      if (prev?.drifted) out.newlyOk.push({ field: p.field, corrected: (prev.attempts ?? 0) > 0 });
      continue;
    }
    const since = prev?.drifted ? prev.since : new Date(now).toISOString();
    const next: ConfigFieldState = {
      drifted: true,
      desired: String(p.value),
      actual: String(actual),
      since,
      attempts: prev?.drifted ? prev.attempts : 0,
      ...(prev?.lastEnforcedAt ? { lastEnforcedAt: prev.lastEnforcedAt } : {}),
    };
    if (!prev?.drifted)
      out.newlyDrifted.push({ field: p.field, desired: next.desired, actual: next.actual });
    if (p.mode === 'enforce') {
      const last = prev?.lastEnforcedAt ? Date.parse(prev.lastEnforcedAt) : 0;
      const command = paramCommand(p);
      if (next.attempts >= ENFORCE_MAX_ATTEMPTS) {
        if (
          prev?.drifted &&
          prev.attempts === next.attempts &&
          next.attempts === ENFORCE_MAX_ATTEMPTS
        )
          out.giveUp.push({ field: p.field, desired: next.desired, actual: next.actual });
      } else if (command && now - last >= ENFORCE_COOLDOWN_MS) {
        out.enforce.push({ field: p.field, command });
        next.attempts += 1;
        next.lastEnforcedAt = new Date(now).toISOString();
        if (next.attempts === ENFORCE_MAX_ATTEMPTS)
          out.giveUp.push({ field: p.field, desired: next.desired, actual: next.actual });
      }
    }
    state[p.field] = next;
  }
  for (const f of Object.keys(previous))
    if (!held.some((p) => p.field === f) && previous[f]?.drifted) out.cleared.push(f);
  return out;
}

// ---- Snapshots -------------------------------------------------------------------------------------

export interface SnapshotData {
  driver: string | null;
  firmware: string | null;
  feedback: Record<string, unknown>;
  /** Sections of what the device says about itself: title, then label to value. */
  details: { title: string; rows: { label: string; value: string }[] }[];
  /** The non-secret settings the driver was given (addresses and design settings, never logins). */
  settings: Record<string, unknown>;
}

/** Detail rows that change by themselves and would make every comparison noisy. */
const VOLATILE =
  /uptime|up time|clock|date|time|temperature|temp\b|fan|rssi|signal strength|last seen|session|memory|cpu|load|counter/i;

export function isVolatileLabel(label: string): boolean {
  return VOLATILE.test(label);
}

/** A snapshot as flat key to text, for comparing. Volatile rows are left out. */
export function flattenSnapshot(d: SnapshotData): Map<string, string> {
  const out = new Map<string, string>();
  if (d.driver) out.set('driver', d.driver);
  if (d.firmware) out.set('firmware', d.firmware);
  for (const [k, v] of Object.entries(d.feedback ?? {})) out.set(`reading: ${k}`, String(v));
  for (const [k, v] of Object.entries(d.settings ?? {})) out.set(`setting: ${k}`, String(v));
  for (const section of d.details ?? [])
    for (const row of section.rows ?? [])
      if (!isVolatileLabel(row.label)) out.set(`${section.title}: ${row.label}`, row.value);
  return out;
}

export interface SnapshotChange {
  key: string;
  before: string | null;
  after: string | null;
}

/** What differs between two snapshots, sorted by key. */
export function diffSnapshots(before: SnapshotData, after: SnapshotData): SnapshotChange[] {
  const a = flattenSnapshot(before);
  const b = flattenSnapshot(after);
  const keys = new Set([...a.keys(), ...b.keys()]);
  const out: SnapshotChange[] = [];
  for (const key of [...keys].sort()) {
    const x = a.get(key) ?? null;
    const y = b.get(key) ?? null;
    if (x !== y) out.push({ key, before: x, after: y });
  }
  return out;
}

/** Settings with anything that could be a login removed, so a snapshot can be shown and exported. */
export function stripSecrets(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings))
    if (!/pass|secret|token|key|credential|auth|pin\b/i.test(k)) out[k] = v;
  return out;
}

/** What a deploy would change on a device: parameters whose current reading differs from the wanted value. */
export function planDeploy(
  params: ConfigParam[],
  readings: Record<string, unknown>,
): { field: string; from: string | null; to: string; mode: ConfigMode; willSet: boolean }[] {
  return params.map((p) => {
    const actual = readings[p.field];
    return {
      field: p.field,
      from: actual === undefined || actual === null ? null : String(actual),
      to: String(p.value),
      mode: p.mode,
      willSet: paramState(p, actual) !== 'ok',
    };
  });
}
