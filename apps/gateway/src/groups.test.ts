import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STARTER_TEMPLATES,
  type GroupConfig,
  type RoomModel,
  type TransitionAction,
} from '@kestrel/model';
import { CloudClient } from './cloud';
import type { GatewayConfig } from './config';
import { Gateway } from './gateway';
import { silentLogger } from './log';
import { RoomHost } from './room-host';
import { Store } from './store';
import { ENROLL_TOKEN, FakeCloud } from './test-support/fake-cloud';

const G = '44444444-4444-4444-8444-444444444441';
const [A, B, C, AB, BC, ABC] = Array.from(
  { length: 6 },
  (_, i) => `33333333-3333-4333-8333-33333333333${i + 1}`,
) as [string, string, string, string, string, string];
const [W1, W2] = [
  '55555555-5555-4555-8555-555555555551',
  '55555555-5555-4555-8555-555555555552',
] as [string, string];

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

/** Three rooms in a line (A-B-C), with a combined room for every joined set. */
const group = (
  over: {
    w1?: [TransitionAction, TransitionAction];
    w2?: [TransitionAction, TransitionAction];
    combined?: string[];
  } = {},
): GroupConfig => {
  const [o1, c1] = over.w1 ?? ['follow', 'off'];
  const [o2, c2] = over.w2 ?? ['follow', 'off'];
  const sets: Record<string, string[]> = { [AB]: [A, B], [BC]: [B, C], [ABC]: [A, B, C] };
  return {
    id: G,
    name: 'Wing',
    roomIds: [A, B, C],
    dividers: [
      { id: W1, name: 'Wall 1', roomIds: [A, B], onOpen: o1, onClose: c1 },
      { id: W2, name: 'Wall 2', roomIds: [B, C], onOpen: o2, onClose: c2 },
    ],
    combined: (over.combined ?? [AB, BC, ABC]).map((roomId) => ({
      roomId,
      memberRoomIds: sets[roomId]!,
    })),
  };
};

