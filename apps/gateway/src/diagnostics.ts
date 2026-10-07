import { lookup } from 'node:dns/promises';
import { closeSync, existsSync, openSync, readSync, statSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { arch, freemem, hostname, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import type { LogLevel } from './log';

/** Facts about the machine and the data folder, for the troubleshooting page. Nothing secret. */
export interface HostFacts {
  hostname: string;
  os: string;
  arch: string;
  node: string;
  pid: number;
  memoryUsedMb: number;
  memoryFreeMb: number;
  memoryTotalMb: number;
  timeZone: string;
  localTime: string;
  dataDir: string;
  dataFreeGb: number | null;
  dataTotalGb: number | null;
  databaseKb: number | null;
}

const gb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

export function hostFacts(dataDir: string): HostFacts {
  let free: number | null = null;
  let total: number | null = null;
  try {
    const f = statfsSync(dataDir);
    free = gb(f.bavail * f.bsize);
    total = gb(f.blocks * f.bsize);
  } catch {
    // a filesystem that cannot say: leave it out rather than guess
  }
  let dbKb: number | null = null;
  try {
    dbKb = Math.round(statSync(join(dataDir, 'gateway.db')).size / 1024);
  } catch {
    // no database yet
  }
  return {
    hostname: hostname(),
    os: `${platform()} ${release()}`,
    arch: arch(),
    node: process.version,
    pid: process.pid,
    memoryUsedMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    memoryFreeMb: Math.round(freemem() / 1024 / 1024),
    memoryTotalMb: Math.round(totalmem() / 1024 / 1024),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    localTime: new Date().toString(),
    dataDir,
    dataFreeGb: free,
    dataTotalGb: total,
    databaseKb: dbKb,
  };
}

export interface CheckResult {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  ms?: number;
}

export interface CheckOptions {
  cloudUrl: string;
  dataDir: string;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  lookupImpl?: typeof lookup;
  now?: () => number;
}

const SKEW_WARN_MS = 60_000;
const LOW_DISK_GB = 0.5;

/**
 * Checks the things that most often stop a gateway reaching Kestrel, each with a plain-language
 * result: the name resolves, the address answers over HTTPS, this machine's clock is close to
 * Kestrel's, the data folder has room and can be written to, and whether a proxy is set.
 */
export async function runChecks(opts: CheckOptions): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;
  const doLookup = opts.lookupImpl ?? lookup;
  let url: URL | null = null;
  try {
    url = new URL(opts.cloudUrl);
  } catch {
    out.push({
      id: 'address',
      label: 'Kestrel address',
      status: 'fail',
      detail: `“${opts.cloudUrl}” is not a web address. Use “Change cloud URL” on the gateway machine.`,
    });
  }

  if (url) {
    let began = now();
    try {
      const found = await doLookup(url.hostname);
      out.push({
        id: 'dns',
        label: 'Name lookup',
        status: 'ok',
        detail: `${url.hostname} resolves to ${found.address}.`,
        ms: now() - began,
      });
    } catch (e) {
      out.push({
        id: 'dns',
        label: 'Name lookup',
        status: 'fail',
        detail: `This machine cannot find ${url.hostname} (${e instanceof Error ? e.message : 'lookup failed'}). Check its DNS settings.`,
      });
    }

    began = now();
    let serverDate: string | null = null;
    try {
      const res = await doFetch(url.origin, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      });
      serverDate = res.headers.get('date');
      out.push({
        id: 'https',
        label: url.protocol === 'https:' ? 'Secure connection to Kestrel' : 'Connection to Kestrel',
        status: 'ok',
        detail: `${url.origin} answered (HTTP ${res.status}).`,
        ms: now() - began,
      });
    } catch (e) {
      const why = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : 'failed';
      out.push({
        id: 'https',
        label: 'Connection to Kestrel',
        status: 'fail',
        detail: `Could not connect to ${url.origin} (${why}). Check that outbound HTTPS (port 443) to it is allowed by the firewall or proxy, and that nothing is replacing its certificate.`,
      });
    }

    if (serverDate) {
      const skew = Date.parse(serverDate) - now();
      const seconds = Math.round(Math.abs(skew) / 1000);
      out.push({
        id: 'clock',
        label: 'Clock',
        status: Math.abs(skew) > SKEW_WARN_MS ? 'warn' : 'ok',
        detail:
          Math.abs(skew) > SKEW_WARN_MS
            ? `This machine’s clock is about ${seconds} seconds ${skew > 0 ? 'behind' : 'ahead of'} Kestrel’s. Signed releases and sign-ins can be refused when it is this far out. Fix its time settings.`
            : `Within ${Math.max(seconds, 1)} second${seconds > 1 ? 's' : ''} of Kestrel’s.`,
      });
    }
  }

  const facts = hostFacts(opts.dataDir);
  if (facts.dataFreeGb !== null)
    out.push({
      id: 'disk',
      label: 'Disk space',
      status: facts.dataFreeGb < LOW_DISK_GB ? 'warn' : 'ok',
      detail: `${facts.dataFreeGb} GB free where the gateway keeps its data.`,
    });

  const probe = join(opts.dataDir, `.write-test-${process.pid}`);
  try {
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    out.push({ id: 'write', label: 'Data folder', status: 'ok', detail: 'The gateway can write to its data folder.' });
  } catch (e) {
    out.push({
      id: 'write',
      label: 'Data folder',
      status: 'fail',
      detail: `The gateway cannot write to ${opts.dataDir} (${e instanceof Error ? e.message : 'error'}). Its identity and buffered data cannot be saved.`,
    });
  }

  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (proxy)
    out.push({
      id: 'proxy',
      label: 'Proxy',
      status: 'info',
      detail:
        'A proxy is set in this machine’s environment. The gateway may not use it automatically, so make sure its traffic to Kestrel is allowed to go out directly.',
    });
  return out;
}

export interface LogLine {
  time: string;
  level: LogLevel;
  message: string;
  extra: string;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const TAIL_BYTES = 512 * 1024;

/** The newest lines of the gateway's log, newest first, at or above `min`. Reads only the end of the file. */
export function tailLog(file: string, max: number, min: LogLevel = 'info'): LogLine[] {
  if (!existsSync(file)) return [];
  let text: string;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
    // The first line of a partial read may be cut in half.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch {
    return [];
  }
  const lines: LogLine[] = [];
  for (const raw of text.split('\n').reverse()) {
    if (!raw.trim()) continue;
    let line: LogLine;
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      const { time, level, message, ...rest } = o;
      const lv = (typeof level === 'string' && level in ORDER ? level : 'info') as LogLevel;
      line = {
        time: typeof time === 'string' ? time : '',
        level: lv,
        message: typeof message === 'string' ? message : raw.slice(0, 200),
        extra: Object.keys(rest).length ? JSON.stringify(rest) : '',
      };
    } catch {
      line = { time: '', level: 'info', message: raw.slice(0, 300), extra: '' };
    }
    if (ORDER[line.level] < ORDER[min]) continue;
    lines.push(line);
    if (lines.length >= max) break;
  }
  return lines;
}
