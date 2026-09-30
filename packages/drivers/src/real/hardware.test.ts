import http from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, type Device } from '@kestrel/model';
import { BlustreamAcm1000Driver } from './blustream-acm1000';
import { BlustreamDa11ablDriver } from './blustream-da11abl';
import { BUILT_IN_DRIVER_IDS, createDriver } from './registry';
import { NvxDriver } from './nvx';
import { QsysDriver } from './qsys';
import type { DeviceDriver, DriverContext } from './types';

const ctx: DriverContext = { log: () => undefined };
const base = STARTER_TEMPLATES[0]!.model;
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

const device = (id: string, driverId: string, settings: Record<string, unknown>): Device => ({
  ...base.devices.find((d) => d.id === id)!,
  control: { kind: 'driver', driverId },
  settings,
});

// ---- Q-SYS ----------------------------------------------------------------------------------

const ENGINE_STATUS = {
  Platform: 'Core 510i',
  State: 'Active',
  DesignName: 'SAF-MainPA',
  DesignCode: 'qALFilm6IcAz',
  IsRedundant: false,
  IsEmulator: true,
  Status: { Code: 0, String: 'OK' },
};

interface QrcServer {
  port: number;
  requests: { method: string; params: Record<string, unknown> }[];
  controls: Map<string, number | boolean>;
  connections: Socket[];
  close: () => void;
}

async function fakeQsys(
  opts: {
    user?: string;
    password?: string;
    silent?: boolean;
    pushEngineStatus?: boolean;
    noGain?: boolean;
  } = {},
): Promise<QrcServer> {
  const requests: QrcServer['requests'] = [];
  const controls = new Map<string, number | boolean>([
    ['gain', -20],
    ['mute', false],
  ]);
  const connections: Socket[] = [];
  const server: Server = createServer((socket) => {
    connections.push(socket);
    socket.setEncoding('utf8');
    let buf = '';
    let authed = !opts.user;
    socket.on('error', () => undefined);
    if (opts.pushEngineStatus)
      socket.write(JSON.stringify({ jsonrpc: '2.0', method: 'EngineStatus', params: ENGINE_STATUS }) + '\0');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\0')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i)) as {
          id: number;
          method: string;
          params: Record<string, unknown>;
        };
        buf = buf.slice(i + 1);
        requests.push({ method: msg.method, params: msg.params });
        if (opts.silent) continue;
        const reply = (result: unknown) =>
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\0');
        const fail = (message: string) =>
          socket.write(
            JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: 10, message } }) + '\0',
          );
        if (msg.method === 'Logon') {
          if (msg.params.User === opts.user && msg.params.Password === opts.password) {
            authed = true;
            reply(true);
          } else fail('Logon required');
          continue;
        }
        if (!authed) {
          fail('Logon required');
          continue;
        }
        if (msg.method === 'Component.Get' && opts.noGain) {
          fail(`Component '${String(msg.params.Name)}' does not exist`);
        } else if (msg.method === 'Component.Get') {
          const cs = (msg.params.Controls as { Name: string }[]).map((c) => ({
            Name: c.Name,
            Value: controls.get(c.Name),
          }));
          reply({ Name: msg.params.Name, Controls: cs });
        } else if (msg.method === 'Component.Set') {
          for (const c of msg.params.Controls as { Name: string; Value: number }[])
            controls.set(c.Name, c.Name === 'mute' ? c.Value === 1 : c.Value);
          reply({ Name: msg.params.Name, Controls: [] });
        } else if (msg.method === 'StatusGet') {
          reply(ENGINE_STATUS);
        } else if (msg.method === 'Component.GetComponents') {
          reply([
            { Name: 'gain', Type: 'gain' },
            { Name: 'Mic Mixer', Type: 'mixer' },
          ]);
        } else if (msg.method === 'Component.GetControls') {
          reply({
            Name: msg.params.Name,
            Controls: [
              { Name: 'gain', Type: 'Float', Value: controls.get('gain') },
              { Name: 'mute', Type: 'Boolean', Value: controls.get('mute') },
            ],
          });
        } else reply(true);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const s = {
    port,
    requests,
    controls,
    connections,
    close: () => {
      connections.forEach((c) => c.destroy());
      server.close();
    },
  };
  servers.push(s);
  return s;
}

