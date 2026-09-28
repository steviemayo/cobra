import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ControlPoint, Device, DeviceDetailSection } from '@kestrel/model';
import { DeviceDetails } from '@kestrel/model';
import { Crestron4SeriesDriver } from './crestron-4series';
import { parseJoinAddress, parseJoinValue } from './crestron-console';
import { CrestronFlexDriver, flexOccupied } from './crestron-flex';
import { CrestronOccupancyDriver, meansChange } from './crestron-occupancy';
import { CrestronTswDriver } from './crestron-tsw';
import { digPath } from './cresnext';
import { NvxDecoderDriver, NvxEncoderDriver } from './nvx-endpoints';
import { BUILT_IN_DRIVER_IDS, createDriver } from './registry';
import type { DeviceDriver, DriverContext } from './types';

// The details pages for Crestron units, and the Flex / occupancy / NVX drivers behind them. The
// trees are shaped like what real units answered (an RMC4 and a TS-1070, see docs/decisions.md,
// Step R); every identifier in them is made up.

const ctx: DriverContext = { log: () => undefined };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await wait(15);
  }
}

const closers: { close: () => void }[] = [];
const drivers: DeviceDriver[] = [];
afterEach(() => {
  drivers.splice(0).forEach((d) => d.close());
  closers.splice(0).forEach((s) => s.close());
});

const device = (
  category: Device['category'],
  driverId: string,
  settings: Record<string, unknown>,
  points: ControlPoint[] = [],
): Device => ({
  id: 'unit',
  name: 'Unit',
  category,
  ports: [],
  extraCapabilities: [],
  settings,
  control: { kind: 'driver', driverId },
  points,
});

// ---- A CresNext unit ------------------------------------------------------------------------

interface FakeUnit {
  port: number;
  tree: Record<string, unknown>;
  logins: number;
  expireNext: boolean;
  /** Full reads of /Device so far. */
  reads: number;
  /** Long-poll answers to give, oldest first; when empty a poll answers with a clock tick after a moment. */
  deltas: unknown[];
  close: () => void;
}

async function fakeUnit(tree: Record<string, unknown>): Promise<FakeUnit> {
  const fake: FakeUnit = {
    port: 0,
    tree,
    logins: 0,
    expireNext: false,
    reads: 0,
    deltas: [],
    close: () => undefined,
  };
  let authed = false;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      if (req.url === '/userlogin.html') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'set-cookie': ['TRACKID=abc; Path=/'] });
          return void res.end('login page');
        }
        if (body === 'login=admin&&passwd=pw' && req.headers.origin && req.headers.referer) {
          authed = true;
          fake.logins++;
          res.writeHead(200, { 'set-cookie': ['userstr=abc; Path=/'] });
          return void res.end();
        }
        res.writeHead(403);
        return void res.end();
      }
      if (!authed || !(req.headers.cookie ?? '').includes('userstr=abc') || fake.expireNext) {
        fake.expireNext = false;
        res.writeHead(302, { location: '/userlogin.html' });
        return void res.end();
      }
      const path = req.url!;
      if (path.endsWith('/Longpoll')) {
        const send = (d: unknown) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(d));
        };
        if (fake.deltas.length) return void send(fake.deltas.shift());
        return void setTimeout(
          () => send({ Device: { SystemClock: { CurrentTime: 'tick' } } }),
          250,
        );
      }
      if (req.method === 'GET') {
        if (path === '/Device') fake.reads++;
        const found = digPath({ Device: fake.tree }, path.slice(1).split('/').join('.'));
        if (found === undefined) {
          res.writeHead(404);
          return void res.end();
        }
        const wrapped = path
          .slice(1)
          .split('/')
          .reduceRight<unknown>((inner, key) => ({ [key]: inner }), found);
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify(wrapped));
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.port = (server.address() as { port: number }).port;
  fake.close = () => server.close();
  closers.push(fake);
  return fake;
}

const settings = (port: number, over: Record<string, unknown> = {}) => ({
  host: '127.0.0.1',
  port,
  protocol: 'http',
  username: 'admin',
  password: 'pw',
  pollMs: 100,
  timeoutMs: 1500,
  ...over,
});

const section = (details: DeviceDetailSection[] | undefined, title: string) =>
  details?.find((s) => s.title === title);
const row = (s: DeviceDetailSection | undefined, label: string) =>
  s?.rows.find((r) => r.label === label)?.value;