async function rig(g: GroupConfig = group()) {
  const names: Record<string, string> = {
    [A]: 'Room A',
    [B]: 'Room B',
    [C]: 'Room C',
    [AB]: 'Room A + Room B',
    [BC]: 'Room B + Room C',
    [ABC]: 'Room A + Room B + Room C',
  };
  for (const id of [A, B, C, ...g.combined.map((c) => c.roomId)])
    cloud.assign(id, plain(), { name: names[id] });
  cloud.setGroups([g]);
  const r = boot();
  r.gateway.start();
  await until(() => r.host.ids().length === 3 + g.combined.length);
  await r.gateway.tick();
  const rt = (id: string) => r.host.get(id)!.runtime;
  const vm = (id: string) => rt(id).getSnapshot();
  /** Open or close a wall the way a panel does: from the room that is running the space. */
  const wall = (from: string, dividerId: string, open: boolean) =>
    r.host.active(from)!.runtime.dispatch({ type: 'divider.set', dividerId, open });
  const activeIds = () => [A, B, C].map((id) => r.host.active(id)!.roomId);
  return { ...r, rt, vm, wall, activeIds };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kestrel-gw-groups-'));
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

describe('room groups: the walls', () => {
  it('starts with every wall closed: each room runs on its own and its panel lists the walls', async () => {
    const r = await rig();
    expect(r.activeIds()).toEqual([A, B, C]);
    expect(r.rt(A).isSuspended).toBe(false);
    // Combined rooms wait until their walls open.
    for (const id of [AB, BC, ABC]) expect(r.rt(id).isSuspended).toBe(true);
    expect(r.vm(A).linking).toEqual({
      space: ['Room A'],
      dividers: [
        {
          id: W1,
          name: 'Wall 1',
          open: false,
          rooms: ['Room A', 'Room B'],
          adds: ['Room B'],
          available: true,
        },
      ],
    });
    // B touches both walls.
    expect(r.vm(B).linking!.dividers.map((d) => d.name)).toEqual(['Wall 1', 'Wall 2']);
  });

  it('opening a wall makes the combined room run and suspends the rooms it stands for', async () => {
    const r = await rig();
    r.wall(A, W1, true);
    await until(() => r.host.active(A)!.roomId === AB);
    expect(r.activeIds()).toEqual([AB, AB, C]);
    expect(r.rt(A).isSuspended).toBe(true);
    expect(r.rt(B).isSuspended).toBe(true);
    expect(r.rt(AB).isSuspended).toBe(false);
    expect(r.rt(C).isSuspended).toBe(false);
    expect(r.vm(AB).linking!.space).toEqual(['Room A', 'Room B']);
    expect(r.vm(AB).linking!.dividers.find((d) => d.id === W1)!.open).toBe(true);
  });

  it('a suspended room ignores its own panel', async () => {
    const r = await rig();
    r.wall(A, W1, true);
    await until(() => r.rt(A).isSuspended);
    r.rt(A).dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop1' });
    await wait(300);
    expect(r.vm(A).status).toBe('off');
    // The combined room takes it.
    r.host
      .active(A)!
      .runtime.dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop1' });
    await until(() => r.vm(AB).status !== 'off');
  });

  it('closing the wall runs the rooms on their own again', async () => {
    const r = await rig();
    r.wall(A, W1, true);
    await until(() => r.rt(AB).isSuspended === false);
    r.wall(A, W1, false);
    await until(() => r.activeIds().join() === [A, B, C].join());
    expect(r.rt(A).isSuspended).toBe(false);
    expect(r.rt(B).isSuspended).toBe(false);
    expect(r.rt(AB).isSuspended).toBe(true);
  });

  it('joins bigger spaces step by step, and splits a big space into what remains', async () => {
    const r = await rig();
    r.wall(A, W1, true);
    await until(() => r.host.active(A)!.roomId === AB);
    r.wall(AB, W2, true);
    await until(() => r.host.active(A)!.roomId === ABC);
    expect(r.rt(AB).isSuspended).toBe(true);
    expect(r.rt(ABC).isSuspended).toBe(false);
    expect(r.rt(C).isSuspended).toBe(true);
    // Closing wall 1 leaves B and C joined.
    r.wall(ABC, W1, false);
    await until(() => r.host.active(B)!.roomId === BC);
    expect(r.activeIds()).toEqual([A, BC, BC]);
    expect(r.rt(A).isSuspended).toBe(false);
    expect(r.rt(ABC).isSuspended).toBe(true);
  });

  it('refuses to open a wall whose combined room is not running here', async () => {
    const r = await rig(group({ combined: [BC, ABC] }));
    r.wall(A, W1, true);
    await wait(200);
    expect(r.activeIds()).toEqual([A, B, C]);
    expect(r.vm(A).linking!.dividers[0]!.available).toBe(false);
    // The other wall can still open.
    expect(r.vm(B).linking!.dividers.find((d) => d.id === W2)!.available).toBe(true);
  });
});

describe('what the new space does when a wall moves', () => {
  const present = async (r: Awaited<ReturnType<typeof rig>>, id: string) => {
    r.host
      .active(id)!
      .runtime.dispatch({ type: 'activity.start', activityId: 'present', sourceId: 'laptop1' });
    await until(() => r.host.active(id)!.runtime.getSnapshot().status === 'on');
  };

  it('follow (opening): starts on if any joined room was on, and stays off if none was', async () => {
    const off = await rig();
    off.wall(A, W1, true);
    await until(() => off.host.active(A)!.roomId === AB);
    await wait(300);
    expect(off.vm(AB).status).toBe('off');
  });

  it('follow (opening): starts on if any joined room was on', async () => {
    const r = await rig();
    await present(r, B);
    r.wall(A, W1, true);
    await until(() => r.vm(AB).status === 'on');
    expect(r.vm(B).status).toBe('on'); // what B thought when it was suspended
  }, 30_000);

  it('on (opening): the joined room starts on even if nothing was', async () => {
    const r = await rig(group({ w1: ['on', 'off'] }));
    r.wall(A, W1, true);
    await until(() => r.vm(AB).status === 'on');
  }, 30_000);

  it('off (opening): the joined room is off even if a room was on', async () => {
    const r = await rig(group({ w1: ['off', 'off'] }));
    await present(r, A);
    r.wall(A, W1, true);
    await wait(300);
    await until(() => r.vm(AB).status === 'off');
  }, 30_000);

  it('off (closing): each room goes off', async () => {
    const r = await rig(group({ w1: ['on', 'off'] }));
    r.wall(A, W1, true);
    await until(() => r.vm(AB).status === 'on');
    r.wall(A, W1, false);
    await until(() => r.activeIds().join() === [A, B, C].join());
    await wait(300);
    expect(r.vm(A).status).toBe('off');
    expect(r.vm(B).status).toBe('off');
  }, 30_000);

  it('restore (closing): each room goes back to what it was doing', async () => {
    const r = await rig(group({ w1: ['off', 'restore'] }));
    await present(r, A);
    const source = () =>
      r
        .vm(A)
        .activities.find((a) => a.id === 'present')!
        .sources.find((s) => s.selected)?.id;
    expect(source()).toBe('laptop1');
    r.wall(A, W1, true);
    await until(() => r.host.active(A)!.roomId === AB);
    r.wall(AB, W1, false);
    await until(() => r.rt(A).isSuspended === false);
    await until(() => r.vm(A).status === 'on', 20_000);
    expect(source()).toBe('laptop1');
    // B was off before, so it is off after.
    await wait(300);
    expect(r.vm(B).status).toBe('off');
  }, 60_000);

  it('follow (closing): the rooms come back on if the joined room was on', async () => {
    const r = await rig(group({ w1: ['on', 'follow'] }));
    r.wall(A, W1, true);
    await until(() => r.vm(AB).status === 'on');
    r.wall(AB, W1, false);
    await until(() => r.vm(A).status === 'on' && r.vm(B).status === 'on', 20_000);
  }, 60_000);
});

describe('room groups: keeping state', () => {
  it('reports which walls are open in the heartbeat', async () => {
    const r = await rig();
    expect(cloud.heartbeats.at(-1)!.dividers).toEqual([
      { id: W1, open: false },
      { id: W2, open: false },
    ]);
    r.wall(A, W1, true);
    await until(() => r.host.active(A)!.roomId === AB);
    await r.gateway.tick();
    expect(cloud.heartbeats.at(-1)!.dividers).toContainEqual({ id: W1, open: true });
  });

  it('is still joined after a restart, with no cloud needed', async () => {
    const first = await rig();
    first.wall(A, W1, true);
    await until(() => first.host.active(A)!.roomId === AB);
    first.gateway.stop();
    first.host.shutdown();
    first.store.close();
    await cloud.stop();

    // No cloud at all: it comes back from what the gateway saved.
    const second = boot();
    second.gateway.start();
    await until(() => second.host.ids().length === 6);
    expect(second.host.active(A)!.roomId).toBe(AB);
    expect(second.host.get(A)!.runtime.isSuspended).toBe(true);
    expect(second.host.get(AB)!.runtime.isSuspended).toBe(false);
  }, 30_000);

  it('a room whose release is replaced while joined stays suspended', async () => {
    const r = await rig();
    r.wall(A, W1, true);
    await until(() => r.host.active(A)!.roomId === AB);
    cloud.assign(A, plain(), { name: 'Room A' });
    await r.gateway.tick();
    await until(() => r.host.get(A)!.releaseId.startsWith('44444442'));
    expect(r.rt(A).isSuspended).toBe(true);
    expect(r.rt(AB).isSuspended).toBe(false);
  }, 30_000);

  it('rooms run on their own again if the group is removed', async () => {
    const r = await rig();
    r.wall(A, W1, true);
    await until(() => r.host.active(A)!.roomId === AB);
    cloud.setGroups([]);
    await r.gateway.tick();
    await until(() => r.rt(A).isSuspended === false);
    expect(r.host.active(A)!.roomId).toBe(A);
  }, 30_000);
});

describe('room groups: from the portal', () => {
  it('opens and closes a wall, and shows the combined room in place of a member', async () => {
    const r = await rig();
    cloud.watching = [A];
    cloud.queuedIntents.push({
      id: crypto.randomUUID(),
      roomId: A,
      intent: { type: 'divider.set', dividerId: W1, open: true },
    });
    await r.gateway.tick();
    await until(() => r.host.active(A)!.roomId === AB);
    // The portal's view of room A is now the combined room's panel.
    await until(() =>
      cloud.polls.some((p) =>
        p.panels.some(
          (x) => x.roomId === A && (x.vm as { roomName: string }).roomName === 'Room A + Room B',
        ),
      ),
    );
    cloud.queuedIntents.push({
      id: crypto.randomUUID(),
      roomId: A,
      intent: { type: 'divider.set', dividerId: W1, open: false },
    });
    await until(() => r.host.active(A)!.roomId === A);
    cloud.watching = [];
  }, 30_000);
});
