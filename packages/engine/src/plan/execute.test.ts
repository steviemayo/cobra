import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceBus, DeviceCommand } from '@kestrel/model';
import { executePlan } from './execute';
import type { Plan } from './plan';

const cmd: DeviceCommand = { type: 'power', on: true };
const plan = (steps: [string, string[]][]): Plan => ({
  problems: [],
  steps: steps.map(([id, dependsOn]) => ({ id, deviceId: `dev-${id}`, command: cmd, dependsOn })),
});

// A bus where each device takes `delays[deviceId]` ms to report ready (or fails).
function makeBus(delays: Record<string, number | 'fail'> = {}) {
  const log: string[] = [];
  const bus: DeviceBus = {
    async send(deviceId) {
      log.push(`start:${deviceId}`);
      const d = delays[deviceId] ?? 10;
      await new Promise((r) => setTimeout(r, d === 'fail' ? 5 : d));
      if (d === 'fail') {
        log.push(`fail:${deviceId}`);
        throw new Error('boom');
      }
      log.push(`end:${deviceId}`);
    },
    getState: () => undefined,
    subscribe: () => () => undefined,
  };
  return { bus, log };
}

describe('executePlan', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts independent steps together and proceeds as soon as each is ready', async () => {
    const { bus, log } = makeBus({ 'dev-a': 100, 'dev-b': 20, 'dev-c': 20 });
    const done = executePlan(
      plan([
        ['a', []],
        ['b', []],
        ['c', ['b']],
      ]),
      bus,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['start:dev-a', 'start:dev-b']);
    await vi.advanceTimersByTimeAsync(20);
    // c starts the moment b is ready, without waiting for the slower a.
    expect(log).toContain('start:dev-c');
    expect(log).not.toContain('end:dev-a');
    await vi.advanceTimersByTimeAsync(100);
    const result = await done;
    expect(result.ok).toBe(true);
    expect(result.results.map((r) => r.status)).toEqual(['done', 'done', 'done'].map(String));
  });

  it('runs a dependent only after its dependency finished', async () => {
    const { bus, log } = makeBus({ 'dev-a': 50, 'dev-b': 10 });
    const done = executePlan(
      plan([
        ['a', []],
        ['b', ['a']],
      ]),
      bus,
    );
    await vi.advanceTimersByTimeAsync(49);
    expect(log).toEqual(['start:dev-a']);
    await vi.advanceTimersByTimeAsync(20);
    await done;
    expect(log).toEqual(['start:dev-a', 'end:dev-a', 'start:dev-b', 'end:dev-b']);
  });

  it('skips only the dependents of a failed step', async () => {
    const { bus } = makeBus({ 'dev-a': 'fail' });
    const done = executePlan(
      plan([
        ['a', []],
        ['b', ['a']],
        ['c', []],
        ['d', ['b']],
      ]),
      bus,
    );
    await vi.advanceTimersByTimeAsync(50);
    const result = await done;
    expect(result.ok).toBe(false);
    const status = Object.fromEntries(result.results.map((r) => [r.stepId, r.status]));
    expect(status).toEqual({ a: 'failed', b: 'skipped', c: 'done', d: 'skipped' });
    expect(result.results.find((r) => r.stepId === 'a')!.error).toBe('boom');
  });

  it('fails a step that never reports ready', async () => {
    const { bus } = makeBus({ 'dev-a': 10_000 });
    const done = executePlan(plan([['a', []]]), bus, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1001);
    const result = await done;
    expect(result.results[0]).toMatchObject({ status: 'failed', error: 'Timed out' });
  });

  it('stops issuing new commands once aborted', async () => {
    const { bus, log } = makeBus({ 'dev-a': 20 });
    const ctrl = new AbortController();
    const done = executePlan(
      plan([
        ['a', []],
        ['b', ['a']],
      ]),
      bus,
      { signal: ctrl.signal },
    );
    await vi.advanceTimersByTimeAsync(5);
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(50);
    const result = await done;
    expect(log).not.toContain('start:dev-b');
    expect(result.results.find((r) => r.stepId === 'b')!.status).toBe('skipped');
  });

  it('reports progress through hooks', async () => {
    const { bus } = makeBus();
    const events: string[] = [];
    const done = executePlan(plan([['a', []]]), bus, {
      onStepStart: (id) => events.push(`start:${id}`),
      onStepEnd: (r) => events.push(`end:${r.stepId}:${r.status}`),
    });
    await vi.advanceTimersByTimeAsync(20);
    await done;
    expect(events).toEqual(['start:a', 'end:a:done']);
  });
});
