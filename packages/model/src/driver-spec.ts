import { z } from 'zod';
import { hasCatastrophicBacktracking } from './regex-safety';
export { hasCatastrophicBacktracking } from './regex-safety';
import { AssetCategory } from './devices';
import { DriverClass, SettingScope, classProblems } from './room/driver-classes';
import { QuickActionId } from './runtime/quick-actions';

// The Kestrel driver format. A driver is data, not code: it says how to talk to one kind of device
// (text over TCP, or HTTP requests), what to send for each thing a room can ask for, and how to read
// the device's replies. The gateway runs every driver with one interpreter, so a driver written by
// anyone can only do what the format allows. That is what makes third-party drivers safe to sell.

export const DRIVER_FORMAT = 1;

/** The things a room asks a device to do. `command.<name>` is for anything device specific. */
export const COMMAND_KEYS = [
  'power.on',
  'power.off',
  'mute.on',
  'mute.off',
  'volume',
  'select_input',
  'route',
  'preset',
  'camera_preset',
  'scene',
  'record.on',
  'record.off',
  'blank.on',
  'blank.off',
  'app.launch',
] as const;

/** Remote keys a driver may map: `key.up`, `key.play` and so on (see DisplayKey). */
export const KEY_COMMAND =
  /^key\.(up|down|left|right|ok|back|home|menu|play|pause|stop|forward|rewind)$/;

/** Values a command template may use. `{setting.<key>}` also reads one of the driver's settings. */
export const PLACEHOLDERS: Record<string, readonly string[]> = {
  volume: ['level', 'levelHex', 'levelHexAscii4'],
  select_input: ['input', 'inputNumber', 'inputHex', 'inputCode'],
  route: ['input', 'output', 'inputNumber', 'outputNumber'],
  preset: ['name'],
  camera_preset: ['name'],
  scene: ['name'],
  'app.launch': ['appId'],
};

export const SETTING_TYPES = ['string', 'number', 'boolean', 'secret'] as const;

export const DriverSetting = z.object({
  key: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/, 'Setting names use letters, numbers and underscores'),
  label: z.string().min(1).max(80),
  type: z.enum(SETTING_TYPES).default('string'),
  /** design, binding or secret. Left out, it is worked out from the type and the name (see settingScope). */
  scope: SettingScope.optional(),
  required: z.boolean().default(false),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  help: z.string().max(200).optional(),
});
export type DriverSetting = z.infer<typeof DriverSetting>;

/** One thing to send. Text for TCP, UDP and WebSocket, a request for HTTP. */
export const DriverAction = z.object({
  /** TCP, UDP and WebSocket: the text to send, before the terminator. */
  send: z.string().min(1).max(500).optional(),
  /**
   * TCP and UDP: raw bytes to send instead of text, as hex pairs ("AA 11 {setting.displayId} 01 01
   * {checksum}"). Values go in as hex. `{checksum}` is the transport's checksum of the bytes before it.
   * No terminator is added.
   */
  hex: z.string().min(1).max(500).optional(),
  /** HTTP */
  method: z.enum(['GET', 'POST', 'PUT']).optional(),
  path: z.string().min(1).max(500).optional(),
  body: z.string().max(2000).optional(),
  /** A regular expression the device's reply must match for the command to count as done. */
  expect: z.string().max(200).optional(),
  /** HTTP: headers for this request only, over the driver's own (a different content type, an action header). */
  headers: z.record(z.string().max(60), z.string().max(300)).optional(),
});
export type DriverAction = z.infer<typeof DriverAction>;

export const FEEDBACK_FIELDS = [
  'power',
  'muted',
  'volume',
  'input',
  'preset',
  'blanked',
  'online',
  'firmware',
  'model',
  'serial',
  'mac',
] as const;

/** The commands a quick action needs the driver to have. */
export const QUICK_ACTION_COMMANDS: Record<QuickActionId, readonly string[]> = {
  'display.blank': ['blank.on', 'blank.off'],
  'mics.privacy_mute': ['mute.on', 'mute.off'],
};

export const DriverPattern = z.object({
  /** A regular expression tried on each line (TCP) or on each reply body (HTTP). */
  match: z.string().min(1).max(300),
  set: z.enum(FEEDBACK_FIELDS),
  /** A literal ("on", "off", "true", "false") or "$1" for the first group in the match. */
  value: z.string().min(1).max(60),
});
export type DriverPattern = z.infer<typeof DriverPattern>;

/** TCP and UDP: replies are raw bytes. Each reply (a chunk read, or a datagram) is shown to patterns as hex pairs: "AA FF 00 03 41 11 01 13". */
const BinaryReplies = z.boolean().optional();

