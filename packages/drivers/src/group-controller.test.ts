import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupController, RoomRuntime } from '@kestrel/engine';
import { STARTER_TEMPLATES, type GroupConfig, type TransitionAction } from '@kestrel/model';
import { createSimulation, type Simulation } from './sim/simulation';

const [A, B, AB] = ['a', 'b', 'ab'];
const W = 'w1';
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const config = (
  onOpen: TransitionAction = 'follow',
  onClose: TransitionAction = 'off',
): GroupConfig => ({
  id: 'g',
  name: 'Wing',
  roomIds: [A!, B!],
  dividers: [{ id: W, name: 'Wall', roomIds: [A!, B!], onOpen, onClose }],
  combined: [{ roomId: AB!, memberRoomIds: [A!, B!] }],
});

let sims: Simulation[] = [];
let runtimes = new Map<string, RoomRuntime>();
let saved: string[][] = [];
let changed = 0;
let controller: GroupController;

function rig(cfg = config(), open: string[] = [], missing: string[] = []) {
  for (const id of [A!, B!, AB!]) {
    if (missing.includes(id)) continue;
    const model = structuredClone(STARTER_TEMPLATES[0]!.model);
    const sim = createSimulation(model);
    sims.push(sim);
    runtimes.set(id, new RoomRuntime({ model, roomName: id, bus: sim }));
  }
  controller = new GroupController(
    {
      runtime: (id) => runtimes.get(id),
      roomName: (id) => id.toUpperCase(),
      changed: () => void changed++,
      log: () => undefined,
      saveOpen: (ids) => void saved.push(ids),
    },
    [cfg],
    open,
  );
  controller.reconcile();
}

beforeEach(() => {
  vi.useFakeTimers();
  sims = [];
  runtimes = new Map();
  saved = [];
  changed = 0;
});
afterEach(() => {
  for (const r of runtimes.values()) r.dispose();
  for (const s of sims) s.dispose();
  vi.useRealTimers();
});

describe('the group controller on its own', () => {
  it('starts with the rooms on their own and the combined room waiting', () => {
    rig();
    expect(controller.activeRoomId(A!)).toBe(A);
    expect(runtimes.get(AB!)!.isSuspended).toBe(true);
    expect(runtimes.get(A!)!.getSnapshot().linking!.dividers[0]).toMatchObject({
      open: false,
      rooms: ['A', 'B'],
      adds: ['B'],
      available: true,
    });
  });

  it('linking hands the space to the combined room, tells the host, and remembers the wall', async () => {
    rig();
    const before = changed;
    expect(await controller.set(W, true)).toBe(true);
    expect(controller.activeRoomId(A!)).toBe(AB);
    expect(runtimes.get(A!)!.isSuspended).toBe(true);
    expect(runtimes.get(AB!)!.isSuspended).toBe(false);
    expect(changed).toBeGreaterThan(before);
    expect(saved.at(-1)).toEqual([W]);
    expect(controller.report()).toEqual([{ id: W, open: true }]);
  });

  it('applies the wall setting to the new space', async () => {
    rig(config('on'));
    await controller.set(W, true);
    await advance(3500);
    expect(runtimes.get(AB!)!.getSnapshot().status).toBe('on');
  });

  it('separating gives the rooms back', async () => {
    rig();
    await controller.set(W, true);
    await controller.set(W, false);
    expect(controller.activeRoomId(B!)).toBe(B);
    expect(runtimes.get(B!)!.isSuspended).toBe(false);
    expect(runtimes.get(AB!)!.isSuspended).toBe(true);
    expect(saved.at(-1)).toEqual([]);
  });

  it('starts from walls that were already open', () => {
    rig(config(), [W]);
    expect(controller.activeRoomId(A!)).toBe(AB);
    expect(runtimes.get(A!)!.isSuspended).toBe(true);
  });

  it('refuses to link when the combined room is not running, and says it is unavailable', async () => {
    rig(config(), [], [AB!]);
    expect(await controller.set(W, true)).toBe(false);
    expect(controller.activeRoomId(A!)).toBe(A);
    expect(runtimes.get(A!)!.getSnapshot().linking!.dividers[0]!.available).toBe(false);
  });

  it('an unknown wall changes nothing', async () => {
    rig();
    expect(await controller.set('nope', true)).toBe(false);
    expect(saved).toEqual([]);
  });

  it('removing the group frees its rooms and forgets its walls', async () => {
    rig();
    await controller.set(W, true);
    controller.setConfig([]);
    expect(runtimes.get(A!)!.isSuspended).toBe(false);
    expect(controller.report()).toEqual([]);
    expect(controller.activeRoomId(A!)).toBe(A);
  });
});
