import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ControlPoint, Device } from '@kestrel/model';
import { Crestron4SeriesDriver } from './crestron-4series';
import { CrestronTswDriver } from './crestron-tsw';
import { BUILT_IN_DRIVER_IDS, createDriver } from './registry';
import type { DeviceDriver, DriverContext } from './types';

// Fakes the Crestron "CresNext" CWS REST API these two drivers share with DM-NVX (nvx.ts), matching
// what real RMC4 and TS-1070 units actually do: a POST to /userlogin.html is refused (403) without
// Origin and Referer headers set to the unit's own URL, and an expired session shows up as a
// redirect back to /userlogin.html (not a 401/403 like NVX answers with).

const ctx: DriverContext = { log: () => undefined };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await wait(15);
  }
}

const servers: { close: () => void }[] = [];
const drivers: DeviceDriver[] = [];
afterEach(() => {
  drivers.splice(0).forEach((d) => d.close());
  servers.splice(0).forEach((s) => s.close());
});

const device = (
  category: 'control_processor' | 'touch_panel',
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

interface FakeUnit {
  port: number;
  log: { method: string; url: string }[];
  logins: number;
  expireNext: boolean;
  close: () => void;
}

async function fakeCrestron(
  creds: { user: string; password: string },
  tree: Record<string, unknown>,
  deviceDelayMs = 0,
): Promise<FakeUnit> {
  const fake: FakeUnit = { port: 0, log: [], logins: 0, expireNext: false, close: () => undefined };
  let authed = false;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      fake.log.push({ method: req.method!, url: req.url! });
      if (req.url === '/userlogin.html') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'set-cookie': ['TRACKID=abc; Path=/'] });
          return void res.end('login page');
        }
        if (!req.headers.origin || !req.headers.referer) {
          res.writeHead(403);
          return void res.end('missing origin/referer');
        }
        if (body === `login=${creds.user}&&passwd=${creds.password}`) {
          authed = true;
          fake.logins++;
          res.writeHead(200, { 'set-cookie': ['userstr=abc; Path=/'] });
          return void res.end();
        }
        res.writeHead(403);
        return void res.end('bad login');
      }
      const cookie = req.headers.cookie ?? '';
      if (!authed || !cookie.includes('userstr=abc') || fake.expireNext) {
        fake.expireNext = false;
        res.writeHead(302, { location: '/userlogin.html' });
        return void res.end();
      }
      if (req.method === 'GET' && req.url === '/Device') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void setTimeout(() => res.end(JSON.stringify({ Device: tree })), deviceDelayMs);
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.port = (server.address() as { port: number }).port;
  fake.close = () => server.close();
  servers.push(fake);
  return fake;
}

const CREDS = { user: 'admin', password: 'test-pw' };
const settings = (port: number, over: Record<string, unknown> = {}) => ({
  host: '127.0.0.1',
  port,
  protocol: 'http',
  username: CREDS.user,
  password: CREDS.password,
  pollMs: 150,
  timeoutMs: 800,
  ...over,
});

// Shaped like a real RMC4's payload (see docs/decisions.md, Step O; identifiers below are made up):
// one running program slot, whose IP table reports whether it can currently reach a TSW panel it is
// configured to talk to.
const rmc4Tree = {
  DeviceInfo: { Model: 'RMC4', DeviceVersion: '2.1.0', SerialNumber: 'TEST0000001' },
  Programs: {
    ProgramInstanceLibrary: {
      DeviceSlot1: {
        Status: 'Started',
        IpTable: {
          Entries: {
            '3': { Status: 'ONLINE', Model: 'TSW-770', Description: 'Panel 1' },
            '4': { Status: 'OFFLINE', Model: 'TSW-770', Description: 'Panel 2' },
          },
        },
      },
    },
  },
};

const tswTree = {
  DeviceInfo: { Model: 'TS-1070', DeviceVersion: '2.3.1', SerialNumber: 'TEST0000002' },
  Display: { CurrentState: 'On' },
  ThirdPartyApplications: { Mode: 'User' },
};