/**
 * How a frame's check byte is worked out when a hex payload carries `{checksum}`: the sum of the
 * bytes (modulo 256) or their XOR, from byte `from` (0 is the first) up to the byte before it.
 */
const FrameChecksum = z
  .object({
    type: z.enum(['sum8', 'xor8']),
    from: z.number().int().min(0).max(32).default(0),
  })
  .optional();

export const DriverSpec = z
  .object({
    format: z.literal(DRIVER_FORMAT).default(DRIVER_FORMAT),
    /** Lowercase letters, numbers and dashes. Devices refer to the driver as `custom:<id>`. */
    id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, 'Use lowercase letters, numbers and dashes'),
    name: z.string().min(1).max(80),
    /** Bumped on every change. A release pins the exact version it was built with. */
    version: z.number().int().min(1).default(1),
    description: z.string().max(500).default(''),
    /** Who makes the device and which model or series this driver is for. Shown and searched in the driver picker. */
    make: z.string().min(1).max(60).optional(),
    model: z.string().min(1).max(60).optional(),
    /** The device categories this driver suits, for filtering the picker. Left out: offered for every category. */
    categories: z.array(AssetCategory).min(1).max(12).optional(),
    transport: z.discriminatedUnion('type', [
      z.object({
        type: z.literal('tcp'),
        port: z.number().int().min(1).max(65535).optional(),
        terminator: z.string().max(4).default('\r\n'),
        /** What ends a reply, when it differs from what ends a command (LG replies end in "x", commands in CR). */
        replyTerminator: z.string().min(1).max(4).optional(),
        /** Keep one connection open. Needed to hear unsolicited feedback from the device. */
        keepOpen: z.boolean().default(false),
        timeoutMs: z.number().int().min(200).max(30_000).default(2000),
        binary: BinaryReplies,
        checksum: FrameChecksum,
      }),
      z.object({
        type: z.literal('http'),
        port: z.number().int().min(1).max(65535).optional(),
        https: z.boolean().default(false),
        headers: z.record(z.string().max(60), z.string().max(300)).default({}),
        timeoutMs: z.number().int().min(200).max(30_000).default(3000),
        /** https only: accept the device's own certificate, as most AV devices have one. */
        allowSelfSigned: z.boolean().optional(),
      }),
      z.object({
        type: z.literal('udp'),
        port: z.number().int().min(1).max(65535).optional(),
        /** Added to each datagram sent. Empty by default: most UDP devices want the bare text. */
        terminator: z.string().max(4).default(''),
        /** How long to wait for a reply datagram when a command expects one. */
        timeoutMs: z.number().int().min(200).max(30_000).default(2000),
        binary: BinaryReplies,
        checksum: FrameChecksum,
      }),
      z.object({
        type: z.literal('websocket'),
        port: z.number().int().min(1).max(65535).optional(),
        /** wss:// instead of ws://. */
        secure: z.boolean().default(false),
        /** The path the socket is opened on. */
        path: z.string().max(300).default('/'),
        headers: z.record(z.string().max(60), z.string().max(300)).default({}),
        timeoutMs: z.number().int().min(200).max(30_000).default(3000),
      }),
    ]),
    settings: z.array(DriverSetting).max(30).default([]),
    commands: z.record(z.string(), DriverAction).default({}),
    /** The kind of device this driver is for (docs/driver-classes.md). Left out of older drivers, so their hash is unchanged. */
    class: DriverClass.optional(),
    /** Optional features of that class this driver supports. */
    features: z.array(z.string().max(40)).max(30).optional(),
    /** Panel quick actions this device supports (standard ids). Left out of older drivers, so their hash is unchanged. */
    quickActions: z.array(QuickActionId).max(10).optional(),
    /** How to scale the room's 0-100 volume to the device's own range, and back. */
    volumeScale: z
      .object({
        min: z.number(),
        max: z.number(),
        decimals: z.number().int().min(0).max(3).default(0),
      })
      .optional(),
    /** The device's own code for each input port ("in1": "21"), read by commands as {inputCode}. */
    inputCodes: z.record(z.string().max(20), z.string().min(1).max(40)).optional(),
    feedback: z
      .object({
        poll: z
          .array(
            z.object({
              action: DriverAction,
              everyMs: z.number().int().min(1000).max(300_000).default(5000),
            }),
          )
          .max(10)
          .default([]),
        patterns: z.array(DriverPattern).max(40).default([]),
      })
      .default({ poll: [], patterns: [] }),
  })
  .strict();