const qsysDevice = (port: number, extra: Record<string, unknown> = {}) =>
  device('dsp', 'qsys-core', { host: '127.0.0.1', port, timeoutMs: 400, pollMs: 100, ...extra });

describe('Q-SYS Core driver', () => {
  it('is what a device asks for by driver id', () => {
    expect(BUILT_IN_DRIVER_IDS).toEqual(expect.arrayContaining(['qsys-core', 'crestron-dm-nvx']));
    expect(createDriver(qsysDevice(1), ctx)).toBeInstanceOf(QsysDriver);
    expect(createDriver(device('dsp', 'no-such-driver', {}), ctx)).toBeNull();
  });

  it('connects, reads volume and mute from the gain component, and reports itself online', async () => {
    const core = await fakeQsys();
    const d = new QsysDriver(qsysDevice(core.port), ctx);
    drivers.push(d);
    expect(d.getState().online).toBe(false);
    d.start();
    await until(() => d.getState().online);
    // -20 dB on a -40..0 scale is half way.
    expect(d.getState()).toMatchObject({ online: true, volume: 50, muted: false });
    expect(core.requests.find((r) => r.method === 'Component.Get')).toMatchObject({
      method: 'Component.Get',
      params: { Name: 'gain' },
    });
    expect(core.requests[0]).toMatchObject({ method: 'StatusGet' });
  });

  it('sets volume as dB on the configured scale, and mute', async () => {
    const core = await fakeQsys();
    const d = new QsysDriver(
      qsysDevice(core.port, { minDb: -60, maxDb: 0, gainComponent: 'room gain' }),
      ctx,
    );
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    await d.send({ type: 'volume', level: 75 });
    const set = core.requests.find((r) => r.method === 'Component.Set')!;
    expect(set.params).toEqual({ Name: 'room gain', Controls: [{ Name: 'gain', Value: -15 }] });
    expect(d.getState().volume).toBe(75);
    await d.send({ type: 'mute', muted: true });
    expect(core.controls.get('mute')).toBe(true);
    expect(d.getState().muted).toBe(true);
  });

  it('follows changes made on the Core, such as a knob on a wall controller', async () => {
    const core = await fakeQsys();
    const d = new QsysDriver(qsysDevice(core.port), ctx);
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    core.controls.set('gain', -10);
    core.controls.set('mute', true);
    await until(() => d.getState().volume === 75 && d.getState().muted === true);
  });

  it('reads engine status (platform, design, redundancy) into details, from StatusGet and from the unsolicited push', async () => {
    const core = await fakeQsys({ pushEngineStatus: true });
    const d = new QsysDriver(qsysDevice(core.port), ctx);
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    await until(() => !!d.getState().details?.length);
    expect(d.getState().details).toMatchObject([
      {
        title: 'Q-SYS Core',
        rows: expect.arrayContaining([
          { label: 'Platform', value: 'Core 510i' },
          { label: 'Design', value: 'SAF-MainPA' },
          { label: 'Engine status', value: 'OK', status: 'ok' },
        ]),
      },
    ]);
    expect(core.requests.some((r) => r.method === 'StatusGet')).toBe(true);
  });

  it('lists components and one component’s controls, for a pick-list', async () => {
    const core = await fakeQsys();
    const d = new QsysDriver(qsysDevice(core.port), ctx);
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    await expect(d.discoverComponents()).resolves.toEqual([
      { name: 'gain', type: 'gain' },
      { name: 'Mic Mixer', type: 'mixer' },
    ]);
    await expect(d.discoverControls('gain')).resolves.toEqual([
      { name: 'gain', type: 'Float', value: -20 },
      { name: 'mute', type: 'Boolean', value: false },
    ]);
  });

  it('stays online when the design has no gain component: the Core answered, it just has nothing to read', async () => {
    const core = await fakeQsys({ noGain: true });
    const d = new QsysDriver(qsysDevice(core.port), ctx);
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    await wait(300);
    expect(d.getState().online).toBe(true);
  });

  it('logs on when the Core asks for credentials, and stays offline when they are wrong', async () => {
    const core = await fakeQsys({ user: 'kestrel', password: 'secret' });
    const good = new QsysDriver(
      qsysDevice(core.port, { username: 'kestrel', password: 'secret' }),
      ctx,
    );
    drivers.push(good);
    good.start();
    await until(() => good.getState().online);
    expect(core.requests[0]).toMatchObject({
      method: 'Logon',
      params: { User: 'kestrel', Password: 'secret' },
    });

    const bad = new QsysDriver(
      qsysDevice(core.port, { username: 'kestrel', password: 'nope' }),
      ctx,
    );
    drivers.push(bad);
    bad.start();
    await wait(400);
    expect(bad.getState().online).toBe(false);
  });

  it('loads a snapshot for a preset, and sets a named control', async () => {
    const core = await fakeQsys();
    const d = new QsysDriver(qsysDevice(core.port, { snapshotBank: 2 }), ctx);
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    await d.send({ type: 'preset', name: 'Presentation' });
    expect(core.requests.find((r) => r.method === 'Snapshot.Load')!.params).toMatchObject({
      Name: 'Presentation',
      Bank: 2,
    });
    await d.send({ type: 'command', name: 'control.Mic Mute', args: { value: 1 } });
    expect(core.requests.find((r) => r.method === 'Control.Set')!.params).toEqual({
      Name: 'Mic Mute',
      Value: 1,
    });
    await expect(d.send({ type: 'command', name: 'reboot', args: {} })).rejects.toThrow(
      'unknown command',
    );
  });

  it('fixed routing and power are accepted and do nothing; unsupported commands say so', async () => {
    const core = await fakeQsys();
    const d = new QsysDriver(qsysDevice(core.port), ctx);
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    const before = core.requests.length;
    await d.send({ type: 'power', on: true });
    await d.send({ type: 'route', inputPortId: 'in1', outputPortId: 'out1' });
    expect(core.requests.length).toBe(before);
    await expect(d.send({ type: 'record', on: true })).rejects.toThrow('does not support');
  });

  it('fails a command that gets no answer, and goes offline when the connection drops, then reconnects', async () => {
    const silent = await fakeQsys({ silent: true });
    const quiet = new QsysDriver(qsysDevice(silent.port), ctx);
    drivers.push(quiet);
    quiet.start();
    await wait(100);
    await expect(quiet.send({ type: 'mute', muted: true })).rejects.toThrow('did not respond');

    const core = await fakeQsys();
    const d = new QsysDriver(qsysDevice(core.port), ctx);
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    core.connections.forEach((c) => c.destroy());
    await until(() => !d.getState().online);
    await until(() => d.getState().online, 6000);
  }, 15_000);

  it('handles replies split across packets and several replies in one packet', async () => {
    const core = await fakeQsys();
    const d = new QsysDriver(qsysDevice(core.port), ctx);
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    // A burst of commands in flight at once all resolve.
    await Promise.all([1, 2, 3, 4].map((n) => d.send({ type: 'volume', level: n * 10 })));
    expect(core.requests.filter((r) => r.method === 'Component.Set')).toHaveLength(4);
  });
});

