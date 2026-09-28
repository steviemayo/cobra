import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, hashPin, signManifest, verifyAccess } from '@kestrel/crypto';
import { PanelServerMessage, STARTER_TEMPLATES, type PanelAccess } from '@kestrel/model';
import { silentLogger } from './log';
import { createPanelServer } from './panel-server';
import { PhoneLinks } from './phone';
import { ScheduleStore } from './schedule';
import { Store } from './store';
import { RoomHost } from './room-host';

const ROOM = '33333333-3333-4333-8333-333333333331';
const keys = generateKeyPair();

function signedRoom(access?: Partial<PanelAccess>) {
  return signManifest(
    {
      manifestVersion: 1,
      orgId: '11111111-1111-4111-8111-111111111111',
      roomId: ROOM,
      roomName: 'Boardroom',
      releaseId: '44444444-4444-4444-8444-444444444441',
      releaseNumber: 1,
      createdAt: new Date().toISOString(),
      model: structuredClone(STARTER_TEMPLATES[0]!.model),
      panel: { access: { mode: 'open', trustedIps: [], ...access }, branding: {} },
    },
    { privateKeyPem: keys.privateKeyPem, keyId: 'k' },
  );
}

let host: RoomHost;
let app: FastifyInstance;
let port: number;
const clients: WebSocket[] = [];

async function start(
  access?: Partial<PanelAccess>,
  panelDir = '/nonexistent',
  extra: Partial<Parameters<typeof createPanelServer>[0]> = {},
) {
  host = new RoomHost('all', silentLogger, () => undefined);
  host.load(signedRoom(access));
  app = await createPanelServer({ host, log: silentLogger, panelDir, ...extra });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
}