export type DriverSpec = z.infer<typeof DriverSpec>;

/** A spec pinned into a release, with the version it was at. */
export const PinnedDriver = z.object({ version: z.number().int().min(1), spec: DriverSpec });
export type PinnedDriver = z.infer<typeof PinnedDriver>;

// ---- Templates -----------------------------------------------------------------------------------

const PLACEHOLDER = /\{([a-zA-Z_][\w.]*)\}/g;

export const placeholdersIn = (template: string): string[] =>
  [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!);

/**
 * Fills a template. Unknown placeholders become empty, so a typo shows up as a missing value, not as
 * text. `escape` cleans each value for where it lands (a URL path, a JSON body, a line of text).
 */
export function renderTemplate(
  template: string,
  values: Record<string, string | number | boolean>,
  escape: (value: string) => string = (v) => v,
): string {
  return template.replace(PLACEHOLDER, (_, name: string) => escape(String(values[name] ?? '')));
}

/** For text sent to a device: no value can add a line break or a control code and so send a second command. */
// eslint-disable-next-line no-control-regex -- removing control codes is the point
export const escapeLine = (v: string) => v.replace(/[\x00-\x1f\x7f]/g, '');
/** For a URL path. */
export const escapePath = (v: string) => encodeURIComponent(v);
/** For the inside of a JSON string. */
export const escapeJson = (v: string) => JSON.stringify(v).slice(1, -1);

/** For hex payloads: only hex digits get through. */
export const escapeHex = (v: string) => v.replace(/[^0-9a-fA-F]/g, '');

/** Bytes as hex pairs ("AA FF 00"), the way a binary reply is shown to feedback patterns. */
export const bytesToHex = (bytes: ArrayLike<number>): string =>
  Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/**
 * Builds the bytes of a hex payload. Values are escaped to hex digits, `{checksum}` becomes the
 * check byte of the bytes before it. Returns null when what comes out is not whole bytes.
 */
export function hexFrame(
  template: string,
  values: Record<string, string | number | boolean>,
  checksum?: { type: 'sum8' | 'xor8'; from: number },
): number[] | null {
  const parts = template.split('{checksum}');
  if (parts.length > 2) return null;
  const bytes = (t: string): number[] | null => {
    const h = renderTemplate(t, values, escapeHex).replace(/\s+/g, '');
    if (!/^([0-9a-fA-F]{2})*$/.test(h)) return null;
    return (h.match(/../g) ?? []).map((x) => parseInt(x, 16));
  };
  const head = bytes(parts[0]!);
  if (!head) return null;
  if (parts.length === 1) return head;
  if (!checksum) return null;
  const tail = bytes(parts[1]!);
  if (!tail) return null;
  const body = head.slice(checksum.from);
  const check =
    checksum.type === 'sum8'
      ? body.reduce((a, b) => (a + b) & 0xff, 0)
      : body.reduce((a, b) => a ^ b, 0);
  return [...head, check, ...tail];
}

/** The values a command gets, given the room's request. Port ids like "in2" give inputNumber 2. */
export function commandValues(
  spec: DriverSpec,
  settings: Record<string, string | number | boolean>,
  input: { level?: number; input?: string; output?: string; name?: string; appId?: string },
): Record<string, string | number | boolean> {
  const digits = (id?: string) => (id ? id.replace(/\D+/g, '') || id : '');
  const scale = spec.volumeScale;
  const level =
    input.level === undefined
      ? undefined
      : scale
        ? Number(
            (scale.min + (input.level / 100) * (scale.max - scale.min)).toFixed(scale.decimals),
          )
        : input.level;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(settings)) out[`setting.${k}`] = v;
  if (level !== undefined) {
    out.level = level;
    // Two hex digits, for devices that take a level as hexadecimal (LG: 00 to 64 is 0 to 100).
    out.levelHex = Math.max(0, Math.round(Number(level)))
      .toString(16)
      .toUpperCase()
      .padStart(2, '0');
    // Four hex digits written out as ASCII characters, then as hex bytes (NEC: 50 is "0032" is 30 30 33 32).
    out.levelHexAscii4 = [
      ...Math.max(0, Math.round(Number(level))).toString(16).toUpperCase().padStart(4, '0'),
    ]
      .map((c) => c.charCodeAt(0).toString(16).toUpperCase())
      .join('');
  }
  if (input.input !== undefined) {
    out.input = input.input;
    out.inputNumber = digits(input.input);
    // HDMI n as an LG input code: 90 for HDMI 1, 91 for HDMI 2, and so on.
    const n = Number(digits(input.input));
    if (Number.isInteger(n) && n >= 1 && n <= 16)
      out.inputHex = (0x8f + n).toString(16).toUpperCase();
    const code = spec.inputCodes?.[input.input];
    if (code !== undefined) out.inputCode = code;
  }
  if (input.output !== undefined) {
    out.output = input.output;
    out.outputNumber = digits(input.output);
  }
  if (input.name !== undefined) out.name = input.name;
  if (input.appId !== undefined) out.appId = input.appId;
  return out;
}

