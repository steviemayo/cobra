import { connect } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { readArp, type ArpReader } from './arp';

// Finding equipment on the gateway's own network, so an installer does not have to hunt for
// addresses. Only ever looks at private networks the gateway itself sits on (one /24 per address, at
// most three), only tries a short list of well-known control ports, and only reads: it connects,
// and for PJLink projectors asks for a name and model. It never sends a command that changes
// anything, and never touches a public address. What it finds is a hint for a person to check.

export interface KnownPort {
  port: number;
  /** What a device answering here usually is. Only a guess. */
  label: string;
  /** Ask it who it is. */
  pjlink?: boolean;
}

export const KNOWN_PORTS: KnownPort[] = [
  { port: 4352, label: 'Projector or display (PJLink)', pjlink: true },
  { port: 23, label: 'Telnet control (for example Extron or Biamp)' },
  { port: 22023, label: 'Extron (SIS)' },
  { port: 1710, label: 'Q-SYS Core' },
  { port: 2202, label: 'Shure' },
  { port: 5000, label: 'Kramer' },
];

export interface FoundDevice {
  host: string;
  ports: number[];
  /** The likeliest kind of device, from the ports that answered. */
  kind: string;
  name?: string;
  manufacturer?: string;
  model?: string;
  /** Its MAC, read from the gateway's own network. Only for a device on the same network segment. */
  mac?: string;
  /** Something to tell the person, such as a password being needed. */
  note?: string;
}

export interface DiscoveryResult {
  /** The networks looked at, as "192.168.1" (a /24). */
  subnets: string[];
  hostsScanned: number;
  found: FoundDevice[];
  /** Stopped early, or more was found than is listed. */
  truncated: boolean;
  ms: number;
}

export const MAX_FOUND = 100;
export const MAX_SUBNETS = 3;

// ---- Which networks ------------------------------------------------------------------------------

export function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 10 || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) || (p[0] === 192 && p[1] === 168);
}

/** The /24 networks the gateway is on, with its own addresses so they are skipped. */
export function ownSubnets(
  nets: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): { prefix: string; own: Set<string> }[] {
  const by = new Map<string, Set<string>>();
  for (const list of Object.values(nets))
    for (const n of list ?? []) {
      // Older Node versions say "IPv4", newer ones may say 4.
      if ((n.family as string | number) !== 'IPv4' && (n.family as string | number) !== 4) continue;
      if (n.internal || !isPrivateV4(n.address)) continue;
      const prefix = n.address.split('.').slice(0, 3).join('.');
      by.set(prefix, (by.get(prefix) ?? new Set()).add(n.address));
    }
  return [...by].slice(0, MAX_SUBNETS).map(([prefix, own]) => ({ prefix, own }));
}

const numeric = (ip: string) => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);

// ---- Probing -------------------------------------------------------------------------------------

/** Whether something accepts a connection on the port. */
export function tcpOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('close', () => done(false));
  });
}

export interface PjlinkInfo {
  name?: string;
  manufacturer?: string;
  model?: string;
  /** The projector wants a password before it will say anything. */
  needsPassword?: boolean;
}

/** Asks a PJLink device for its name, maker and model. Reads only. */
export function pjlinkInfo(host: string, port: number, timeoutMs: number): Promise<PjlinkInfo> {
  return new Promise((resolve) => {
    const info: PjlinkInfo = {};
    const socket = connect({ host, port });
    let buffer = '';
    const queries = ['NAME', 'INF1', 'INF2'] as const;
    let step = -1;
    const finish = () => {
      socket.destroy();
      resolve(info);
    };
    const ask = () => {
      step++;
      if (step >= queries.length) return finish();
      socket.write(`%1${queries[step]} ?\r`);
    };
    socket.setTimeout(timeoutMs, finish);
    socket.once('error', finish);
    // A device that hangs up partway must not leave the scan waiting for it.
    socket.once('close', finish);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let end: number;
      while ((end = buffer.indexOf('\r')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (step === -1) {
          // The greeting: "PJLINK 0" (no password) or "PJLINK 1 <salt>" (password needed).
          if (/^PJLINK 1/i.test(line)) {
            info.needsPassword = true;
            return finish();
          }
          if (!/^PJLINK 0/i.test(line)) return finish();
          return ask();
        }
        const value = /^%1[A-Z0-9]+=(.*)$/.exec(line)?.[1];
        if (value && !/^ERR/.test(value)) {
          if (queries[step] === 'NAME') info.name = value;
          if (queries[step] === 'INF1') info.manufacturer = value;
          if (queries[step] === 'INF2') info.model = value;
        }
        ask();
      }
    });
  });
}