class Panel {
  readonly messages: PanelServerMessage[] = [];
  closed: { code: number } | null = null;
  ws: WebSocket;
  constructor(roomId = ROOM, headers?: Record<string, string>) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${roomId}`, headers ? { headers } : undefined);
    clients.push(this.ws);
    this.ws.on('message', (d) =>
      this.messages.push(PanelServerMessage.parse(JSON.parse(d.toString()))),
    );
    this.ws.on('close', (code) => (this.closed = { code }));
    this.ws.on('error', () => undefined);
  }
  send(obj: unknown) {
    this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }
  of<T extends PanelServerMessage['t']>(t: T) {
    return this.messages.filter((m): m is Extract<PanelServerMessage, { t: T }> => m.t === t);
  }
  get last() {
    return this.of('snapshot').at(-1)?.vm;
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await wait(10);
  }
}

beforeEach(() => undefined);
afterEach(async () => {
  clients.splice(0).forEach((c) => c.terminate());
  await app?.close();
  host?.shutdown();
});

describe('open panels', () => {
  it('greet the panel and stream the room state', async () => {
    await start();
    const p = new Panel();
    await until(() => p.of('snapshot').length > 0);
    expect(p.of('hello')[0]).toMatchObject({ roomId: ROOM, pinRequired: false });
    expect(p.last).toMatchObject({ roomName: 'Boardroom', status: 'off' });
    expect(p.last!.activities.map((a) => a.name)).toEqual(['Present', 'Room Off']);
  });

  it('carry intents through to the room, and every panel follows', async () => {
    await start();
    const a = new Panel();
    const b = new Panel();
    await until(() => !!a.last && !!b.last);
    a.send({
      t: 'intent',
      intent: { type: 'activity.start', activityId: 'present', sourceId: 'laptop2' },
    });
    await until(() => a.last!.status === 'starting');
    await until(() => b.last!.status === 'starting'); // the other panel sees it too
    expect(host.get(ROOM)!.runtime.getSnapshot().status).toBe('starting');
  });

  it('ignore malformed messages and invalid intents', async () => {
    await start();
    const p = new Panel();
    await until(() => !!p.last);
    p.send('not json');
    p.send({ t: 'intent', intent: { type: 'volume.set', level: 9999 } });
    p.send({ t: 'intent', intent: { type: 'nonsense' } });
    p.send({ t: 'wat' });
    await wait(80);
    expect(host.get(ROOM)!.runtime.getSnapshot().volume.level).toBe(50);
    expect(p.closed).toBeNull();
  });

  it('limit how fast one panel can send intents', async () => {
    await start();
    const p = new Panel();
    await until(() => !!p.last);
    for (let i = 0; i < 100; i++)
      p.send({ t: 'intent', intent: { type: 'volume.bump', delta: 1 } });
    await wait(200);
    // 20 allowed per second; an unlimited flood would have pushed it to 100 (clamped).
    expect(host.get(ROOM)!.runtime.getSnapshot().volume.level).toBeLessThanOrEqual(70);
    expect(host.get(ROOM)!.runtime.getSnapshot().volume.level).toBeGreaterThan(50);
  });

  it('refuse a room that is not running here', async () => {
    await start();
    const p = new Panel('33333333-3333-4333-8333-3333333333ff');
    await until(() => p.closed !== null);
    expect(p.of('error')[0]!.message).toContain('not running');
    const bad = new Panel('not-a-uuid');
    await until(() => bad.closed !== null);
  });

  it('are told to reconnect when the room is reloaded', async () => {
    await start();
    const p = new Panel();
    await until(() => !!p.last);
    host.load(signedRoom());
    await until(() => p.closed !== null);
    expect(p.closed!.code).toBe(1012);
  });
});

describe('PIN-protected panels', () => {
  const pinAccess = () => ({ mode: 'pin' as const, pinHash: hashPin('4821') });

  it('send nothing about the room until the right PIN is given', async () => {
    await start(pinAccess());
    const p = new Panel();
    await until(() => p.of('hello').length > 0);
    expect(p.of('hello')[0]!.pinRequired).toBe(true);
    p.send({ t: 'intent', intent: { type: 'activity.start', activityId: 'present' } });
    await wait(100);
    expect(p.of('snapshot')).toHaveLength(0);
    expect(host.get(ROOM)!.runtime.getSnapshot().status).toBe('off');

    p.send({ t: 'auth', pin: '4821' });
    await until(() => !!p.last);
    p.send({ t: 'intent', intent: { type: 'activity.start', activityId: 'present' } });
    await until(() => host.get(ROOM)!.runtime.getSnapshot().status === 'starting');
  });

  it('reject a wrong PIN, then lock out after repeated failures', async () => {
    await start(pinAccess());
    const p = new Panel();
    await until(() => p.of('hello').length > 0);
    for (let i = 0; i < 5; i++) p.send({ t: 'auth', pin: '0000' });
    await until(() => p.of('error').length >= 5);
    expect(p.of('error')[0]!.message).toBe('Wrong PIN.');
    // Even the right PIN is refused during the lockout.
    p.send({ t: 'auth', pin: '4821' });
    await until(() => p.of('error').length >= 6);
    expect(p.of('error').at(-1)!.message).toContain('Too many attempts');
    expect(p.of('snapshot')).toHaveLength(0);
  });

  it('locks the room itself after enough wrong guesses, even spread across many addresses', async () => {
    await start(pinAccess(), '/nonexistent', { trustProxy: true });
    for (let i = 0; i < 20; i++) {
      // A fresh address each time, so the per-address lockout (5 attempts) never has a chance to fire.
      const p = new Panel(ROOM, { 'x-forwarded-for': `10.0.0.${i}` });
      await until(() => p.of('hello').length > 0);
      p.send({ t: 'auth', pin: '0000' });
      await until(() => p.of('error').length > 0);
    }
    // Now even the right PIN, from a brand new address, is refused: the room itself is locked.
    const last = new Panel(ROOM, { 'x-forwarded-for': '10.0.1.1' });
    await until(() => last.of('hello').length > 0);
    last.send({ t: 'auth', pin: '4821' });
    await until(() => last.of('error').length > 0);
    expect(last.of('error')[0]!.message).toContain('Too many attempts on this room');
  });

  it('let trusted IPs straight in', async () => {
    await start({ ...pinAccess(), trustedIps: ['127.0.0.1'] });
    const p = new Panel();
    await until(() => !!p.last);
    expect(p.of('hello')[0]!.pinRequired).toBe(false);
  });

  it('do not trust an IP that is not listed', async () => {
    await start({ ...pinAccess(), trustedIps: ['10.9.9.9'] });
    const p = new Panel();
    await until(() => p.of('hello').length > 0);
    expect(p.of('hello')[0]!.pinRequired).toBe(true);
  });
});

describe('serving the built panel app', () => {
  const site = () => {
    const dir = mkdtempSync(join(tmpdir(), 'kestrel-panel-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(
      join(dir, 'index.html'),
      '<!doctype html><title>Kestrel</title><div id="root"></div>',
    );
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("panel")');
    writeFileSync(join(dirname(dir), 'kestrel-secret.txt'), 'top secret');
    return dir;
  };

  it('serves index.html for a running room, and its assets', async () => {
    const dir = site();
    await start(undefined, dir);
    const page = await app.inject({ method: 'GET', url: `/room/${ROOM}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<div id="root">');
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe('console.log("panel")');
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not expose files outside the panel directory, or the directory itself', async () => {
    const dir = site();
    await start(undefined, dir);
    for (const url of [
      '/assets/../../kestrel-secret.txt',
      '/assets/%2e%2e/%2e%2e/kestrel-secret.txt',
      '/index.html',
      '/assets',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body, url).not.toContain('top secret');
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('still refuses to serve a room that is not running', async () => {
    const dir = site();
    await start(undefined, dir);
    const res = await app.inject({
      method: 'GET',
      url: '/room/33333333-3333-4333-8333-3333333333ff',
    });
    expect(res.statusCode).toBe(404);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('reaching the panel from elsewhere', () => {
  const connect = (origin?: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${ROOM}`, origin ? { origin } : undefined);
    clients.push(ws);
    const state = { closed: null as number | null, messages: [] as string[] };
    ws.on('message', (d) => state.messages.push(d.toString()));
    ws.on('close', (code) => (state.closed = code));
    ws.on('error', () => undefined);
    return { ws, state };
  };

  it('refuse a WebSocket opened by a page from another site', async () => {
    await start();
    const evil = connect('http://evil.example');
    await until(() => evil.state.closed !== null);
    expect(evil.state.closed).toBe(1008);
    expect(evil.state.messages.join()).toContain('not allowed');
    // Nothing reached the room.
    expect(host.get(ROOM)!.runtime.getSnapshot().status).toBe('off');
  });

  it('accept a page the gateway served itself, and a client that sends no origin', async () => {
    await start();
    const own = connect(`http://127.0.0.1:${port}`);
    const none = connect();
    await until(() => own.state.messages.length > 0 && none.state.messages.length > 0);
    expect(own.state.closed).toBeNull();
    expect(none.state.closed).toBeNull();
  });

  it('refuse a name the gateway is not meant to be reached by (DNS rebinding)', async () => {
    await start(undefined, '/nonexistent', { machineName: 'av-gateway-1' });
    const asked = (hostHeader: string) =>
      app.inject({ url: `/room/${ROOM}`, headers: { host: hostHeader } });
    expect((await asked('attacker.example.com')).statusCode).toBe(421);
    expect((await asked('attacker.example.com:8080')).statusCode).toBe(421);
    for (const ok of ['127.0.0.1:8080', '10.20.0.4', '[fd00::1]:8080', 'localhost:8080', 'av-gateway-1', 'av-gateway-1.local', 'intranet', 'gw.school.lan'])
      expect((await asked(ok)).statusCode, ok).toBe(200);
    // The health check is never refused.
    expect((await app.inject({ url: '/health', headers: { host: 'attacker.example.com' } })).statusCode).toBe(200);
  });

  it('let the operator add real names', async () => {
    await start(undefined, '/nonexistent', { allowedHosts: ['gw.school.edu', '*.av.example.org'] });
    const asked = (h: string) => app.inject({ url: `/room/${ROOM}`, headers: { host: h } });
    expect((await asked('gw.school.edu')).statusCode).toBe(200);
    expect((await asked('room1.av.example.org:8080')).statusCode).toBe(200);
    expect((await asked('other.school.edu')).statusCode).toBe(421);
  });

  it('send the panel page with headers that stop framing, sniffing and outside scripts', async () => {
    await start();
    const res = await app.inject({ url: `/room/${ROOM}`, headers: { host: '127.0.0.1' } });
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'self'");
  });

  it('move one thing at a time and record who asked', async () => {
    const logs: { message: string; extra?: Record<string, unknown> }[] = [];
    host = new RoomHost('all', silentLogger, () => undefined);
    host.load(signedRoom());
    app = await createPanelServer({
      host,
      panelDir: '/nonexistent',
      log: (_level, message, extra) => logs.push({ message, extra }),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
    const dispatch = vi.spyOn(host.get(ROOM)!.runtime, 'dispatch');
    const p = new Panel();
    await until(() => !!p.last);
    const move = { t: 'intent', intent: { type: 'mover.run', deviceId: 'screen1', action: 'down' } };
    p.send(move);
    p.send(move);
    p.send(move);
    await wait(150);
    // Three asks in a row: one move goes through.
    expect(dispatch.mock.calls.filter(([i]) => (i as { type: string }).type === 'mover.run')).toHaveLength(1);
    expect(logs.filter((l) => l.message.includes('asked for something to move'))).toHaveLength(1);
    expect(logs.find((l) => l.message.includes('asked for something to move'))?.extra).toMatchObject({
      roomId: ROOM,
      intent: 'mover.run',
    });
  });
});

describe('http', () => {
  it('reports health', async () => {
    await start();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ ok: true, rooms: 1 });
  });

  it('serves a helpful page for a running room and 404s for others', async () => {
    await start();
    const ok = await app.inject({ method: 'GET', url: `/room/${ROOM}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('Panel app not built');
    const missing = await app.inject({
      method: 'GET',
      url: '/room/33333333-3333-4333-8333-3333333333ff',
    });
    expect(missing.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/room/nope' })).statusCode).toBe(404);
  });
});

describe('QR links for phones', () => {
  const SECRET = 'phone-secret-for-the-boardroom-0123456789';
  const links = () => {
    const store = new Store(':memory:');
    const phone = new PhoneLinks(store, 'https://kestrel.example');
    phone.setSecrets([
      {
        roomId: ROOM,
        roomName: 'Boardroom',
        releaseId: '44444444-4444-4444-8444-444444444441',
        releaseNumber: 1,
        manifestHash: 'h',
        deploymentId: '55555555-5555-4555-8555-555555555551',
        phoneSecret: SECRET,
      },
    ]);
    return { store, phone };
  };

  it('are sent to an open panel as a signed link that the cloud can verify', async () => {
    await start(undefined, '/nonexistent', { phone: links().phone });
    const p = new Panel();
    await until(() => p.of('qr').length > 0);
    const qr = p.of('qr')[0]!;
    const token = qr.url.replace('https://kestrel.example/c/', '');
    expect(verifyAccess(SECRET, 'join', token)?.roomId).toBe(ROOM);
    expect(verifyAccess(SECRET, 'session', token)).toBeNull();
    expect(new Date(qr.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('are replaced regularly, and held back from a panel that has not entered its PIN', async () => {
    await start({ mode: 'pin', pinHash: hashPin('4821') }, '/nonexistent', {
      phone: links().phone,
      qrRefreshMs: 60,
    });
    const p = new Panel();
    await until(() => p.of('hello').length > 0);
    await wait(150);
    expect(p.of('qr')).toHaveLength(0);
    p.send({ t: 'auth', pin: '4821' });
    await until(() => p.of('qr').length >= 3);
  });

  it('are not sent when the cloud has not given the gateway a secret', async () => {
    const store = new Store(':memory:');
    await start(undefined, '/nonexistent', {
      phone: new PhoneLinks(store, 'https://kestrel.example'),
    });
    const p = new Panel();
    await until(() => !!p.last);
    await wait(80);
    expect(p.of('qr')).toHaveLength(0);
  });

  it('forget a room’s secret when the room is unassigned, and keep it across restarts', () => {
    const { store, phone } = links();
    expect(new PhoneLinks(store, 'https://k.example').link(ROOM)).not.toBeNull();
    phone.setSecrets([]);
    expect(phone.link(ROOM)).toBeNull();
  });
});

describe('bookings on the panel', () => {
  const meeting = (id: string) => ({
    id,
    title: `Meeting ${id}`,
    organiser: 'Sam Lee',
    start: '2026-09-28T09:00:00.000Z',
    end: '2026-09-28T10:00:00.000Z',
    private: false,
  });

  it('are sent when a panel connects, and again when they change', async () => {
    const schedule = new ScheduleStore();
    schedule.apply([{ roomId: ROOM, meetings: [meeting('a')] }]);
    await start(undefined, '/nonexistent', { schedule });
    const p = new Panel();
    await until(() => p.of('schedule').length > 0);
    expect(p.of('schedule')[0]!.meetings?.map((m) => m.id)).toEqual(['a']);
    schedule.apply([{ roomId: ROOM, meetings: [meeting('a'), meeting('b')] }]);
    await until(() => p.of('schedule').length > 1);
    expect(p.of('schedule')[1]!.meetings).toHaveLength(2);
  });

  it('say "not known" when the cloud has not described the room', async () => {
    await start(undefined, '/nonexistent', { schedule: new ScheduleStore() });
    const p = new Panel();
    await until(() => p.of('schedule').length > 0);
    expect(p.of('schedule')[0]!.meetings).toBeNull();
  });

  it('are not sent to another room, or to a panel that has not entered its PIN', async () => {
    const schedule = new ScheduleStore();
    schedule.apply([{ roomId: '33333333-3333-4333-8333-333333333399', meetings: [meeting('x')] }]);
    await start({ mode: 'pin', pinHash: hashPin('4821') }, '/nonexistent', { schedule });
    const p = new Panel();
    await until(() => p.of('hello').length > 0);
    await wait(100);
    expect(p.of('schedule')).toHaveLength(0);
    p.send({ t: 'auth', pin: '4821' });
    await until(() => p.of('schedule').length > 0);
    expect(p.of('schedule')[0]!.meetings).toBeNull();
    schedule.apply([{ roomId: '33333333-3333-4333-8333-333333333399', meetings: [meeting('y')] }]);
    await wait(100);
    expect(p.of('schedule')).toHaveLength(1);
  });

  it('are not sent at all when the gateway has no schedule store', async () => {
    await start();
    const p = new Panel();
    await until(() => !!p.last);
    expect(p.of('schedule')).toHaveLength(0);
  });
});

describe('panels while walls are open', () => {
  const OTHER = '33333333-3333-4333-8333-333333333332';
  const otherRoom = () =>
    signManifest(
      {
        manifestVersion: 1,
        orgId: '11111111-1111-4111-8111-111111111111',
        roomId: OTHER,
        roomName: 'Boardroom + Annexe',
        releaseId: '44444444-4444-4444-8444-444444444442',
        releaseNumber: 1,
        createdAt: new Date().toISOString(),
        model: structuredClone(STARTER_TEMPLATES[0]!.model),
        panel: { access: { mode: 'open', trustedIps: [] }, branding: {} },
      },
      { privateKeyPem: keys.privateKeyPem, keyId: 'k' },
    );

  it('follows the room that is now running its space, and sends intents to it', async () => {
    await start();
    host.load(otherRoom());
    const p = new Panel();
    await until(() => p.last?.roomName === 'Boardroom');

    // A wall opens: the combined room now runs this panel's space.
    host.setActiveResolver((id) => (id === ROOM ? OTHER : id));
    host.notifyActiveChange();
    await until(() => p.last?.roomName === 'Boardroom + Annexe');

    p.send({
      t: 'intent',
      intent: { type: 'activity.start', activityId: 'present', sourceId: 'laptop1' },
    });
    await until(() => host.get(OTHER)!.runtime.getSnapshot().status === 'starting');
    expect(host.get(ROOM)!.runtime.getSnapshot().status).toBe('off');

    // And back again when it closes.
    host.setActiveResolver((id) => id);
    host.notifyActiveChange();
    await until(() => p.last?.roomName === 'Boardroom');
  });
});