// ---- Crestron DM-NVX --------------------------------------------------------------------------

interface NvxUnit {
  uuid?: string;
  sync?: boolean;
  routeSource?: string;
}
interface FakeNvx {
  port: number;
  log: { method: string; url: string; body: string }[];
  logins: number;
  unit: NvxUnit;
  failRoute: boolean;
  close: () => void;
}

async function fakeNvx(unit: NvxUnit, opts: { user: string; password: string }): Promise<FakeNvx> {
  const log: FakeNvx['log'] = [];
  const state = { logins: 0 };
  const fake = { unit, failRoute: false } as FakeNvx;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      log.push({ method: req.method!, url: req.url!, body });
      const json = (o: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (req.url === '/userlogin.html') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'set-cookie': ['userstr=; Path=/; Secure; HttpOnly'] });
          return void res.end('login page');
        }
        if (body === `login=${opts.user}&&passwd=${opts.password}`) {
          state.logins++;
          fake.logins = state.logins;
          res.writeHead(200, {
            'set-cookie': [
              'userstr=abc; Path=/',
              'userid=admin; Path=/',
              'iv=1; Path=/',
              'tag=2; Path=/',
            ],
          });
          return void res.end('ok');
        }
        res.writeHead(403);
        return void res.end('bad login');
      }
      if (!(req.headers.cookie ?? '').includes('tag=2')) {
        res.writeHead(401);
        return void res.end();
      }
      if (req.method === 'GET' && req.url === '/Device/StreamTransmit')
        return json({
          Device: {
            StreamTransmit: {
              Streams: unit.uuid ? [{ UUID: unit.uuid, Status: 'Stream Started' }] : [],
            },
          },
        });
      if (req.method === 'GET' && req.url === '/Device/AudioVideoInputOutput')
        return json({
          Device: {
            AudioVideoInputOutput: {
              Inputs: [{ Ports: [{ IsSyncDetected: unit.sync ?? false }] }],
            },
          },
        });
      if (req.method === 'GET' && req.url === '/Device/AvRouting')
        return json({
          Device: {
            AvRouting: {
              Routes: [
                { VideoSource: unit.routeSource ?? '', AudioSource: unit.routeSource ?? '' },
              ],
            },
          },
        });
      if (req.method === 'POST' && req.url === '/Device') {
        const route = (
          JSON.parse(body) as { Device: { AvRouting?: { Routes: { VideoSource: string }[] } } }
        ).Device.AvRouting;
        if (fake.failRoute)
          return json({
            Actions: [
              {
                Operation: 'SetPartial',
                Results: [
                  {
                    Path: 'Device.AvRouting',
                    Property: 'Routes',
                    StatusId: -2,
                    StatusInfo: 'Bad source',
                  },
                ],
              },
            ],
          });
        if (route) unit.routeSource = route.Routes[0]!.VideoSource;
        return json({
          Actions: [
            {
              Operation: 'SetPartial',
              Results: [
                { Path: 'Device.AvRouting', Property: 'Routes', StatusId: 0, StatusInfo: 'OK' },
              ],
            },
          ],
        });
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.port = (server.address() as { port: number }).port;
  fake.log = log;
  fake.logins = 0;
  fake.close = () => {
    server.closeAllConnections();
    server.close();
  };
  servers.push(fake);
  return fake;
}

