import {
  DriverSpec,
  commandValues,
  escapeLine,
  escapePath,
  hasCatastrophicBacktracking,
  renderTemplate,
  resolveSettings,
} from '@kestrel/model';

// The example driver, and the helpers that show what a driver would send and what it would make of a
// reply. Shared by the driver editor and the how-to guide, so the guide's examples are computed from
// the real driver format and cannot drift from it.

export const STARTER = {
  id: 'my-projector',
  name: 'My projector',
  description: 'Text commands over TCP.',
  make: 'Example',
  model: 'Projector X',
  categories: ['projector'],
  transport: { type: 'tcp', port: 4352, terminator: '\r\n', timeoutMs: 2000 },
  settings: [{ key: 'password', label: 'Password', type: 'secret' }],
  commands: {
    'power.on': { send: 'PWR ON', expect: '^OK' },
    'power.off': { send: 'PWR OFF', expect: '^OK' },
    volume: { send: 'VOL {level}' },
    select_input: { send: 'SRC {inputNumber}' },
  },
  volumeScale: { min: 0, max: 30 },
  feedback: {
    poll: [{ action: { send: 'STATUS?' }, everyMs: 5000 }],
    patterns: [{ match: '^POWER=(ON|OFF)', set: 'power', value: '$1' }],
  },
};

export interface SampleRequest {
  level?: number;
  input?: string;
  output?: string;
  name?: string;
}

const DEFAULT_SAMPLE: SampleRequest = { level: 50, input: 'in2', output: 'out1', name: 'Movie' };

/** What each command would send, with sample values, so a driver can be checked without a device. */
export function preview(raw: unknown, sample: SampleRequest = DEFAULT_SAMPLE): { key: string; text: string }[] {
  const parsed = DriverSpec.safeParse(raw);
  if (!parsed.success) return [];
  const spec = parsed.data;
  const settings = resolveSettings(spec, { host: '10.0.0.5', password: '••••' }).values;
  const values = commandValues(spec, settings, sample);
  return Object.entries(spec.commands).map(([key, a]) => ({
    key,
    text:
      spec.transport.type !== 'http'
        ? renderTemplate(a.send ?? '', values, escapeLine)
        : `${a.method ?? (a.body ? 'POST' : 'GET')} ${renderTemplate(a.path ?? '', values, escapePath)}${a.body ? `  ${renderTemplate(a.body, values, escapeLine)}` : ''}`,
  }));
}

export interface FeedbackReading {
  set: string;
  /** What the room would end up believing, in plain words. */
  result: string;
}

/**
 * What the gateway would make of one line of device reply: every pattern that matches applies, in
 * order. Mirrors the rules in the gateway's driver interpreter.
 */
export function readFeedback(raw: unknown, line: string): FeedbackReading[] {
  const parsed = DriverSpec.safeParse(raw);
  if (!parsed.success) return [];
  const spec = parsed.data;
  const out: FeedbackReading[] = [];
  for (const p of spec.feedback.patterns) {
    // Saving already refuses a pattern shaped like this (driver-spec.ts), but this preview runs
    // against whatever is typed into the editor before that check has had a chance to run.
    if (hasCatastrophicBacktracking(p.match)) continue;
    let m: RegExpExecArray | null;
    try {
      m = new RegExp(p.match).exec(line);
    } catch {
      continue;
    }
    if (!m) continue;
    const value = /^\$[1-9]$/.test(p.value) ? (m[Number(p.value.slice(1))] ?? '') : p.value;
    switch (p.set) {
      case 'power':
        out.push({
          set: 'power',
          result: /^(on|1|true)$/i.test(value) ? 'on' : /^(off|0|false)$/i.test(value) ? 'off' : 'unchanged',
        });
        break;
      case 'muted':
        out.push({ set: 'muted', result: /^(on|1|true|muted)$/i.test(value) ? 'yes' : 'no' });
        break;
      case 'blanked':
        out.push({ set: 'blanked', result: /^(on|1|true|blank|blanked)$/i.test(value) ? 'yes' : 'no' });
        break;
      case 'online':
        out.push({ set: 'online', result: /^(on|1|true)$/i.test(value) ? 'yes' : 'no' });
        break;
      case 'volume': {
        const n = Number(value);
        const sc = spec.volumeScale;
        out.push({
          set: 'volume',
          result: Number.isFinite(n)
            ? String(Math.max(0, Math.min(100, Math.round(sc ? ((n - sc.min) / (sc.max - sc.min)) * 100 : n))))
            : 'unchanged',
        });
        break;
      }
      default:
        out.push({ set: p.set, result: value || 'nothing' });
    }
  }
  return out;
}
