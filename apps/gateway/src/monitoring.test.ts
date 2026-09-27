import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, type GatewayCommand, type RoomModel } from '@kestrel/model';
import { CloudClient } from './cloud';
import type { GatewayConfig } from './config';
import { Gateway } from './gateway';
import { silentLogger } from './log';
import { RoomHost } from './room-host';
import { Store } from './store';
import { ENROLL_TOKEN, FakeCloud } from './test-support/fake-cloud';

const ROOM = '33333333-3333-4333-8333-333333333331';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await wait(15);
  }
}

let dir: string;
let cloud: FakeCloud;
let device: Server | null;
const running: { gateway: Gateway; host: RoomHost; store: Store }[] = [];

const listen = (server: Server, port = 0) =>
  new Promise<number>((r) =>
    server.listen(port, '127.0.0.1', () => r((server.address() as { port: number }).port)),
  );

function boot() {
  const cfg: GatewayConfig = {
    cloudUrl: cloud.url,
    enrollToken: ENROLL_TOKEN,
    dataDir: dir,
    panelPort: 0,
    panelHost: '127.0.0.1',
    panelDir: '',
    simulate: 'missing',
    logLevel: 'error',
    version: '0.0.0-test',
  };
  const store = new Store(join(dir, 'gateway.db'));
  const host = new RoomHost('missing', silentLogger, (e) => store.enqueue(e));
  const gateway = new Gateway(cfg, store, new CloudClient(cloud.url), host, silentLogger);
  running.push({ gateway, host, store });
  return { gateway, host, store };
}

/** A room whose DSP is a real TCP device on the given port; everything else is simulated. */
function modelWithDsp(port: number): RoomModel {
  const m = structuredClone(STARTER_TEMPLATES[0]!.model);
  for (const d of m.devices) delete d.control;
  const dsp = m.devices.find((d) => d.id === 'dsp')!;
  dsp.control = { kind: 'generic', protocol: 'tcp' };
  dsp.settings = { host: '127.0.0.1', port, timeoutMs: 150, probeIntervalMs: 40, commands: {} };
  return m;
}

/** A room whose display is a real PJLink projector on the given port; everything else is simulated. */
function modelWithProjector(port: number): RoomModel {
  const m = structuredClone(STARTER_TEMPLATES[0]!.model);
  for (const d of m.devices) delete d.control;
  const display = m.devices.find((d) => d.id === 'display1')!;
  display.control = { kind: 'generic', protocol: 'pjlink' };
  display.settings = { host: '127.0.0.1', port, pollMs: 40 };
  return m;
}

/** A class 2 projector that says what software it runs. */
function class2Projector(version: string): Server {
  return createServer((socket) => {
    socket.on('error', () => undefined);
    socket.write('PJLINK 0\r');
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString('latin1');
      let i: number;
      while ((i = buf.indexOf('\r')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line === '%1POWR ?') socket.end('%1POWR=0\r');
        else if (line === '%2SVER ?') socket.end(`%2SVER=${version}\r`);
        else socket.end(`${line.slice(0, 6)}=ERR1\r`);
      }
    });
  });
}