describe('Crestron DM-NVX driver', () => {
  const creds = { user: 'admin', password: 'pw' };
  async function rig() {
    const enc1 = await fakeNvx({ uuid: 'aaaa-1111', sync: true }, creds);
    const enc2 = await fakeNvx({ uuid: 'bbbb-2222', sync: false }, creds);
    const dec = await fakeNvx({}, creds);
    const settings = (over: Record<string, unknown> = {}) => ({
      protocol: 'http',
      username: 'admin',
      password: 'pw',
      timeoutMs: 800,
      pollMs: 150,
      inputs: {
        in1: { host: '127.0.0.1', port: enc1.port },
        in2: { host: '127.0.0.1', port: enc2.port },
      },
      outputs: { out1: { host: '127.0.0.1', port: dec.port } },
      ...over,
    });
    return { enc1, enc2, dec, settings };
  }
  const make = (settings: Record<string, unknown>) => {
    const d = new NvxDriver(device('matrix', 'crestron-dm-nvx', settings), ctx);
    drivers.push(d);
    return d;
  };

  it('is created from its driver id', () => {
    expect(createDriver(device('matrix', 'crestron-dm-nvx', {}), ctx)).toBeInstanceOf(NvxDriver);
  });

  it('logs in with the device’s cookie flow, then reads signal and routes from the endpoints', async () => {
    const r = await rig();
    const d = make(r.settings());
    d.start();
    await until(() => d.getState().online);
    expect(d.getState().signal).toEqual({ in1: true, in2: false });
    expect(r.enc1.logins).toBe(1);
    const login = r.enc1.log.find((l) => l.method === 'POST' && l.url === '/userlogin.html')!;
    expect(login.body).toBe('login=admin&&passwd=pw');
  });

  it('routes an encoder to a decoder by pointing the decoder at the encoder’s stream', async () => {
    const r = await rig();
    const d = make(r.settings());
    d.start();
    await until(() => d.getState().online);
    await d.send({ type: 'route', inputPortId: 'in2', outputPortId: 'out1' });
    const post = r.dec.log.find((l) => l.method === 'POST' && l.url === '/Device')!;
    expect(JSON.parse(post.body)).toEqual({
      Device: { AvRouting: { Routes: [{ VideoSource: 'bbbb-2222', AudioSource: 'bbbb-2222' }] } },
    });
    expect(d.getState().routes.out1).toBe('in2');
    // The next poll reads the same thing back from the decoder itself.
    await wait(400);
    expect(d.getState().routes.out1).toBe('in2');
    await d.send({ type: 'route', inputPortId: 'in1', outputPortId: 'out1' });
    await until(() => r.dec.unit.routeSource === 'aaaa-1111');
  });

  it('reports the matrix offline when an endpoint stops answering', async () => {
    const r = await rig();
    const d = make(r.settings());
    d.start();
    await until(() => d.getState().online);
    r.enc2.close();
    await until(() => !d.getState().online, 6000);
  });

  it('fails a route the decoder refuses, and one for a port with no endpoint', async () => {
    const r = await rig();
    const d = make(r.settings());
    d.start();
    await until(() => d.getState().online);
    r.dec.failRoute = true;
    await expect(
      d.send({ type: 'route', inputPortId: 'in1', outputPortId: 'out1' }),
    ).rejects.toThrow('Bad source');
    r.dec.failRoute = false;
    await expect(
      d.send({ type: 'route', inputPortId: 'nope', outputPortId: 'out1' }),
    ).rejects.toThrow('no encoder');
    await expect(
      d.send({ type: 'route', inputPortId: 'in1', outputPortId: 'nope' }),
    ).rejects.toThrow('no decoder');
    await expect(d.send({ type: 'volume', level: 5 })).rejects.toThrow('does not support');
  });

  it('goes online with the right password and stays offline with a wrong one', async () => {
    const r = await rig();
    const d = make(r.settings());
    d.start();
    await until(() => d.getState().online);
    expect(r.dec.logins).toBe(1);
    const wrong = make(r.settings({ password: 'wrong' }));
    wrong.start();
    await wait(500);
    expect(wrong.getState().online).toBe(false);
  });
});

