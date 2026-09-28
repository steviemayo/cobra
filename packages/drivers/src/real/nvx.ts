import type { Device, DeviceCommand } from '@kestrel/model';
import { BaseDriver } from './base';
import { CresNextSession as NvxSession, dig, isRecord } from './cresnext';
import type { DriverContext } from './types';

// Crestron DM-NVX as a virtual video matrix. The room's matrix device stands for a set of NVX
// endpoints: each input port is an encoder (E30, ...) and each output port a decoder (D30, ...).
// Routing an input to an output points the decoder at the encoder's stream, using the DM NVX REST
// API (CresNext) over HTTPS with the device's own login.
//
// Settings:
//   username, password           the NVX logon (authentication is on by default)
//   inputs:  { "<input port id>":  { "host": "10.0.0.11" } }     encoders
//   outputs: { "<output port id>": { "host": "10.0.0.12" } }     decoders
//   (an endpoint may also give its own "port")
//   protocol ("https"), port (443), allowSelfSigned (true: NVX ships with a self-signed
//   certificate), pollMs (5000), timeoutMs (4000)
//
// Wire details, from the DM NVX REST API manual: log in by POSTing `login=<u>&&passwd=<p>` to
// /userlogin.html and keep the cookies it sets; read with GET /Device/<Object>; write with
// POST /Device and a partial {"Device": {...}} body; a negative StatusId in the reply is a failure.

interface Endpoint {
  host: string;
  port?: number;
}
// One session class for every CresNext device (login, cookies, re-login on 401/403 or a redirect to
// the login page, writes): see cresnext.ts. These names stay for existing importers.
export { NvxSession, dig, isRecord };

export class NvxDriver extends BaseDriver {
  private readonly sessions = new Map<string, NvxSession>();
  private readonly streamIds = new Map<string, string>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(device: Device, ctx: DriverContext) {
    super(device, ctx);
    this.state.online = false;
  }

  private endpoints(kind: 'inputs' | 'outputs'): Map<string, Endpoint> {
    const raw = this.setting<Record<string, Endpoint>>(kind, {});
    return new Map(
      Object.entries(raw).filter(([, e]) => isRecord(e) && typeof e.host === 'string' && e.host),
    );
  }

  private session(e: Endpoint): NvxSession {
    const protocol = this.setting<'http' | 'https'>('protocol', 'https');
    const port = e.port ?? this.setting<number>('port', protocol === 'http' ? 80 : 443);
    const key = `${e.host}:${port}`;
    let s = this.sessions.get(key);
    if (!s) {
      s = new NvxSession(e.host, {
        protocol,
        port,
        username: this.setting<string>('username', 'admin'),
        password: this.setting<string>('password', ''),
        timeoutMs: this.setting<number>('timeoutMs', 4000),
        allowSelfSigned: this.setting<boolean>('allowSelfSigned', true),
      });
      this.sessions.set(key, s);
    }
    return s;
  }

  override start() {
    if (this.endpoints('inputs').size + this.endpoints('outputs').size === 0) return;
    void this.refresh();
    this.poller = setInterval(() => void this.refresh(), this.setting<number>('pollMs', 5000));
    this.poller.unref?.();
  }

  override close() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }

  /** The id an encoder's stream is known by, which is what a decoder is pointed at. */
  private async streamId(e: Endpoint, fresh = false): Promise<string> {
    const host = `${e.host}:${e.port ?? ''}`;
    const cached = this.streamIds.get(host);
    if (cached && !fresh) return cached;
    const streams = dig(
      await this.session(e).get('/Device/StreamTransmit'),
      'Device',
      'StreamTransmit',
      'Streams',
    );
    const first = Array.isArray(streams) ? streams.find(isRecord) : undefined;
    const id = first && (first.UUID ?? first.Uuid ?? first.UniqueId);
    if (typeof id !== 'string' || !id) throw new Error(`${e.host} did not report a stream`);
    this.streamIds.set(host, id);
    return id;
  }

  /** Reads every endpoint: which encoder each decoder shows, and whether each encoder has a signal. */
  private async refresh() {
    if (this.busy) return;
    this.busy = true;
    try {
      const inputs = this.endpoints('inputs');
      const outputs = this.endpoints('outputs');
      const byStream = new Map<string, string>();
      const signal: Record<string, boolean> = {};
      const routes: Record<string, string | null> = {};
      let allUp = true;

      await Promise.all([
        ...[...inputs].map(async ([port, e]) => {
          try {
            byStream.set(await this.streamId(e, true), port);
            const ports = dig(
              await this.session(e).get('/Device/AudioVideoInputOutput'),
              'Device',
              'AudioVideoInputOutput',
              'Inputs',
            );
            const first = Array.isArray(ports) ? ports.find(isRecord) : undefined;
            const p = first && Array.isArray(first.Ports) ? first.Ports.find(isRecord) : undefined;
            if (p && typeof p.IsSyncDetected === 'boolean') signal[port] = p.IsSyncDetected;
          } catch {
            allUp = false;
          }
        }),
        ...[...outputs].map(async ([port, e]) => {
          try {
            const r = dig(
              await this.session(e).get('/Device/AvRouting'),
              'Device',
              'AvRouting',
              'Routes',
            );
            const first = Array.isArray(r) ? r.find(isRecord) : undefined;
            routes[port] = typeof first?.VideoSource === 'string' ? first.VideoSource : null;
          } catch {
            allUp = false;
          }
        }),
      ]);

      this.update((s) => {
        s.online = allUp;
        if (allUp) {
          s.signal = signal;
          s.routes = Object.fromEntries(
            Object.entries(routes).map(([out, src]) => [out, (src && byStream.get(src)) || null]),
          );
        }
      });
    } finally {
      this.busy = false;
    }
  }

  async send(command: DeviceCommand): Promise<void> {
    switch (command.type) {
      case 'route': {
        const enc = this.endpoints('inputs').get(command.inputPortId);
        const dec = this.endpoints('outputs').get(command.outputPortId);
        if (!enc) this.fail(`input ${command.inputPortId} has no encoder configured`);
        if (!dec) this.fail(`output ${command.outputPortId} has no decoder configured`);
        try {
          const set = async (fresh: boolean) => {
            const id = await this.streamId(enc, fresh);
            await this.session(dec).set({
              AvRouting: { Routes: [{ VideoSource: id, AudioSource: id }] },
            });
          };
          // A cached stream id can go stale if the encoder was replaced: look it up again once.
          await set(false).catch(() => set(true));
        } catch (e) {
          this.update((s) => {
            s.online = false;
          });
          this.fail(e instanceof Error ? e.message : String(e));
        }
        this.update((s) => {
          s.online = true;
          s.routes[command.outputPortId] = command.inputPortId;
        });
        return;
      }
      case 'power':
      case 'select_input':
        return;
      default:
        this.fail(`does not support "${command.type}"`);
    }
  }
}