// ---- The scan ------------------------------------------------------------------------------------

export interface DiscoveryOptions {
  /** Networks to scan as "192.168.1". Defaults to the ones the gateway is on. */
  subnets?: string[];
  /** Exact addresses instead of networks (for tests). */
  hosts?: string[];
  ports?: KnownPort[];
  timeoutMs?: number;
  concurrency?: number;
  /** Stop looking after this long and report what was found. */
  deadlineMs?: number;
  nets?: NodeJS.Dict<NetworkInterfaceInfo[]>;
  open?: typeof tcpOpen;
  probe?: typeof pjlinkInfo;
  arp?: ArpReader;
  now?: () => number;
}

/** Runs tasks with at most `limit` at once, stopping to start new ones after the deadline. */
async function pool<T>(items: T[], limit: number, expired: () => boolean, run: (item: T) => Promise<void>): Promise<boolean> {
  let next = 0;
  let cut = false;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        if (expired()) {
          cut = true;
          return;
        }
        await run(items[next++]!);
      }
    }),
  );
  return cut;
}

export async function discoverDevices(opts: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const ports = opts.ports ?? KNOWN_PORTS;
  const timeout = opts.timeoutMs ?? 300;
  const open = opts.open ?? tcpOpen;
  const probe = opts.probe ?? pjlinkInfo;
  const expired = () => now() - started >= (opts.deadlineMs ?? 8000);

  let subnets: string[] = [];
  let hosts: string[];
  if (opts.hosts) hosts = [...new Set(opts.hosts)];
  else {
    const own = ownSubnets(opts.nets);
    const wanted = opts.subnets ? own.filter((s) => opts.subnets!.includes(s.prefix)) : own;
    subnets = wanted.map((s) => s.prefix);
    hosts = wanted.flatMap((s) =>
      Array.from({ length: 254 }, (_, i) => `${s.prefix}.${i + 1}`).filter((h) => !s.own.has(h)),
    );
  }

  const answers = new Map<string, number[]>();
  const pairs = hosts.flatMap((host) => ports.map((p) => ({ host, port: p.port })));
  let cut = await pool(pairs, opts.concurrency ?? 96, expired, async ({ host, port }) => {
    if (await open(host, port, timeout)) answers.set(host, [...(answers.get(host) ?? []), port].sort((a, b) => a - b));
  });

  const label = new Map(ports.map((p) => [p.port, p]));
  const found: FoundDevice[] = [];
  await pool([...answers], 16, () => false, async ([host, open]) => {
    const first = label.get(open[0]!)!;
    const dev: FoundDevice = { host, ports: open, kind: first.label };
    const pj = open.map((p) => label.get(p)).find((p) => p?.pjlink);
    if (pj) {
      const info = await probe(host, pj.port, Math.max(timeout, 1200));
      if (info.needsPassword) dev.note = 'Needs its PJLink password before it will say what it is';
      if (info.name) dev.name = info.name;
      if (info.manufacturer) dev.manufacturer = info.manufacturer;
      if (info.model) dev.model = info.model;
      dev.kind = pj.label;
    }
    found.push(dev);
  });

  // Connecting made the network answer for each of them, so the table now knows their MACs.
  if (found.length > 0) {
    const table = await (opts.arp ?? readArp)();
    for (const dev of found) {
      const mac = table.get(dev.host);
      if (mac) dev.mac = mac;
    }
  }

  found.sort((a, b) => numeric(a.host) - numeric(b.host));
  if (found.length > MAX_FOUND) cut = true;
  return { subnets, hostsScanned: hosts.length, found: found.slice(0, MAX_FOUND), truncated: cut, ms: now() - started };
}