const info = (over: Record<string, unknown> = {}) => ({
  Manufacturer: 'Crestron',
  Model: 'RMC4',
  SerialNumber: 'TEST0000001',
  MacAddress: 'c4.42.68.00.00.01',
  Name: 'RMC4-TEST',
  DeviceVersion: '2.8006.00110',
  BuildDate: 'Jul 11 2025',
  RebootReason: 'manual',
  Devicekey: 'do-not-show-this',
  ...over,
});

const rmc4 = {
  DeviceInfo: info(),
  Ethernet: { HostName: 'RMC4-TEST' },
  Programs: {
    ProgramInstanceLibrary: {
      DeviceSlot1: {
        Slot: 1,
        Status: 'Started',
        RegistrationStatus: 'Registered',
        ProgramDetails: {
          SystemName: 'Test_Room_Code',
          FriendlyName: 'AV',
          ProgramFileName: 'Test_Room.smw',
          CompiledOn: '9/17/2026 2:53 PM',
          Programmer: 'AB',
          TargetDevice: 'CP4N',
          SourceFilePath: 'C:\\\\Users\\\\secret-person\\\\code.smw',
        },
        IpTable: {
          Entries: {
            '4': {
              IpId: '4',
              Model: 'TSW-770',
              Address: '127.0.0.1',
              Port: '41794',
              Status: 'OFFLINE',
            },
            '3': {
              IpId: '3',
              Model: 'TS-1070',
              Description: 'Bench panel',
              Address: '192.168.3.21',
              Port: '41794',
              Status: 'ONLINE',
            },
          },
        },
      },
      DeviceSlot2: {
        Slot: 2,
        Status: 'Stopped',
        RegistrationStatus: 'Unregistered',
        ProgramDetails: { ProgramFileName: 'No Program Loaded' },
      },
    },
  },
};

describe('a control processor’s details', () => {
  it('names the unit, the program in each slot and that program’s IP table, and nothing secret', async () => {
    const unit = await fakeUnit(rmc4);
    const d = new Crestron4SeriesDriver(
      device('control_processor', 'crestron-4series', settings(unit.port)),
      ctx,
    );
    drivers.push(d);
    d.start();
    await until(() => !!d.getState().details);
    const details = d.getState().details!;
    expect(DeviceDetails.safeParse(details).success).toBe(true);
    expect(details.map((s) => s.title)).toEqual(['Device', 'Program, slot 1', 'IP table, slot 1']);

    const dev = section(details, 'Device');
    expect(row(dev, 'Serial number')).toBe('TEST0000001');
    expect(row(dev, 'MAC address')).toBe('C4:42:68:00:00:01');
    expect(row(dev, 'Firmware')).toBe('2.8006.00110');

    const program = section(details, 'Program, slot 1');
    expect(row(program, 'Code name')).toBe('Test_Room_Code');
    expect(row(program, 'Status')).toBe('Started');
    expect(program?.rows.find((r) => r.label === 'Status')?.status).toBe('ok');

    const ip = section(details, 'IP table, slot 1');
    expect(row(ip, 'Connected')).toBe('1 of 2');
    expect(ip?.table?.columns).toEqual([
      'IP ID',
      'Model',
      'Description',
      'Address',
      'Port',
      'Status',
    ]);
    // Connected first, marked; an unused entry is not painted as a fault.
    expect(ip?.table?.rows.map((r) => r.cells[0])).toEqual(['3', '4']);
    expect(ip?.table?.rows.map((r) => r.status)).toEqual(['ok', undefined]);

    const everything = JSON.stringify(details);
    expect(everything).not.toContain('do-not-show-this');
    expect(everything).not.toContain('secret-person');
  });
});

describe('a touch panel’s details', () => {
  it('reports the screen, the project and the control system it connects to', async () => {
    const unit = await fakeUnit({
      DeviceInfo: info({
        Model: 'TS-1070',
        SerialNumber: 'TEST0000002',
        DeviceVersion: '3.003.0021',
      }),
      Display: { CurrentState: 'On', Lcd: { Brightness: 100, StandbyTimeoutMinutes: 60 } },
      ProximitySensor: { IsWakeOnProximityEnabled: true },
      ThirdPartyApplications: { Mode: 'User' },
      UiUserProject: { ProjectName: 'Bench UI', CompiledOn: '9/17/2026' },
      IpTableV2: {
        Entries: {
          '3': {
            IpId: '3',
            ModelName: 'RMC4',
            Address: '192.168.3.57',
            Port: 41794,
            Status: 'ONLINE',
          },
        },
      },
      Bluetooth: { IsEnabled: false },
    });
    const d = new CrestronTswDriver(
      device('touch_panel', 'crestron-tsw', settings(unit.port)),
      ctx,
    );
    drivers.push(d);
    d.start();
    await until(() => !!d.getState().details);
    const details = d.getState().details!;
    expect(details.map((s) => s.title)).toEqual([
      'Device',
      'Screen',
      'Project',
      'IP table',
      'Connectivity',
    ]);
    expect(row(section(details, 'Screen'), 'Screen off after (minutes)')).toBe('60');
    expect(row(section(details, 'Screen'), 'Wake on proximity')).toBe('true');
    expect(row(section(details, 'Project'), 'Project')).toBe('Bench UI');
    expect(section(details, 'IP table')?.table?.rows[0]?.cells).toEqual([
      '3',
      'RMC4',
      '',
      '192.168.3.57',
      '41794',
      'ONLINE',
    ]);
    expect(row(section(details, 'Connectivity'), 'Bluetooth')).toBe('Off');
  });
});

