import type {
  ControlPoint,
  DetailStatus,
  Device,
  DeviceCommand,
  DeviceDetailSection,
  PointReading,
} from '@kestrel/model';
import { BaseDriver } from './base';
import {
  CrestronConsole,
  parseJoinAddress,
  parseJoinValue,
  type JoinKind,
} from './crestron-console';
import type { DriverContext } from './types';

// A Crestron Flex UC-Engine running Microsoft Teams Rooms, watched (never driven) over the
// Crestron secure console: TLS on port 41797, logged in with the unit's admin account. The
// Teams Rooms app publishes its state on Crestron "reserved joins" (the list is in Crestron's
// reserved join reference), read here with showdigital / showserial / showanalog. Verified against
// a real unit.
//
// Settings: host, username ("admin"), password, port (41797), pollMs (30000), timeoutMs (6000).
//
// Reports firmware (the UC-Engine version) and whether the room is occupied, plus details for the
// portal's device page: the unit, the Teams Rooms app (state, sign-in, software and Windows
// builds), its peripherals (microphone, speaker, camera, display) and the room (occupancy, people
// count). A peripheral that stops being healthy can be alerted on by watching its reserved join
// as a control point, for example `{ "join": "S27702" }` expecting "Healthy".

const DIGITAL = {
  inMeeting: 27767,
  teamsSignedIn: 27766,
  exchangeSignedIn: 27764,
  cameraConnected: 27774,
  huddlyCameraConnected: 27729,
  teamsMode: 27727,
  roomOccupied: 27797,
} as const;
const SERIAL = {
  micStatus: 27702,
  speakerStatus: 27703,
  cameraStatus: 27705,
  displayStatus: 27706,
  appState: 33049,
  appVersion: 27710,
  windowsBuild: 27712,
  cameraName: 27722,
  versionState: 33050,
} as const;
const ANALOG = {
  peopleCount: 27702,
  micVolume: 17347,
  speakerVolume: 17348,
} as const;

interface Reading {
  version: string;
  uptime: string;
  d: Partial<Record<keyof typeof DIGITAL, boolean>>;
  s: Partial<Record<keyof typeof SERIAL, string>>;
  a: Partial<Record<keyof typeof ANALOG, number>>;
}

const health = (v: string | undefined): DetailStatus | undefined =>
  v === undefined
    ? undefined
    : /^healthy$|^ok$/i.test(v)
      ? 'ok'
      : /unhealthy|fail|error/i.test(v)
        ? 'bad'
        : 'warning';
const yes = (v: boolean | undefined, bad: DetailStatus = 'warning'): DetailStatus | undefined =>
  v === undefined ? undefined : v ? 'ok' : bad;
const onOff = (v: boolean | undefined) => (v === undefined ? undefined : v ? 'Yes' : 'No');

/**
 * The room counts as occupied if the room-occupied join says so or the camera counts anyone:
 * the two are independent on the hardware, and the join has been seen staying off while the camera
 * counted several people.
 */
export function flexOccupied(
  occupied: boolean | undefined,
  count: number | undefined,
): boolean | undefined {
  if (occupied === true || (count !== undefined && count > 0)) return true;
  if (occupied === false && count === 0) return false;
  return occupied;
}

