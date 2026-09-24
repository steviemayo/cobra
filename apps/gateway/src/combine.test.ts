import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, type RoomModel } from '@kestrel/model';
import { CloudClient } from './cloud';
import type { GatewayConfig } from './config';
import { Gateway } from './gateway';
import { silentLogger } from './log';
import { RoomHost } from './room-host';
import { Store } from './store';
import { ENROLL_TOKEN, FakeCloud } from './test-support/fake-cloud';

const A = '33333333-3333-4333-8333-333333333331';
const B = '33333333-3333-4333-8333-333333333332';
const COMBO = '77777777-7777-4777-8777-777777777771';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 12_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await wait(20);
  }
}

const plain = (): RoomModel => {
  const m = structuredClone(STARTER_TEMPLATES[0]!.model);
  for (const d of m.devices) delete d.control;
  return m;
};

let dir: string;
let cloud: FakeCloud;
const running: { gateway: Gateway; host: RoomHost; store: Store }[] = [];

function boot() {
  const cfg: GatewayConfig = {
    cloudUrl: cloud.url,
    enrollToken: ENROLL_TOKEN,
    dataDir: dir,
    panelPort: 0,
    panelHost: '127.0.0.1',
    panelDir: '',
    simulate: 'all',
    logLevel: 'error',
    version: '0.0.0-test',
  };
  const store = new Store(join(dir, 'gateway.db'));
  const host = new RoomHost('all', silentLogger, (e) => store.enqueue(e));
  const gateway = new Gateway(cfg, store, new CloudClient(cloud.url), host, silentLogger);
  running.push({ gateway, host, store });
  return { gateway, host, store };
}

const combo = (over: Record<string, unknown> = {}) => ({
  id: COMBO,
  name: 'Ballroom',
  primaryRoomId: A,
  secondaryRoomIds: [B],
  secondaryVideo: 'follow',
  secondaryAudio: 'follow',
  ...over,
});