// ---- Occupancy sensor -----------------------------------------------------------------------

describe('a Crestron occupancy sensor', () => {
  const sensorTree = () => ({
    DeviceInfo: info({ Model: 'CEN-ODT-C-POE', SerialNumber: 'TEST0000003' }),
    OccupancySensor: {
      IsRoomOccupied: true,
      VacancyTimeout: 30,
      OccupiedSensitivity: 'High',
      Password: 'nope',
    },
  });

  it('is what a device asks for by driver id, and reports occupancy and what the sensor says about itself', async () => {
    expect(BUILT_IN_DRIVER_IDS).toEqual(
      expect.arrayContaining(['crestron-flex', 'crestron-occupancy']),
    );
    const unit = await fakeUnit(sensorTree());
    const d = createDriver(
      device('occupancy_sensor', 'crestron-occupancy', settings(unit.port, { pollMs: 60000 })),
      ctx,
    )!;
    expect(d).toBeInstanceOf(CrestronOccupancyDriver);
    drivers.push(d);
    d.start();
    await until(() => d.getState().occupied !== undefined);
    expect(d.getState().occupied).toBe(true);
    const sensor = section(d.getState().details, 'Occupancy sensor');
    expect(row(sensor, 'Vacancy Timeout')).toBe('30');
    expect(row(sensor, 'Occupied Sensitivity')).toBe('High');
    expect(JSON.stringify(d.getState().details)).not.toContain('nope');
  });

  it('notices a change at once from its long poll, without waiting for the regular poll', async () => {
    const unit = await fakeUnit(sensorTree());
    const d = new CrestronOccupancyDriver(
      device('occupancy_sensor', 'crestron-occupancy', settings(unit.port, { pollMs: 60000 })),
      ctx,
    );
    drivers.push(d);
    d.start();
    await until(() => d.getState().occupied === true);
    (unit.tree.OccupancySensor as Record<string, unknown>).IsRoomOccupied = false;
    unit.deltas.push({ Device: { OccupancySensor: { IsRoomOccupied: false } } });
    await until(() => d.getState().occupied === false, 3000);
  });

  it('does not read the whole sensor again for a clock tick alone', async () => {
    const unit = await fakeUnit(sensorTree());
    const d = new CrestronOccupancyDriver(
      device('occupancy_sensor', 'crestron-occupancy', settings(unit.port, { pollMs: 60000 })),
      ctx,
    );
    drivers.push(d);
    d.start();
    await until(() => d.getState().occupied === true);
    const before = unit.reads;
    await wait(1600);
    expect(unit.reads).toBe(before);
  });

  it('a long poll answer means a change only when it is about more than the clock', () => {
    expect(meansChange({ Device: { SystemClock: { CurrentTime: 'x' } } })).toBe(false);
    expect(meansChange({ Device: { OccupancySensor: { IsRoomOccupied: true } } })).toBe(true);
    expect(meansChange(null)).toBe(false);
  });
});

// ---- NVX ------------------------------------------------------------------------------------

