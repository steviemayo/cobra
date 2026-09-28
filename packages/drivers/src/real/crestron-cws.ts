import type {
  ControlPoint,
  Device,
  DeviceCommand,
  DeviceState,
  PointReading,
} from '@kestrel/model';
import { BaseDriver } from './base';
import { CresNextSession, digPath } from './cresnext';
import type { DriverContext } from './types';

// The Crestron "CresNext" CWS REST API, shared by DM-NVX (see nvx.ts), 4-series control processors
// (RMC4, MC4, CP4, ...) and TSW/TS touch panels: a single cookie-authenticated web server exposing
// its whole configuration as one JSON tree at GET /Device. Verified against real RMC4 and TS-1070
// units. Login and session handling live in cresnext.ts.

export { digPath };

/**
 * Shared machinery for a monitoring-only CresNext device (4-series processor, touch panel): one
 * GET /Device per poll, resolved against any control points the room configured (each addressed by
 * a dotted `path` into that tree), plus whatever else a subclass wants to read from the same tree.
 * Never sends anything: these are watched, not driven.
 */
export abstract class CrestronCwsMonitor extends BaseDriver {
  private session: CresNextSession | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(device: Device, ctx: DriverContext) {
    super(device, ctx);
    this.state.online = false;
  }

  protected get points(): ControlPoint[] {
    return this.device.points ?? [];
  }

  protected ensureSession(): CresNextSession {
    if (!this.session) {
      const protocol = this.setting<'http' | 'https'>('protocol', 'https');
      this.session = new CresNextSession(this.setting<string>('host', ''), {
        protocol,
        port: this.setting<number>('port', protocol === 'http' ? 80 : 443),
        username: this.setting<string>('username', 'admin'),
        password: this.setting<string>('password', ''),
        timeoutMs: this.setting<number>('timeoutMs', 4000),
        allowSelfSigned: this.setting<boolean>('allowSelfSigned', true),
      });
    }
    return this.session;
  }

  private pointPath(point: Pick<ControlPoint, 'address'>): string | undefined {
    const path = point.address.path;
    return typeof path === 'string' ? path : undefined;
  }

  /** Every configured point's value, read from an already-fetched tree. */
  private readPoints(tree: unknown): Record<string, number | boolean | string> {
    const values: Record<string, number | boolean | string> = {};
    for (const p of this.points) {
      const path = this.pointPath(p);
      if (!path) continue;
      const v = digPath(tree, path);
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        values[p.id] = v;
    }
    return values;
  }

  /** What a subclass reads from the tree beyond online/points (firmware, power, activeApp, ...). */
  protected abstract applyFeedback(tree: unknown, s: DeviceState): void;

  override start() {
    if (!this.setting<string>('host', '')) return;
    void this.refresh();
    this.poller = setInterval(() => void this.refresh(), this.setting<number>('pollMs', 15000));
    this.poller.unref?.();
  }

  override close() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.session?.close();
    this.session = null;
  }

  protected async refresh() {
    if (this.busy) return;
    this.busy = true;
    try {
      const tree = await this.ensureSession().get('/Device');
      const points = this.readPoints(tree);
      this.update((s) => {
        s.online = true;
        s.points = points;
        this.applyFeedback(tree, s);
      });
    } catch (e) {
      this.ctx.log('warn', `${this.device.name}: ${e instanceof Error ? e.message : String(e)}`);
      this.update((s) => {
        s.online = false;
      });
    } finally {
      this.busy = false;
    }
  }

  async readPoint(
    point: Pick<ControlPoint, 'type' | 'address' | 'min' | 'max'>,
  ): Promise<PointReading> {
    const path = this.pointPath(point);
    if (!path) this.fail('this point has no path set');
    const v = digPath(await this.ensureSession().get('/Device'), path);
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean')
      this.fail(`"${path}" was not found`);
    return { value: v };
  }

  async send(command: DeviceCommand): Promise<void> {
    this.fail(`does not support "${command.type}" (monitoring only)`);
  }
}