async function rig(over: Record<string, unknown> = {}) {
  cloud.assign(A, plain(), { name: 'Ballroom North' });
  cloud.assign(B, plain(), { name: 'Ballroom South' });
  cloud.setCombinations([combo(over)]);
  const g = boot();
  g.gateway.start();
  await until(() => g.host.ids().length === 2);
  await g.gateway.tick();
  const vm = (id: string) => g.host.get(id)!.runtime.getSnapshot();
  const rt = (id: string) => g.host.get(id)!.runtime;
  return { ...g, vm, rt };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kestrel-gw-combine-'));
  cloud = await new FakeCloud().start();
});
afterEach(async () => {
  for (const r of running.splice(0)) {
    r.gateway.stop();
    r.host.shutdown();
    try {
      r.store.close();
    } catch {
      // closed by the test
    }
  }
  await cloud.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('combined rooms', () => {
  it('tells each panel its part, and offers the primary a way to join', async () => {
    const r = await rig();
    expect(r.vm(A).combination).toEqual({
      role: 'primary',
      combined: false,
      rooms: ['Ballroom South'],
    });
    expect(r.vm(B).combination).toEqual({
      role: 'secondary',
      combined: false,
      rooms: ['Ballroom North'],
    });
    // Apart, both work as ordinary rooms.
    r.rt(B).dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop1' });
    await until(() => r.vm(B).status !== 'off');
  });

  it('joins from the primary panel, and the secondary follows what the primary shows', async () => {
    const r = await rig();
    r.rt(A).dispatch({ type: 'combine.set', combined: true });
    expect(r.vm(A).combination!.combined).toBe(true);
    expect(r.vm(B).combination!.combined).toBe(true);
    expect(r.vm(B).message!.text.key).toBe('combined_secondary');
    expect(r.vm(B).message!.text.params).toEqual({ room: 'Ballroom North' });

    r.rt(A).dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop2' });
    await until(() => r.vm(A).status === 'on' && r.vm(B).status === 'on');
    const chosen = r
      .vm(B)
      .activities.find((a) => a.id === 'present')!
      .sources.find((s) => s.selected);
    expect(chosen?.id).toBe('laptop2');

    r.rt(A).dispatch({ type: 'activity.start', activityId: 'room_off' });
    await until(() => r.vm(A).status === 'off' && r.vm(B).status === 'off');
  }, 30_000);

  it('follows volume and mute', async () => {
    const r = await rig();
    r.rt(A).dispatch({ type: 'combine.set', combined: true });
    r.rt(A).dispatch({ type: 'volume.set', level: 72 });
    await until(() => r.vm(B).volume.level === 72);
    r.rt(A).dispatch({ type: 'mute.set', muted: true });
    await until(() => r.vm(B).volume.muted);
  });

  it('blanks the secondary displays and speakers when told to', async () => {
    const r = await rig({ secondaryVideo: 'blank', secondaryAudio: 'blank' });
    r.rt(A).dispatch({ type: 'combine.set', combined: true });
    await until(() => r.vm(B).volume.muted);
    r.rt(A).dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop1' });
    await until(() => r.vm(A).status === 'on');
    await wait(300);
    expect(r.vm(B).status).toBe('off');
  }, 30_000);

  it('ignores the secondary own panel while combined', async () => {
    const r = await rig();
    r.rt(A).dispatch({ type: 'combine.set', combined: true });
    r.rt(B).dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop1' });
    r.rt(B).dispatch({ type: 'volume.set', level: 10 });
    await wait(300);
    expect(r.vm(B).status).toBe('off');
    expect(r.vm(B).volume.level).not.toBe(10);
  });

  it('splits back to two ordinary rooms, turning the secondary off', async () => {
    const r = await rig();
    r.rt(A).dispatch({ type: 'combine.set', combined: true });
    r.rt(A).dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop1' });
    await until(() => r.vm(B).status === 'on');
    r.rt(A).dispatch({ type: 'combine.set', combined: false });
    await until(() => r.vm(B).status === 'off');
    expect(r.vm(B).combination!.combined).toBe(false);
    expect(r.vm(A).status).toBe('on');
    // The secondary answers to its own panel again.
    r.rt(B).dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop2' });
    await until(() => r.vm(B).status === 'on');
  }, 40_000);

  it('reports what is combined in the heartbeat', async () => {
    const r = await rig();
    r.rt(A).dispatch({ type: 'combine.set', combined: true });
    await r.gateway.tick();
    expect(cloud.heartbeats.at(-1)!.combinations).toEqual([{ id: COMBO, combined: true }]);
  });

  it('is combined again after a restart, with no cloud needed', async () => {
    const first = await rig();
    first.rt(A).dispatch({ type: 'combine.set', combined: true });
    first.gateway.stop();
    first.host.shutdown();
    first.store.close();
    await cloud.stop();

    // No cloud at all: it comes back from what the gateway saved.
    const second = boot();
    second.gateway.start();
    await until(() => second.host.ids().length === 2);
    expect(second.host.get(A)!.runtime.getSnapshot().combination).toMatchObject({
      role: 'primary',
      combined: true,
    });
    expect(second.host.get(B)!.runtime.getSnapshot().combination).toMatchObject({
      role: 'secondary',
      combined: true,
    });
  }, 30_000);

  it('can be joined and split from the portal', async () => {
    const r = await rig();
    cloud.watching = [A];
    cloud.queuedIntents.push({
      id: crypto.randomUUID(),
      roomId: A,
      intent: { type: 'combination.set', combinationId: COMBO, combined: true },
    });
    await r.gateway.tick();
    await until(() => r.vm(B).combination?.combined === true);
    cloud.queuedIntents.push({
      id: crypto.randomUUID(),
      roomId: A,
      intent: { type: 'combination.set', combinationId: COMBO, combined: false },
    });
    await until(() => r.vm(B).combination?.combined === false);
    cloud.watching = [];
  }, 30_000);

  it('does nothing if a room in the combination is not running here', async () => {
    cloud.assign(A, plain(), { name: 'Ballroom North' });
    cloud.setCombinations([combo()]);
    const g = boot();
    g.gateway.start();
    await until(() => g.host.ids().includes(A));
    await g.gateway.tick();
    expect(g.host.get(A)!.runtime.getSnapshot().combination).toBeUndefined();
    g.host.get(A)!.runtime.dispatch({ type: 'combine.set', combined: true });
    expect(g.host.get(A)!.runtime.getSnapshot().combination).toBeUndefined();
  });
});