describe('Crestron 4-series control processor driver', () => {
  it('is what a device asks for by driver id', () => {
    expect(BUILT_IN_DRIVER_IDS).toEqual(
      expect.arrayContaining(['crestron-4series', 'crestron-tsw']),
    );
    expect(createDriver(device('control_processor', 'crestron-4series', {}), ctx)).toBeInstanceOf(
      Crestron4SeriesDriver,
    );
  });

  it('logs in with the headers the unit checks, then reports firmware and configured points', async () => {
    const unit = await fakeCrestron(CREDS, rmc4Tree);
    const points: ControlPoint[] = [
      {
        id: 'slot1',
        name: 'Program slot 1',
        type: 'generic',
        address: { path: 'Device.Programs.ProgramInstanceLibrary.DeviceSlot1.Status' },
      },
      {
        id: 'panel3',
        name: 'Gym panel reachable',
        type: 'generic',
        address: {
          path: 'Device.Programs.ProgramInstanceLibrary.DeviceSlot1.IpTable.Entries.3.Status',
        },
        watch: { expect: 'ONLINE', severity: 'warning' },
      },
    ];
    const d = new Crestron4SeriesDriver(
      device('control_processor', 'crestron-4series', settings(unit.port), points),
      ctx,
    );
    drivers.push(d);
    expect(d.getState().online).toBe(false);
    d.start();
    await until(() => d.getState().online);
    expect(d.getState().firmware).toBe('2.1.0');
    expect(d.getState().points).toEqual({ slot1: 'Started', panel3: 'ONLINE' });
    expect(unit.logins).toBe(1);
    const login = unit.log.find((l) => l.method === 'POST' && l.url === '/userlogin.html');
    expect(login).toBeDefined();
  });

  it('can read one point on demand, for the portal’s “verify” check', async () => {
    const unit = await fakeCrestron(CREDS, rmc4Tree);
    const d = new Crestron4SeriesDriver(
      device('control_processor', 'crestron-4series', settings(unit.port)),
      ctx,
    );
    drivers.push(d);
    const reading = await d.readPoint({
      type: 'generic',
      address: {
        path: 'Device.Programs.ProgramInstanceLibrary.DeviceSlot1.IpTable.Entries.4.Status',
      },
    });
    expect(reading).toEqual({ value: 'OFFLINE' });
  });

  it('logs itself in again after the unit redirects an expired session to the login page', async () => {
    const unit = await fakeCrestron(CREDS, rmc4Tree);
    const d = new Crestron4SeriesDriver(
      device('control_processor', 'crestron-4series', settings(unit.port)),
      ctx,
    );
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    unit.expireNext = true;
    await until(() => unit.logins >= 2);
    await until(() => d.getState().online);
  });

  it('stays offline with the wrong password', async () => {
    const unit = await fakeCrestron(CREDS, rmc4Tree);
    const d = new Crestron4SeriesDriver(
      device('control_processor', 'crestron-4series', settings(unit.port, { password: 'wrong' })),
      ctx,
    );
    drivers.push(d);
    d.start();
    await wait(400);
    expect(d.getState().online).toBe(false);
  });

  it('waits longer for a slow unit instead of going offline, and holds the longer wait', async () => {
    const unit = await fakeCrestron(CREDS, rmc4Tree, 350);
    const d = new Crestron4SeriesDriver(
      device('control_processor', 'crestron-4series', settings(unit.port, { timeoutMs: 150 })),
      ctx,
    );
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    // Online again on every later poll, not only the first: the wait stayed above the unit's delay
    await wait(600);
    expect(d.getState().online).toBe(true);
  });

  it('lists what the unit reports, IP table entries first, and leaves secrets out', async () => {
    const unit = await fakeCrestron(CREDS, {
      ...rmc4Tree,
      Ethernet: { HostName: 'rmc4' },
      Authentication: { Token: 'do-not-show' },
      Wifi: { Password: 'do-not-show' },
    });
    const d = new Crestron4SeriesDriver(
      device('control_processor', 'crestron-4series', settings(unit.port)),
      ctx,
    );
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    const found = await d.browsePoints();
    const entry = 'Device.Programs.ProgramInstanceLibrary.DeviceSlot1.IpTable.Entries';
    expect(found.points.slice(0, 2)).toEqual([
      {
        path: `${entry}.3.Status`,
        label: 'IP ID 3 · Panel 1 · TSW-770',
        group: 'IP table, slot 1',
        value: 'ONLINE',
        expect: 'ONLINE',
      },
      {
        path: `${entry}.4.Status`,
        label: 'IP ID 4 · Panel 2 · TSW-770',
        group: 'IP table, slot 1',
        value: 'OFFLINE',
        expect: 'ONLINE',
      },
    ]);
    const paths = found.points.map((p) => p.path);
    expect(paths).toContain('Device.Ethernet.HostName');
    expect(paths).toContain('Device.DeviceInfo.SerialNumber');
    expect(JSON.stringify(found)).not.toContain('do-not-show');
    // Each path is one the driver can read back as a control point.
    for (const p of found.points.slice(0, 5)) {
      const reading = await d.readPoint({ type: 'generic', address: { path: p.path } });
      expect(reading.value).toBe(p.value);
    }
  });

  it('will not list a unit that is offline', async () => {
    const unit = await fakeCrestron(CREDS, rmc4Tree);
    const d = new Crestron4SeriesDriver(
      device('control_processor', 'crestron-4series', settings(unit.port)),
      ctx,
    );
    drivers.push(d);
    await expect(d.browsePoints()).rejects.toThrow('offline');
  });

  it('accepts no commands: it is monitoring only', async () => {
    const unit = await fakeCrestron(CREDS, rmc4Tree);
    const d = new Crestron4SeriesDriver(
      device('control_processor', 'crestron-4series', settings(unit.port)),
      ctx,
    );
    drivers.push(d);
    await expect(d.send({ type: 'power', on: true })).rejects.toThrow('does not support');
  });
});

describe('Crestron TSW / TS touch panel driver', () => {
  it('is what a device asks for by driver id, and reports screen state and the running app', async () => {
    const unit = await fakeCrestron(CREDS, tswTree);
    const d = createDriver(device('touch_panel', 'crestron-tsw', settings(unit.port)), ctx)!;
    expect(d).toBeInstanceOf(CrestronTswDriver);
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    expect(d.getState()).toMatchObject({
      online: true,
      firmware: '2.3.1',
      power: 'on',
      activeApp: 'User',
    });
  });
});