// ---- Blustream DA11ABL-WP-V2 -------------------------------------------------------------------

interface WallPlateServer {
  port: number;
  sent: string[];
  btReply: string;
  close: () => void;
}

async function fakeWallPlate(btReply: string): Promise<WallPlateServer> {
  const sent: string[] = [];
  const state = { btReply };
  const server: Server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('error', () => undefined);
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        sent.push(line);
        if (line === 'BT SOURCE') socket.write(state.btReply);
        // Every other command gets no reply, matching the reference's undocumented replies.
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const s = { port, sent, btReply, close: () => server.close() };
  servers.push(s);
  return s;
}

const wallPlateDevice = (port: number) =>
  device('dsp', 'blustream-da11abl', { host: '127.0.0.1', port, pollMs: 100, timeoutMs: 400 });

describe('Blustream DA11ABL-WP-V2 driver', () => {
  it('is what a device asks for by driver id', () => {
    expect(BUILT_IN_DRIVER_IDS).toContain('blustream-da11abl');
    expect(createDriver(wallPlateDevice(1), ctx)).toBeInstanceOf(BlustreamDa11ablDriver);
  });

  it('routes by the port id\'s digit, mutes and sets volume without waiting for a reply', async () => {
    const wp = await fakeWallPlate('Connected\r\n');
    const d = new BlustreamDa11ablDriver(wallPlateDevice(wp.port), ctx);
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    await d.send({ type: 'route', inputPortId: 'in2', outputPortId: 'out1' });
    await d.send({ type: 'mute', muted: true });
    await d.send({ type: 'volume', level: 100 });
    await until(() => wp.sent.includes('OUT GAIN 0'));
    expect(wp.sent).toEqual(expect.arrayContaining(['IN SOURCE 2', 'OUT MUTE ON', 'OUT GAIN 0']));
    expect(d.getState()).toMatchObject({ muted: true, volume: 100, routes: { out1: 'in2' } });
  });

  it('reads Bluetooth connection status into details, and keeps the raw reply as a fallback', async () => {
    const wp = await fakeWallPlate('BT1: MyPhone Connected\r\n');
    const d = new BlustreamDa11ablDriver(wallPlateDevice(wp.port), ctx);
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    await until(() => !!d.getState().details?.length);
    expect(d.getState().details).toMatchObject([
      {
        title: 'Bluetooth',
        rows: expect.arrayContaining([
          { label: 'Bluetooth', value: 'Connected', status: 'ok' },
          { label: 'Paired device', value: 'MyPhone' },
        ]),
      },
    ]);
  });

  it('goes offline when nothing answers', async () => {
    const wp = await fakeWallPlate('');
    wp.close();
    const d = new BlustreamDa11ablDriver(wallPlateDevice(wp.port), ctx);
    drivers.push(d);
    d.start();
    await wait(200);
    expect(d.getState().online).toBe(false);
  });
});