describe('NVX encoders and decoders', () => {
  const nvxInfo = (model: string) => info({ Model: model, SerialNumber: 'TEST0000004' });

  it('an encoder reports its identity, mode, HDMI input and stream', async () => {
    const unit = await fakeUnit({
      DeviceInfo: nvxInfo('DM-NVX-E30'),
      DeviceSpecific: { DeviceMode: 'Transmitter' },
      StreamTransmit: {
        Streams: [{ UUID: 'stream-1', Status: 'Started', MulticastAddress: '239.1.1.1' }],
      },
      AudioVideoInputOutput: {
        Inputs: [
          {
            Ports: [
              {
                IsSyncDetected: true,
                HorizontalResolution: 1920,
                VerticalResolution: 1080,
                Hdcp: 'Active',
              },
            ],
          },
        ],
      },
    });
    const d = new NvxEncoderDriver(
      device('avoip_encoder', 'crestron-nvx-encoder', settings(unit.port)),
      ctx,
    );
    drivers.push(d);
    d.start();
    await until(() => !!d.getState().details);
    const details = d.getState().details!;
    expect(row(section(details, 'Device'), 'Serial number')).toBe('TEST0000004');
    expect(row(section(details, 'Role'), 'Mode')).toBe('Transmitter');
    const input = section(details, 'Input');
    expect(row(input, 'Sync Detected')).toBe('Yes');
    expect(row(input, 'Horizontal Resolution')).toBe('1920');
    expect(row(section(details, 'Stream'), 'Multicast Address')).toBe('239.1.1.1');
  });

  it('a decoder reports its mode and what it is routed to, and works without the stream object', async () => {
    const unit = await fakeUnit({
      DeviceInfo: nvxInfo('DM-NVX-D30'),
      AvRouting: { Routes: [{ VideoSource: 'stream-1', AudioSource: 'stream-1' }] },
    });
    const d = new NvxDecoderDriver(
      device('avoip_decoder', 'crestron-nvx-decoder', settings(unit.port)),
      ctx,
    );
    drivers.push(d);
    d.start();
    await until(() => !!d.getState().details);
    const details = d.getState().details!;
    expect(row(section(details, 'Role'), 'Mode')).toBe('Decoder');
    expect(row(section(details, 'Routing'), 'Video Source')).toBe('stream-1');
    expect(d.getState().streamConnected).toBe(true);
  });

  it('logs in again after the unit redirects an expired session, like the other Crestron units', async () => {
    const unit = await fakeUnit({
      DeviceInfo: nvxInfo('DM-NVX-D30'),
      AvRouting: { Routes: [{ VideoSource: 'stream-1' }] },
    });
    const d = new NvxDecoderDriver(
      device('avoip_decoder', 'crestron-nvx-decoder', settings(unit.port)),
      ctx,
    );
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    unit.expireNext = true;
    await until(() => unit.logins >= 2);
    await until(() => d.getState().online);
  });
});

// ---- Flex (Teams Room) ----------------------------------------------------------------------