/** The setting values a device will run with: what it set, over the driver's defaults. */
export function resolveSettings(
  spec: DriverSpec,
  given: Record<string, unknown>,
): { values: Record<string, string | number | boolean>; missing: string[] } {
  const values: Record<string, string | number | boolean> = {};
  const missing: string[] = [];
  // host is always a device setting even if the driver does not declare it
  const declared = new Map(spec.settings.map((s) => [s.key, s]));
  if (!declared.has('host'))
    declared.set('host', { key: 'host', label: 'Address', type: 'string', required: true });
  if (!declared.has('port'))
    declared.set('port', { key: 'port', label: 'Port', type: 'number', required: false });
  for (const [key, s] of declared) {
    const raw = given[key] ?? s.default;
    const ok =
      (s.type === 'number' && typeof raw === 'number') ||
      (s.type === 'boolean' && typeof raw === 'boolean') ||
      ((s.type === 'string' || s.type === 'secret') && typeof raw === 'string' && raw !== '');
    if (ok) values[key] = raw as string | number | boolean;
    else if (s.required) missing.push(s.label);
  }
  return { values, missing };
}

// ---- Checking a spec -----------------------------------------------------------------------------

function regexProblem(source: string): string | null {
  try {
    new RegExp(source);
  } catch {
    return 'is not a valid regular expression';
  }
  // The gateway runs this against text a real device sends, on the same event loop as every other
  // room it hosts. A pattern shaped like `(a+)+` can take exponential time on a line that almost
  // matches, so this is rejected here rather than found the first time a device sends one.
  if (hasCatastrophicBacktracking(source))
    return 'could take an unbounded amount of time to match (a repeated group inside a repeated group, or two ambiguous alternatives) — write it so nothing can match the same text more than one way';
  return null;
}

/**
 * Everything the schema can't say: that regular expressions compile, that each command fits the
 * transport, and that templates only use values the command actually has. Returns plain sentences.
 */