// ---- Blustream ACM1000 --------------------------------------------------------------------------

interface AcmServer {
  port: number;
  sent: string[];
  statusReply: string;
  close: () => void;
}

async function fakeAcm(statusReply: string): Promise<AcmServer> {
  const sent: string[] = [];
  const server: Server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('error', () => undefined);
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        sent.push(line);
        if (line === 'STATUS') socket.write(statusReply);
        // OUT ... FR ... gets no reply, matching the reference's undocumented replies.
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const s = { port, sent, statusReply, close: () => server.close() };
  servers.push(s);
  return s;
}

const acmDevice = (port: number) =>
  device('dsp', 'blustream-acm1000', { host: '127.0.0.1', port, pollMs: 100, timeoutMs: 400 });

describe('Blustream ACM1000 driver', () => {
  it('is what a device asks for by driver id', () => {
    expect(BUILT_IN_DRIVER_IDS).toContain('blustream-acm1000');
    expect(createDriver(acmDevice(1), ctx)).toBeInstanceOf(BlustreamAcm1000Driver);
  });

  it('routes with zero-padded port numbers, without waiting for a reply', async () => {
    const acm = await fakeAcm('OK\r\n');
    const d = new BlustreamAcm1000Driver(acmDevice(acm.port), ctx);
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    await d.send({ type: 'route', inputPortId: 'in2', outputPortId: 'out12' });
    await until(() => acm.sent.includes('OUT 012 FR 002'));
    expect(d.getState().routes.out12).toBe('in2');
  });

  it('counts the inputs and outputs it sees in the status reply, and keeps the raw text', async () => {
    const acm = await fakeAcm('IN 001 Online\r\nIN 002 Online\r\nOUT 001 FR 001\r\nOUT 002 FR 001\r\n');
    const d = new BlustreamAcm1000Driver(acmDevice(acm.port), ctx);
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    await until(() => !!d.getState().details?.length);
    expect(d.getState().details).toMatchObject([
      {
        title: 'ACM1000',
        rows: expect.arrayContaining([
          { label: 'Inputs seen', value: '2 (1, 2)' },
          { label: 'Outputs seen', value: '2 (1, 2)' },
        ]),
      },
    ]);
  });

  it('goes offline when nothing answers', async () => {
    const acm = await fakeAcm('');
    acm.close();
    const d = new BlustreamAcm1000Driver(acmDevice(acm.port), ctx);
    drivers.push(d);
    d.start();
    await wait(200);
    expect(d.getState().online).toBe(false);
  });
});
