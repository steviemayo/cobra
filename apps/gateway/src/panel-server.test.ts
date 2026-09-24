import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPair, hashPin, signManifest } from '@kestrel/crypto';
import { PanelServerMessage, STARTER_TEMPLATES, type PanelAccess } from '@kestrel/model';
import { silentLogger } from './log';
import { createPanelServer } from './panel-server';
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

async function start(access?: Partial<PanelAccess>, panelDir = '/nonexistent') {
  host = new RoomHost('all', silentLogger, () => undefined);
  host.load(signedRoom(access));
  app = await createPanelServer({ host, log: silentLogger, panelDir });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
}

class Panel {
  readonly messages: PanelServerMessage[] = [];
  closed: { code: number } | null = null;
  ws: WebSocket;
  constructor(roomId = ROOM) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${roomId}`);
    clients.push(this.ws);
    this.ws.on('message', (d) => this.messages.push(PanelServerMessage.parse(JSON.parse(d.toString()))));
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
    a.send({ t: 'intent', intent: { type: 'activity.start', activityId: 'present', sourceId: 'laptop2' } });
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
    for (let i = 0; i < 100; i++) p.send({ t: 'intent', intent: { type: 'volume.bump', delta: 1 } });
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
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Kestrel</title><div id="root"></div>');
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
    for (const url of ['/assets/../../kestrel-secret.txt', '/assets/%2e%2e/%2e%2e/kestrel-secret.txt', '/index.html', '/assets']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body, url).not.toContain('top secret');
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('still refuses to serve a room that is not running', async () => {
    const dir = site();
    await start(undefined, dir);
    const res = await app.inject({ method: 'GET', url: '/room/33333333-3333-4333-8333-3333333333ff' });
    expect(res.statusCode).toBe(404);
    rmSync(dir, { recursive: true, force: true });
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
    const missing = await app.inject({ method: 'GET', url: '/room/33333333-3333-4333-8333-3333333333ff' });
    expect(missing.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/room/nope' })).statusCode).toBe(404);
  });
});