const command = (
  type: GatewayCommand['type'],
  args: Record<string, string> = {},
): GatewayCommand => ({
  id: crypto.randomUUID(),
  type,
  roomId: ROOM,
  args,
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kestrel-gw-mon-'));
  cloud = await new FakeCloud().start();
  device = createServer((s) => s.on('error', () => undefined));
});
afterEach(async () => {
  for (const r of running.splice(0)) {
    r.gateway.stop();
    r.host.shutdown();
    try {
      r.store.close();
    } catch {
      // already closed
    }
  }
  device?.close();
  await cloud.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('device monitoring', () => {
  it('reports every device with its reachability in each heartbeat', async () => {
    const port = await listen(device!);
    cloud.assign(ROOM, modelWithDsp(port));
    const { gateway, host } = boot();
    gateway.start();
    await until(() => host.ids().includes(ROOM));
    await until(
      () => host.reports()[0]!.devices.find((d) => d.deviceId === 'dsp')?.online === true,
    );
    await gateway.tick();
    const devices = cloud.heartbeats.at(-1)!.rooms[0]!.devices;
    expect(devices.length).toBeGreaterThan(3);
    expect(devices.find((d) => d.deviceId === 'dsp')).toMatchObject({ online: true });
    expect(devices.every((d) => d.name.length > 0)).toBe(true);
  });

  it('reports each device’s driver, and the firmware version when its device gave one', async () => {
    const projector = class2Projector('3.1.0');
    const port = await listen(projector);
    cloud.assign(ROOM, modelWithProjector(port));
    const { gateway, host } = boot();
    gateway.start();
    await until(() => host.ids().includes(ROOM));
    await until(
      () => host.reports()[0]!.devices.find((d) => d.deviceId === 'display1')?.firmware === '3.1.0',
    );
    await gateway.tick();
    const devices = cloud.heartbeats.at(-1)!.rooms[0]!.devices;
    expect(devices.find((d) => d.deviceId === 'display1')).toMatchObject({
      driver: 'pjlink',
      firmware: '3.1.0',
    });
    // Devices that did not report one say nothing, rather than an empty version.
    const other = devices.find((d) => d.deviceId !== 'display1')!;
    expect(other.firmware).toBeUndefined();
    projector.close();
  });

  it('reports how each watched point reads, and leaves out points nobody watches', async () => {
    const m = structuredClone(STARTER_TEMPLATES[0]!.model);
    for (const d of m.devices) delete d.control;
    const dsp = m.devices.find((d) => d.id === 'dsp')!;
    dsp.points = [
      {
        id: 'mut',
        name: 'Mic mute',
        type: 'mute',
        address: {},
        watch: { expect: false, severity: 'critical' },
      },
      {
        id: 'lvl',
        name: 'Level',
        type: 'level',
        address: {},
        watch: { min: 20, severity: 'warning' },
      },
      { id: 'plain', name: 'Not watched', type: 'mute', address: {} },
    ];
    cloud.assign(ROOM, m);
    const { gateway, host } = boot();
    gateway.start();
    await until(() => host.ids().includes(ROOM));
    const bus = host.get(ROOM)!.bus;
    const watched = () => host.reports()[0]!.devices.find((d) => d.deviceId === 'dsp')?.watched;

    await bus.send('dsp', { type: 'point', pointId: 'mut', value: true });
    await bus.send('dsp', { type: 'point', pointId: 'plain', value: true });
    expect(watched()).toEqual([
      {
        pointId: 'mut',
        name: 'Mic mute',
        ok: false,
        message: 'Mic mute is on, expected off',
        severity: 'critical',
      },
      { pointId: 'lvl', name: 'Level', ok: true, severity: 'warning' },
    ]);

    await bus.send('dsp', { type: 'point', pointId: 'mut', value: false });
    expect(watched()).toEqual([
      { pointId: 'mut', name: 'Mic mute', ok: true, severity: 'critical' },
      { pointId: 'lvl', name: 'Level', ok: true, severity: 'warning' },
    ]);
    await gateway.tick();
    expect(
      cloud.heartbeats.at(-1)!.rooms[0]!.devices.find((d) => d.deviceId === 'dsp')?.watched,
    ).toHaveLength(2);
  });

  it('reports a device that stops answering, sends an event with when it happened, and then a recovery', async () => {
    const port = await listen(device!);
    cloud.assign(ROOM, modelWithDsp(port));
    const { gateway, host, store } = boot();
    gateway.start();
    await until(
      () => host.reports()[0]?.devices.find((d) => d.deviceId === 'dsp')?.online === true,
    );

    const before = Date.now();
    device!.close();
    await until(
      () => host.reports()[0]!.devices.find((d) => d.deviceId === 'dsp')!.online === false,
    );
    await gateway.tick();
    expect(
      cloud.heartbeats.at(-1)!.rooms[0]!.devices.find((d) => d.deviceId === 'dsp'),
    ).toMatchObject({ online: false });
    const off = cloud.telemetry.find((e) => e.type === 'device.offline')!;
    expect(off).toMatchObject({ roomId: ROOM, data: { deviceId: 'dsp' } });
    expect(new Date(off.at).getTime()).toBeGreaterThanOrEqual(before - 50);

    device = createServer((s) => s.on('error', () => undefined));
    await listen(device, port);
    await until(
      () => host.reports()[0]!.devices.find((d) => d.deviceId === 'dsp')!.online === true,
    );
    await gateway.tick();
    expect(
      cloud.telemetry.some((e) => e.type === 'device.online' && e.data.deviceId === 'dsp'),
    ).toBe(true);
    expect(store.unsentCount()).toBe(0);
  });
});

describe('remote commands', () => {
  async function ready() {
    const port = await listen(device!);
    cloud.assign(ROOM, modelWithDsp(port));
    const g = boot();
    g.gateway.start();
    await until(() => g.host.ids().includes(ROOM));
    await until(() => g.host.reports()[0]!.devices.find((d) => d.deviceId === 'dsp')!.online);
    await g.gateway.tick();
    return g;
  }
  const resultFor = (id: string) =>
    cloud.heartbeats.flatMap((h) => h.commandResults).find((r) => r.id === id);

  it('runs diagnostics and reports the outcome straight away', async () => {
    const g = await ready();
    const cmd = command('diagnostics');
    cloud.queuedCommands.push(cmd);
    await g.gateway.tick();
    const res = resultFor(cmd.id)!;
    expect(res.ok).toBe(true);
    const out = res.output as {
      room: { status: string };
      devices: { id: string; online: boolean }[];
      gateway: { version: string };
    };
    expect(out.room.status).toBe('off');
    expect(out.devices.find((d) => d.id === 'dsp')?.online).toBe(true);
    expect(out.gateway.version).toBe('0.0.0-test');
    expect(
      cloud.telemetry.some((e) => e.type === 'command.finished' && e.data.type === 'diagnostics'),
    ).toBe(true);
  });

  it('says which device is not answering', async () => {
    const g = await ready();
    device!.close();
    await until(() => !g.host.reports()[0]!.devices.find((d) => d.deviceId === 'dsp')!.online);
    const diag = command('diagnostics');
    const test = command('test_device', { deviceId: 'dsp' });
    cloud.queuedCommands.push(diag, test);
    await g.gateway.tick();
    expect(resultFor(diag.id)).toMatchObject({ ok: false, error: expect.stringContaining('DSP') });
    expect(resultFor(test.id)).toMatchObject({ ok: false, output: { online: false } });
  });

  it('checks a control point: refuses a bad address, and a simulated room answers with a made-up range', async () => {
    const g = await ready();
    const point = (over: Record<string, string>) =>
      command('verify_point', {
        deviceId: 'dsp',
        type: 'level',
        address: '{"component":"C","control":"gain"}',
        ...over,
      });
    const bad = point({ address: 'not json' });
    const wrongType = point({ type: 'nonsense' });
    const generic = point({});
    // (A room on real hardware asks the driver; a driver that cannot read points refuses, tested with the drivers.)
    cloud.queuedCommands.push(bad, wrongType, generic);
    await g.gateway.tick();
    expect(resultFor(bad.id)).toMatchObject({
      ok: false,
      error: 'The control point address is not valid',
    });
    expect(resultFor(wrongType.id)).toMatchObject({
      ok: false,
      error: 'The control point is not valid',
    });
    expect(resultFor(generic.id)).toMatchObject({
      ok: true,
      output: { device: 'DSP', value: -20, min: -100, max: 12 },
    });
  });

  it('fails cleanly for a device that is not in the room, or a room the gateway does not run', async () => {
    const g = await ready();
    const badDevice = command('test_device', { deviceId: 'ghost' });
    const badRoom = { ...command('diagnostics'), roomId: '33333333-3333-4333-8333-333333333399' };
    cloud.queuedCommands.push(badDevice, badRoom);
    await g.gateway.tick();
    expect(resultFor(badDevice.id)).toMatchObject({
      ok: false,
      error: 'That device is not in this room',
    });
    expect(resultFor(badRoom.id)).toMatchObject({
      ok: false,
      error: 'That room is not running on this gateway',
    });
  });

  it('refuses a command that is not on the allowlist even if the cloud sends it', async () => {
    const g = await ready();
    const rogue = { ...command('diagnostics'), type: 'run_shell' } as unknown as GatewayCommand;
    cloud.queuedCommands.push(rogue);
    // The gateway validates every response, so a rogue command never reaches the runner at all.
    await g.gateway.tick().catch(() => undefined);
    expect(resultFor(rogue.id)).toBeUndefined();
    expect(g.host.ids()).toEqual([ROOM]);
  });

  it('turns a room off and restarts it', async () => {
    const g = await ready();
    const first = g.host.get(ROOM)!;

    const off = command('room_off');
    cloud.queuedCommands.push(off);
    await g.gateway.tick();
    expect(resultFor(off.id)?.ok).toBe(true);

    const restart = command('restart_room');
    cloud.queuedCommands.push(restart);
    await g.gateway.tick();
    expect(resultFor(restart.id)?.ok).toBe(true);
    expect(g.host.get(ROOM)).not.toBe(first);
    expect(g.host.get(ROOM)!.releaseId).toBe(first.releaseId);
  });
});

describe('control from the portal', () => {
  it('polls fast while a room is watched, sends its panel state, runs intents, and stops when the page closes', async () => {
    const port = await listen(device!);
    cloud.assign(ROOM, modelWithDsp(port));
    const { gateway, host } = boot();
    gateway.start();
    await until(() => host.ids().includes(ROOM));
    await gateway.tick();
    expect(cloud.polls).toHaveLength(0);

    // Someone opens the control page: the next heartbeat tells the gateway to watch the room.
    cloud.watching = [ROOM];
    await gateway.tick();
    await until(() => cloud.polls.length >= 2);
    const last = cloud.polls.at(-1)!.panels[0]!;
    expect(last.roomId).toBe(ROOM);
    expect(last.vm).toMatchObject({ roomName: 'Test room', status: 'off' });

    // They press Present: the intent reaches the room's runtime.
    const present = host
      .get(ROOM)!
      .runtime.getSnapshot()
      .activities.find((a) => a.kind !== 'room_off')!;
    cloud.queuedIntents.push({
      id: crypto.randomUUID(),
      roomId: ROOM,
      intent: { type: 'activity.start', activityId: present.id },
    });
    await until(() => host.get(ROOM)!.runtime.getSnapshot().status !== 'off');

    // They close the page: the gateway settles back to the normal heartbeat.
    cloud.watching = [];
    await wait(1600);
    const settled = cloud.polls.length;
    await wait(2500);
    expect(cloud.polls.length).toBe(settled);
  }, 20_000);

  it('ignores intents for rooms it is not running', async () => {
    const port = await listen(device!);
    cloud.assign(ROOM, modelWithDsp(port));
    const { gateway, host } = boot();
    gateway.start();
    await until(() => host.ids().includes(ROOM));
    cloud.watching = [ROOM];
    cloud.queuedIntents.push({
      id: crypto.randomUUID(),
      roomId: '33333333-3333-4333-8333-333333333399',
      intent: { type: 'volume.bump', delta: 5 },
    });
    await gateway.tick();
    await until(() => cloud.polls.length >= 1);
    expect(host.ids()).toEqual([ROOM]);
    cloud.watching = [];
  });
});

describe('triggers from outside', () => {
  it('collects a waiting webhook without anyone watching, and runs the trigger it names', async () => {
    const port = await listen(device!);
    const m = modelWithDsp(port);
    m.triggers.push({
      id: 'hook1',
      name: 'Start from the booking system',
      enabled: true,
      type: 'webhook',
      hookName: 'start_meeting',
      run: { type: 'activity', activityId: 'present' },
    });
    cloud.assign(ROOM, m);
    const { gateway, host } = boot();
    gateway.start();
    await until(() => host.ids().includes(ROOM));
    await gateway.tick();
    expect(host.get(ROOM)!.runtime.getSnapshot().status).toBe('off');

    cloud.queuedIntents.push({
      id: crypto.randomUUID(),
      roomId: ROOM,
      intent: { type: 'hook', hookName: 'start_meeting' },
    });
    await gateway.tick();
    await until(() => host.get(ROOM)!.runtime.getSnapshot().status !== 'off');
    expect(cloud.polls.length).toBeGreaterThan(0);
  });

  it('ignores a webhook no trigger is listening for', async () => {
    const port = await listen(device!);
    cloud.assign(ROOM, modelWithDsp(port));
    const { gateway, host } = boot();
    gateway.start();
    await until(() => host.ids().includes(ROOM));
    cloud.queuedIntents.push({
      id: crypto.randomUUID(),
      roomId: ROOM,
      intent: { type: 'hook', hookName: 'nobody_listens' },
    });
    await gateway.tick();
    await until(() => cloud.polls.length > 0);
    await wait(300);
    expect(host.get(ROOM)!.runtime.getSnapshot().status).toBe('off');
  });
});