export function driverProblems(spec: DriverSpec): string[] {
  const problems: string[] = [];
  const settingKeys = new Set(spec.settings.map((s) => s.key));
  const seen = new Set<string>();
  for (const s of spec.settings) {
    if (seen.has(s.key)) problems.push(`The setting “${s.key}” is listed twice`);
    seen.add(s.key);
  }
  problems.push(...classProblems(spec.class, spec.features, Object.keys(spec.commands)));
  const kind = spec.transport.type;
  const text = kind !== 'http';
  const kindName = { tcp: 'TCP', udp: 'UDP', websocket: 'WebSocket', http: 'HTTP' }[kind];
  const framed = spec.transport.type === 'tcp' || spec.transport.type === 'udp' ? spec.transport : null;

  const checkAction = (where: string, a: DriverAction, allowed: readonly string[]) => {
    const usesHex = a.hex !== undefined;
    const texts = usesHex
      ? [a.hex ?? '']
      : text
        ? [a.send ?? '']
        : [a.path ?? '', a.body ?? '', ...Object.values(a.headers ?? {})];
    if (kind !== 'http' && kind !== 'websocket' && a.headers)
      problems.push(`${where}: "headers" are for HTTP drivers`);
    if (kind === 'websocket' && a.headers)
      problems.push(`${where}: set headers on the driver, not on a command`);
    if (text && !a.send && !usesHex)
      problems.push(`${where}: a ${kindName} driver needs "send"${framed ? ' or "hex"' : ''}`);
    if (text && a.send && usesHex) problems.push(`${where}: use "send" or "hex", not both`);
    if (usesHex && !framed) problems.push(`${where}: "hex" is for TCP and UDP drivers`);
    if (!text && !a.path) problems.push(`${where}: an HTTP driver needs "path"`);
    if (text && (a.path || a.method || a.body))
      problems.push(`${where}: "path", "method" and "body" are for HTTP drivers`);
    if (!text && (a.send || usesHex))
      problems.push(`${where}: "send" is for TCP, UDP and WebSocket drivers`);
    if (!text && a.path && !a.path.startsWith('/'))
      problems.push(`${where}: the path must start with /`);
    if (usesHex && framed) {
      const hasToken = (a.hex ?? '').includes('{checksum}');
      if (hasToken && !framed.checksum)
        problems.push(`${where}: {checksum} needs "checksum" on the transport`);
      // Every value becomes at least one byte; two digits stand in for each to check it is whole bytes.
      const probe = (a.hex ?? '').replace(/\{[^}]+\}/g, '00').replace(/\s+/g, '');
      if (!/^([0-9a-fA-F]{2})+$/.test(probe))
        problems.push(`${where}: "hex" must be pairs of hex digits (like "AA 11 01")`);
    }
    for (const t of texts)
      for (const p of placeholdersIn(t)) {
        const ok =
          allowed.includes(p) ||
          (usesHex && p === 'checksum') ||
          (p.startsWith('setting.') && settingKeys.has(p.slice(8)));
        if (!ok)
          problems.push(
            `${where}: {${p}} is not available here${p.startsWith('setting.') ? ' (no such setting)' : ''}`,
          );
      }
    if (a.expect) {
      const p = regexProblem(a.expect);
      if (p) problems.push(`${where}: "expect" ${p}`);
    }
  };

  if (spec.transport.type === 'http' && spec.transport.allowSelfSigned && !spec.transport.https)
    problems.push('"allowSelfSigned" only applies when "https" is on');
  const keys = new Set<string>(COMMAND_KEYS);
  const cmds = Object.entries(spec.commands);
  if (cmds.length === 0 && spec.feedback.poll.length === 0)
    problems.push('A driver needs at least one command or something to poll');
  for (const [key, action] of cmds) {
    const custom =
      (key.startsWith('command.') && /^command\.[a-zA-Z][\w-]{0,39}$/.test(key)) ||
      KEY_COMMAND.test(key);
    if (!keys.has(key) && !custom) {
      problems.push(
        `“${key}” is not a command Kestrel knows (use ${COMMAND_KEYS.join(', ')}, key.<name> or command.<name>)`,
      );
      continue;
    }
    const base = key.split('.')[0]!;
    checkAction(`Command ${key}`, action, PLACEHOLDERS[key] ?? PLACEHOLDERS[base] ?? []);
  }
  for (const id of new Set(spec.quickActions ?? []))
    for (const need of QUICK_ACTION_COMMANDS[id])
      if (!spec.commands[need]) problems.push(`The quick action ${id} needs the command “${need}”`);
  spec.feedback.poll.forEach((p, i) => checkAction(`Poll ${i + 1}`, p.action, []));
  spec.feedback.patterns.forEach((p, i) => {
    const bad = regexProblem(p.match);
    if (bad) problems.push(`Pattern ${i + 1}: "match" ${bad}`);
    else {
      const groups = new RegExp(`${p.match}|`).exec('')!.length - 1;
      if (p.value.startsWith('$') && !/^\$[1-9]$/.test(p.value))
        problems.push(`Pattern ${i + 1}: "value" must be a literal or $1 to $9`);
      else if (/^\$[1-9]$/.test(p.value) && Number(p.value.slice(1)) > groups)
        problems.push(
          `Pattern ${i + 1}: "value" uses ${p.value} but the pattern has ${groups} group${groups === 1 ? '' : 's'}`,
        );
    }
    if (p.set === 'volume' && !spec.volumeScale && p.value.startsWith('$'))
      problems.push(
        `Pattern ${i + 1}: reading a volume needs "volumeScale" so it can be shown as 0-100`,
      );
  });
  if (
    spec.feedback.patterns.length > 0 &&
    spec.feedback.poll.length === 0 &&
    ((spec.transport.type === 'tcp' && !spec.transport.keepOpen) || spec.transport.type === 'udp')
  )
    problems.push(
      spec.transport.type === 'udp'
        ? 'Feedback patterns on a UDP driver need something to poll'
        : 'Feedback patterns on a TCP driver need "keepOpen" or something to poll',
    );
  if (
    spec.commands.volume &&
    !spec.volumeScale &&
    placeholdersIn(
      spec.commands.volume.send ?? spec.commands.volume.hex ?? spec.commands.volume.path ?? '',
    ).length === 0
  )
    problems.push('The volume command does not use {level}');
  return problems;
}

/** Parses and checks in one go, for the portal and the command line. */
export function checkDriverSpec(
  raw: unknown,
): { ok: true; spec: DriverSpec } | { ok: false; problems: string[] } {
  const parsed = DriverSpec.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'driver'}: ${i.message}`),
    };
  const problems = driverProblems(parsed.data);
  return problems.length ? { ok: false, problems } : { ok: true, spec: parsed.data };
}
