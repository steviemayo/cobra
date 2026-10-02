import { describe, expect, it } from 'vitest';
import { BURST_EVERY_MS, CHECK_EVERY_MS, DRIVER_HOLD_MS, FastFail } from './fastfail';

function rig(driver?: { online: boolean | undefined }) {
  let now = 1_000_000;
  let up = true;
  const changes: [string, boolean][] = [];
  const ff = new FastFail({
    now: () => now,
    reach: async () => up,
    driverOnline: () => driver?.online,
    onChange: (id, down) => changes.push([id, down]),
  });
  return {
    ff,
    changes,
    setUp: (v: boolean) => void (up = v),
    /** Moves time on one second at a time, running whatever is due, like the real timer. */
    async advance(ms: number) {
      for (let t = 0; t < ms; t += 500) {
        now += 500;
        await ff.run();
      }
    },
    get now() {
      return now;
    },
  };
}

describe('fast failure detection', () => {
  it('confirms a device down after a run of quick misses, in seconds, and says it once', async () => {
    const r = rig();
    r.ff.track('d1', '10.0.0.5', 23);
    await r.advance(CHECK_EVERY_MS); // answers: now proven
    expect(r.ff.verdict('d1')).toEqual({ online: true, confirmed: false });
    r.setUp(false);
    await r.advance(CHECK_EVERY_MS + 3 * BURST_EVERY_MS);
    expect(r.ff.verdict('d1')).toMatchObject({ online: false, confirmed: true });
    expect(r.changes).toEqual([['d1', true]]);
  });

  it('does not confirm on one or two misses, and reports nothing while suspect', async () => {
    let now = 1_000_000;
    let misses = 0;
    const changes: [string, boolean][] = [];
    const ff = new FastFail({
      now: () => now,
      // Answers once (so it is proven), misses exactly twice, then answers again.
      reach: async () => {
        misses++;
        return misses !== 2 && misses !== 3;
      },
      onChange: (id, down) => changes.push([id, down]),
    });
    ff.track('d1', '10.0.0.5', 23);
    for (let t = 0; t < 30_000; t += 500) {
      now += 500;
      await ff.run();
      expect(ff.verdict('d1')?.online ?? true).toBe(true);
    }
    expect(misses).toBeGreaterThan(4);
    expect(changes).toEqual([]);
  });

  it('needs several answers in a row to come back, so a bouncing device is not announced', async () => {
    const r = rig();
    r.ff.track('d1', '10.0.0.5', 23);
    await r.advance(CHECK_EVERY_MS);
    r.setUp(false);
    await r.advance(CHECK_EVERY_MS + 4 * BURST_EVERY_MS);
    expect(r.changes).toEqual([['d1', true]]);
    r.setUp(true);
    await r.advance(BURST_EVERY_MS); // one answer is not enough
    r.setUp(false);
    await r.advance(CHECK_EVERY_MS);
    expect(r.ff.verdict('d1')?.online).toBe(false);
    r.setUp(true);
    await r.advance(CHECK_EVERY_MS);
    expect(r.ff.verdict('d1')).toEqual({ online: true, confirmed: false });
    expect(r.changes).toEqual([
      ['d1', true],
      ['d1', false],
    ]);
  });

  it('never judges a device that has not answered a check yet (its checks may be blocked)', async () => {
    const r = rig();
    r.setUp(false);
    r.ff.track('d1', '10.0.0.5', undefined);
    await r.advance(60_000);
    expect(r.ff.verdict('d1')).toBeUndefined();
    expect(r.changes).toEqual([]);
  });

  it('believes a driver that stays offline even when the device still answers', async () => {
    const driver = { online: true as boolean | undefined };
    const r = rig(driver);
    r.ff.track('d1', '10.0.0.5', 23);
    await r.advance(CHECK_EVERY_MS);
    driver.online = false;
    await r.advance(DRIVER_HOLD_MS - 1_000);
    expect(r.ff.verdict('d1')?.online).toBe(true);
    await r.advance(2_000);
    expect(r.ff.verdict('d1')).toMatchObject({ online: false, confirmed: true });
    // It stays down while the driver says so, whatever the checks say.
    await r.advance(CHECK_EVERY_MS * 3);
    expect(r.ff.verdict('d1')?.online).toBe(false);
    driver.online = true;
    await r.advance(CHECK_EVERY_MS * 2);
    expect(r.ff.verdict('d1')?.online).toBe(true);
  });

  it('reports how long a device has been quiet, counted from its first miss', async () => {
    const r = rig();
    r.ff.track('d1', '10.0.0.5', 23, { failsToConfirm: 3 });
    await r.advance(CHECK_EVERY_MS);
    r.setUp(false);
    await r.advance(CHECK_EVERY_MS + 3 * BURST_EVERY_MS);
    await r.advance(10_000);
    const v = r.ff.verdict('d1')!;
    expect(v.offlineForMs).toBeGreaterThanOrEqual(10_000);
    expect(v.offlineForMs).toBeLessThan(25_000);
  });
});
