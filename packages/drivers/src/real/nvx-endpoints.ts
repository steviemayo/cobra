import type { Device, DeviceCommand } from '@kestrel/model';
import { BaseDriver } from './base';
import { NvxSession, dig, isRecord } from './nvx';
import type { DriverContext } from './types';

// Crestron NVX encoders and decoders as ordinary devices in a room (docs/driver-classes.md, "Video
// switching (AVoIP)"). Each has its own address and login. The virtual switcher (`avoip.ts`) asks
// an encoder where its stream is, points a decoder at it and waits until the decoder is receiving.
// Wire details are the same as the older one-device NVX driver: the CresNext REST API over HTTPS.
//
// Settings: host, username, password, protocol ("https"), port (443), allowSelfSigned (true),
// pollMs (5000), timeoutMs (4000).

abstract class NvxEndpoint extends BaseDriver {
  protected readonly session: NvxSession;
  private poller: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(device: Device, ctx: DriverContext) {
    super(device, ctx);
    this.state.online = false;
    const protocol = this.setting<'http' | 'https'>('protocol', 'https');
    this.session = new NvxSession(this.setting<string>('host', ''), {
      protocol,
      port: this.setting<number>('port', protocol === 'http' ? 80 : 443),
      username: this.setting<string>('username', 'admin'),
      password: this.setting<string>('password', ''),
      timeoutMs: this.setting<number>('timeoutMs', 4000),
      allowSelfSigned: this.setting<boolean>('allowSelfSigned', true),
    });
  }

  /** Read this endpoint and fold what it says into state. Rejects if it cannot be reached. */
  protected abstract read(): Promise<void>;

  override start() {
    if (!this.setting<string>('host', '')) return;
    void this.poll();
    this.poller = setInterval(() => void this.poll(), this.setting<number>('pollMs', 5000));
    this.poller.unref?.();
  }

  override close() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.session.close();
  }

  private async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.read();
      this.update((s) => {
        s.online = true;
      });
    } catch {
      this.update((s) => {
        s.online = false;
      });
    } finally {
      this.busy = false;
    }
  }
}

export class NvxEncoderDriver extends NvxEndpoint {
  /** Where the stream this encoder makes can be picked up: the id a decoder is pointed at. */
  async streamLocation(): Promise<string> {
    const streams = dig(await this.session.get('/Device/StreamTransmit'), 'Device', 'StreamTransmit', 'Streams');
    const first = Array.isArray(streams) ? streams.find(isRecord) : undefined;
    const id = first && (first.UUID ?? first.Uuid ?? first.UniqueId);
    if (typeof id !== 'string' || !id) this.fail('did not report a stream');
    this.update((s) => {
      s.online = true;
      s.streamLocation = id;
    });
    return id;
  }

  protected async read() {
    const location = await this.streamLocation();
    const inputs = dig(await this.session.get('/Device/AudioVideoInputOutput'), 'Device', 'AudioVideoInputOutput', 'Inputs');
    const first = Array.isArray(inputs) ? inputs.find(isRecord) : undefined;
    const port = first && Array.isArray(first.Ports) ? first.Ports.find(isRecord) : undefined;
    const inPort = this.device.ports.find((p) => p.direction === 'in')?.id;
    this.update((s) => {
      s.streamLocation = location;
      if (inPort && port && typeof port.IsSyncDetected === 'boolean') s.signal[inPort] = port.IsSyncDetected;
    });
  }

  async send(command: DeviceCommand): Promise<void> {
    if (command.type === 'power' || command.type === 'select_input' || command.type === 'route') return;
    this.fail(`does not support "${command.type}"`);
  }
}

export class NvxDecoderDriver extends NvxEndpoint {
  /** What it was last pointed at, so a stream that is not the one wanted does not count as connected. */
  private target: string | null | undefined;

  protected async read() {
    const routes = dig(await this.session.get('/Device/AvRouting'), 'Device', 'AvRouting', 'Routes');
    const first = Array.isArray(routes) ? routes.find(isRecord) : undefined;
    const source = typeof first?.VideoSource === 'string' && first.VideoSource ? first.VideoSource : undefined;
    this.update((s) => {
      if (source) s.streamLocation = source;
      else delete s.streamLocation;
      s.streamConnected = !!source && (this.target == null || source === this.target);
    });
  }

  async send(command: DeviceCommand): Promise<void> {
    switch (command.type) {
      case 'set_stream': {
        const id = command.location ?? '';
        try {
          await this.session.set({ AvRouting: { Routes: [{ VideoSource: id, AudioSource: id }] } });
        } catch (e) {
          this.update((s) => {
            s.online = false;
          });
          this.fail(e instanceof Error ? e.message : String(e));
        }
        this.target = command.location;
        this.update((s) => {
          s.online = true;
          if (command.location) s.streamLocation = command.location;
          else delete s.streamLocation;
          s.streamConnected = !!command.location;
        });
        return;
      }
      case 'power':
      case 'select_input':
      case 'route':
        return;
      default:
        this.fail(`does not support "${command.type}"`);
    }
  }
}
