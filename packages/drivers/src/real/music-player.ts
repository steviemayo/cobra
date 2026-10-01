import http from 'node:http';
import https from 'node:https';
import type { Device, DeviceCommand, DeviceDetailSection } from '@kestrel/model';
import { assertDeviceAddress } from './address-guard';
import { BaseDriver } from './base';
import type { DriverContext } from './types';

// Shared machinery for a monitoring-only network music player (WiiM, Bluesound/BluOS): one HTTP
// poll on a timer, turned into the player's online state, what it is doing (playback, source, volume,
// mute) and a "Now playing" page for the portal's device page. Nothing is ever sent to the player.
//
// Track changes go in `details` and not in a feedback field on purpose: feedback changes are written
// to the device's history, and a title that changes every few minutes would fill it.

export interface HttpGetOptions {
  protocol: 'http' | 'https';
  port: number;
  timeoutMs: number;
  allowSelfSigned: boolean;
}

const MAX_BODY = 256 * 1024;

/** A connection the player dropped before answering: it closes idle sockets and has few to spare. */
const DROPPED = /socket hang up|ECONNRESET|EPIPE/;

/**
 * GET one path and resolve with the body. Rejects on a non-2xx answer, a timeout or an oversized
 * reply. A dropped connection is tried once more on a fresh one.
 */
export async function httpGet(host: string, path: string, o: HttpGetOptions): Promise<string> {
  try {
    return await httpGetOnce(host, path, o);
  } catch (e) {
    if (e instanceof Error && DROPPED.test(`${e.message} ${(e as NodeJS.ErrnoException).code ?? ''}`))
      return httpGetOnce(host, path, o);
    throw e;
  }
}

function httpGetOnce(host: string, path: string, o: HttpGetOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = o.protocol === 'https' ? https : http;
    const req = lib.request(
      {
        host,
        port: o.port,
        path,
        method: 'GET',
        // A new connection each time, closed after the answer: these players drop idle sockets,
        // and a reused one fails with "socket hang up".
        agent: false,
        headers: { connection: 'close' },
        timeout: o.timeoutMs,
        ...(o.protocol === 'https' ? { rejectUnauthorized: !o.allowSelfSigned } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY) req.destroy(new Error('reply too large'));
          else chunks.push(c);
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) reject(new Error(`answered ${status}`));
          else resolve(Buffer.concat(chunks).toString('utf8'));
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

/** What one poll learned about a player. A missing field is left off the player's state. */
export interface PlayerReading {
  playback?: string;
  playSource?: string;
  /** 0 to 100. */
  volume?: number;
  muted?: boolean;
  firmware?: string;
  details: DeviceDetailSection[];
}

type Row = DeviceDetailSection['rows'][number];

/** The rows of a "Now playing" page: whatever of these the player reported, in order. */
export function nowPlayingSection(fields: {
  state?: string;
  station?: string;
  title?: string;
  artist?: string;
  album?: string;
  source?: string;
  quality?: string;
}): DeviceDetailSection {
  const candidates: [string, string | undefined][] = [
    ['State', fields.state],
    ['Station', fields.station],
    ['Title', fields.title],
    ['Artist', fields.artist],
    ['Album', fields.album],
    ['Source', fields.source],
    ['Quality', fields.quality],
  ];
  const rows: Row[] = candidates.flatMap(([label, value]) =>
    value ? [{ label, value: value.slice(0, 200) }] : [],
  );
  return { title: 'Now playing', rows };
}

/** Text from a player with control characters removed, so a track title cannot carry anything but text. */
export const cleanText = (s: string): string =>
  [...s].filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f).join('').trim();

export const clampVolume = (n: number): number | undefined =>
  Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : undefined;

export abstract class MusicPlayerDriver extends BaseDriver {
  private poller: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private closed = false;

  constructor(device: Device, ctx: DriverContext) {
    super(device, ctx);
    this.state.online = false;
  }

  protected abstract readonly defaultPort: number;
  protected abstract readonly defaultProtocol: 'http' | 'https';

  /** Ask the player and say what it reported. Throws when it does not answer. */
  protected abstract read(): Promise<PlayerReading>;

  protected get host(): string {
    return this.setting<string>('host', '');
  }

  protected get httpOptions(): HttpGetOptions {
    const protocol = this.setting<'http' | 'https'>('protocol', this.defaultProtocol);
    return {
      protocol,
      port: this.setting<number>('port', this.defaultPort),
      timeoutMs: this.setting<number>('timeoutMs', 4000),
      allowSelfSigned: this.setting<boolean>('allowSelfSigned', true),
    };
  }

  protected get(path: string): Promise<string> {
    assertDeviceAddress(this.host, this.device.settings);
    return httpGet(this.host, path, this.httpOptions);
  }

  override start() {
    if (!this.host) return;
    this.closed = false;
    void this.poll();
    this.poller = setInterval(() => void this.poll(), this.setting<number>('pollMs', 5000));
    this.poller.unref?.();
  }

  override close() {
    this.closed = true;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  private async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await this.read();
      if (this.closed) return;
      this.update((s) => {
        s.online = true;
        s.playback = r.playback;
        s.playSource = r.playSource;
        s.volume = r.volume;
        s.muted = r.muted;
        if (r.firmware) s.firmware = r.firmware.slice(0, 100);
        s.details = r.details;
      });
    } catch (e) {
      if (this.closed) return;
      this.ctx.log('warn', `${this.device.name}: ${e instanceof Error ? e.message : String(e)}`);
      this.update((s) => {
        s.online = false;
      });
    } finally {
      this.busy = false;
    }
  }

  async send(command: DeviceCommand): Promise<void> {
    this.fail(`does not support "${command.type}" (monitoring only)`);
  }
}