export function flexDetails(r: Reading): DeviceDetailSection[] {
  const firmware = /\[v([\d.]+)/.exec(r.version)?.[1];
  const id = /@E-([0-9A-Fa-f]{12})/.exec(r.version)?.[1];
  const mac = id?.toUpperCase().match(/../g)?.join(':');
  const ran = /running for (.+?)\r?\n/i.exec(r.uptime + '\n')?.[1]?.trim();
  const since = /last started on:\s*(.+?)\s*$/im.exec(r.uptime)?.[1];
  const row = (label: string, value: string | undefined, status?: DetailStatus) =>
    value === undefined || value === '' ? [] : [{ label, value, ...(status ? { status } : {}) }];

  const occupied = flexOccupied(r.d.roomOccupied, r.a.peopleCount);
  const cam =
    r.d.cameraConnected === undefined && r.d.huddlyCameraConnected === undefined
      ? undefined
      : !!(r.d.cameraConnected || r.d.huddlyCameraConnected);
  return [
    {
      title: 'Device',
      rows: [
        { label: 'Model', value: 'Crestron Flex UC-Engine (Teams Rooms)' },
        ...row('Firmware', firmware),
        ...row('MAC address', mac),
        ...row('Running for', ran),
        ...row('Last started', since),
      ],
    },
    {
      title: 'Teams Rooms app',
      rows: [
        ...row('State', r.s.appState),
        ...row('In a meeting', onOff(r.d.inMeeting)),
        ...row('Teams signed in', onOff(r.d.teamsSignedIn), yes(r.d.teamsSignedIn)),
        ...row('Exchange signed in', onOff(r.d.exchangeSignedIn), yes(r.d.exchangeSignedIn)),
        ...row('Teams mode active', onOff(r.d.teamsMode)),
        ...row('Software version', r.s.appVersion),
        ...row('Version support', r.s.versionState),
        ...row('Windows build', r.s.windowsBuild),
      ],
    },
    {
      title: 'Peripherals',
      rows: [
        ...row('Microphone', r.s.micStatus, health(r.s.micStatus)),
        ...row('Microphone volume', r.a.micVolume?.toString()),
        ...row('Speaker', r.s.speakerStatus, health(r.s.speakerStatus)),
        ...row('Speaker volume', r.a.speakerVolume?.toString()),
        ...row(
          r.s.cameraName ? `Camera (${r.s.cameraName})` : 'Camera',
          r.s.cameraStatus,
          health(r.s.cameraStatus),
        ),
        ...row('Camera connected', onOff(cam), yes(cam)),
        ...row('Display', r.s.displayStatus, health(r.s.displayStatus)),
      ],
    },
    {
      title: 'Room',
      rows: [
        ...row('Occupied', onOff(occupied)),
        ...row('People counted', r.a.peopleCount?.toString()),
      ],
    },
  ].filter((s) => s.rows.length > 0);
}

export class CrestronFlexDriver extends BaseDriver {
  private console: CrestronConsole | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(device: Device, ctx: DriverContext) {
    super(device, ctx);
    this.state.online = false;
  }

  private session(): CrestronConsole {
    this.console ??= new CrestronConsole(this.setting<string>('host', ''), {
      port: this.setting<number>('port', 41797),
      username: this.setting<string>('username', 'admin'),
      password: this.setting<string>('password', ''),
      secure: this.setting<boolean>('secure', true),
      timeoutMs: this.setting<number>('timeoutMs', 6000),
    });
    return this.console;
  }

  override start() {
    if (!this.setting<string>('host', '')) return;
    void this.refresh();
    this.poller = setInterval(() => void this.refresh(), this.setting<number>('pollMs', 30000));
    this.poller.unref?.();
  }

  override close() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.console?.close();
    this.console = null;
  }

  private async join(kind: JoinKind, join: number) {
    return parseJoinValue(kind, await this.session().run(`show${kind} ${join}`));
  }

  private async read(): Promise<Reading> {
    const c = this.session();
    const reading: Reading = {
      version: await c.run('version'),
      uptime: await c.run('uptime'),
      d: {},
      s: {},
      a: {},
    };
    for (const [key, join] of Object.entries(DIGITAL)) {
      const v = await this.join('digital', join);
      if (typeof v === 'boolean') reading.d[key as keyof typeof DIGITAL] = v;
    }
    for (const [key, join] of Object.entries(SERIAL)) {
      const v = await this.join('serial', join);
      if (typeof v === 'string' && v) reading.s[key as keyof typeof SERIAL] = v;
    }
    for (const [key, join] of Object.entries(ANALOG)) {
      const v = await this.join('analog', join);
      if (typeof v === 'number') reading.a[key as keyof typeof ANALOG] = v;
    }
    return reading;
  }

  private pointJoin(point: Pick<ControlPoint, 'address'>) {
    const j = point.address.join;
    return typeof j === 'string' ? parseJoinAddress(j) : undefined;
  }

  private async refresh() {
    if (this.busy) return;
    this.busy = true;
    try {
      const reading = await this.read();
      const points: Record<string, number | boolean | string> = {};
      for (const p of this.device.points ?? []) {
        const at = this.pointJoin(p);
        const v = at ? await this.join(at.kind, at.join) : undefined;
        if (v !== undefined) points[p.id] = v;
      }
      const firmware = /\[v([\d.]+)/.exec(reading.version)?.[1];
      const occupied = flexOccupied(reading.d.roomOccupied, reading.a.peopleCount);
      this.update((s) => {
        s.online = true;
        s.points = points;
        if (firmware) s.firmware = firmware;
        if (occupied !== undefined) s.occupied = occupied;
        s.details = flexDetails(reading);
      });
    } catch (e) {
      this.ctx.log('warn', `${this.device.name}: ${e instanceof Error ? e.message : String(e)}`);
      this.console?.close();
      this.console = null;
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
    const at = this.pointJoin(point);
    if (!at) this.fail('this point needs a reserved join such as D27767, S27702 or A17347');
    const v = await this.join(at.kind, at.join);
    if (v === undefined) this.fail(`join ${at.join} did not answer`);
    return { value: v };
  }

  async send(command: DeviceCommand): Promise<void> {
    this.fail(`does not support "${command.type}" (monitoring only)`);
  }
}