/** A stand-in for the UC-Engine secure console (plain, since the tests need no certificate). */
async function fakeConsole(joins: Record<string, string>, over: { password?: string } = {}) {
  const password = over.password ?? 'pw';
  const commands: string[] = [];
  const server = net.createServer((sock) => {
    let stage: 'start' | 'user' | 'pass' | 'in' = 'start';
    let pending = '';
    sock.on('data', (c) => {
      pending += c.toString();
      let at: number;
      while ((at = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 2);
        if (stage === 'start') {
          stage = 'user';
          sock.write('\r\n\r\nLogin:');
        } else if (stage === 'user') {
          stage = 'pass';
          sock.write('*****\r\n\r\nPassword:');
        } else if (stage === 'pass') {
          if (line === password) {
            stage = 'in';
            sock.write('***\r\n\r\nUC-ENGINE>');
          } else {
            stage = 'user';
            sock.write('***\r\n\r\nLogin:');
          }
        } else {
          commands.push(line);
          const join = /^show(digital|serial|analog) (\d+)$/.exec(line);
          let out = '';
          if (line === 'version')
            out =
              'UC-ENGINE Unified Collaboration System [v1.22.00.405,%2506NAATEST] @E-908D6E959126';
          else if (line === 'uptime')
            out =
              'The system has been running for 0 days 11:41:25.0\r\nThe system last started on: Monday, September 28, 2026 at 02:50:15 ';
          else if (join) {
            const value = joins[`${join[1]![0]!.toUpperCase()}${join[2]}`];
            out =
              value === undefined
                ? `${join[1]![0]!.toUpperCase()}${join[1]!.slice(1)} Join ${join[2]}, Value 0 `
                : `Join ${join[2]}, Value ${value} `;
          }
          sock.write(`${line}\r\n\r\n${out}\r\n\r\nUC-ENGINE>`);
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push({ close: () => server.close() });
  return { port: (server.address() as { port: number }).port, commands };
}

describe('a Crestron Flex (Teams Room)', () => {
  const flexSettings = (port: number, over: Record<string, unknown> = {}) => ({
    host: '127.0.0.1',
    port,
    secure: false,
    username: 'admin',
    password: 'pw',
    pollMs: 100,
    timeoutMs: 1500,
    ...over,
  });

  it('reads the reserved joins into firmware, occupancy and the details page', async () => {
    const unit = await fakeConsole({
      D27766: '1',
      D27764: '1',
      D27767: '0',
      D27774: '1',
      D27797: '0',
      S27702: 'Healthy',
      S27703: 'Healthy',
      S27705: 'Unhealthy',
      S27706: 'Healthy',
      S33049: 'Idle',
      S27710: '5.6.210.0',
      S27722: 'Test Camera',
      A27702: '3',
      A17347: '100',
    });
    const d = createDriver(
      device('conference_system', 'crestron-flex', flexSettings(unit.port)),
      ctx,
    )!;
    expect(d).toBeInstanceOf(CrestronFlexDriver);
    drivers.push(d);
    d.start();
    await until(() => !!d.getState().details);
    const s = d.getState();
    expect(s.online).toBe(true);
    expect(s.firmware).toBe('1.22.00.405');
    // The join says empty but the camera counts three people: occupied.
    expect(s.occupied).toBe(true);
    expect(DeviceDetails.safeParse(s.details).success).toBe(true);
    expect(row(section(s.details, 'Device'), 'MAC address')).toBe('90:8D:6E:95:91:26');
    expect(row(section(s.details, 'Device'), 'Running for')).toBe('0 days 11:41:25.0');
    const app = section(s.details, 'Teams Rooms app');
    expect(row(app, 'State')).toBe('Idle');
    expect(row(app, 'Software version')).toBe('5.6.210.0');
    expect(app?.rows.find((r) => r.label === 'Teams signed in')?.status).toBe('ok');
    const peripherals = section(s.details, 'Peripherals');
    expect(peripherals?.rows.find((r) => r.label === 'Microphone')?.status).toBe('ok');
    expect(peripherals?.rows.find((r) => r.label === 'Camera (Test Camera)')?.status).toBe('bad');
    expect(row(section(s.details, 'Room'), 'People counted')).toBe('3');
  });

  it('stays offline with the wrong password', async () => {
    const unit = await fakeConsole({}, { password: 'right' });
    const d = new CrestronFlexDriver(
      device('conference_system', 'crestron-flex', flexSettings(unit.port)),
      ctx,
    );
    drivers.push(d);
    d.start();
    await wait(500);
    expect(d.getState().online).toBe(false);
  });

  it('reads any reserved join as a control point, to watch or to verify', async () => {
    const unit = await fakeConsole({ S27702: 'Unhealthy' });
    const points: ControlPoint[] = [
      {
        id: 'mic',
        name: 'Microphone',
        type: 'generic',
        address: { join: 'S27702' },
        watch: { expect: 'Healthy', severity: 'warning' },
      },
    ];
    const d = new CrestronFlexDriver(
      device('conference_system', 'crestron-flex', flexSettings(unit.port), points),
      ctx,
    );
    drivers.push(d);
    d.start();
    await until(() => d.getState().points.mic !== undefined);
    expect(d.getState().points.mic).toBe('Unhealthy');
    expect(await d.readPoint({ type: 'generic', address: { join: 'D27767' } })).toEqual({
      value: false,
    });
    await expect(d.readPoint({ type: 'generic', address: { join: 'nonsense' } })).rejects.toThrow(
      'reserved join',
    );
  });

  it('accepts no commands: it is monitoring only', async () => {
    const d = new CrestronFlexDriver(
      device('conference_system', 'crestron-flex', flexSettings(1)),
      ctx,
    );
    await expect(d.send({ type: 'power', on: true })).rejects.toThrow('does not support');
  });

  it('parses join addresses and values, and combines the two occupancy signals', () => {
    expect(parseJoinAddress('D27767')).toEqual({ kind: 'digital', join: 27767 });
    expect(parseJoinAddress('serial 27702')).toEqual({ kind: 'serial', join: 27702 });
    expect(parseJoinAddress('a17347')).toEqual({ kind: 'analog', join: 17347 });
    expect(parseJoinAddress('x5')).toBeUndefined();
    expect(parseJoinValue('digital', 'Digital Join 27767, Value 1 ')).toBe(true);
    expect(parseJoinValue('analog', 'Analog Join 17347, Value 100 ')).toBe(100);
    expect(parseJoinValue('serial', 'Serial Join 27710, Value 5.6.210.0 ')).toBe('5.6.210.0');
    expect(flexOccupied(false, 0)).toBe(false);
    expect(flexOccupied(false, 2)).toBe(true);
    expect(flexOccupied(true, undefined)).toBe(true);
    expect(flexOccupied(undefined, undefined)).toBeUndefined();
  });
});
