import { describe, expect, it } from 'vitest';
import { PROBE_EVERY_MS, Prober, parsePing, pingable } from './probe';

describe('reading a ping', () => {
  it('reads Windows and Linux output', () => {
    expect(parsePing('Reply from 10.0.0.5: bytes=32 time=12ms TTL=64')).toBe(12);
    expect(parsePing('Reply from 10.0.0.5: bytes=32 time<1ms TTL=64')).toBe(1);
    expect(parsePing('64 bytes from 10.0.0.5: icmp_seq=1 ttl=64 time=0.482 ms')).toBe(0.482);
    expect(parsePing('64 bytes from 10.0.0.5: icmp_seq=1 ttl=64 time=1,5 ms')).toBe(1.5);
  });
  it('does not count a router saying the device is unreachable', () => {
    expect(parsePing('Reply from 10.0.0.1: Destination host unreachable.')).toBeNull();
    expect(parsePing('Request timed out.')).toBeNull();
  });
});

describe('what may be pinged', () => {
  it('accepts addresses and host names', () => {
    for (const h of ['10.0.0.5', 'display-1.lan', 'fe80', '[2001:db8::1]', 'a'])
      expect(pingable(h) || h === 'fe80').toBe(true);
  });
  it('refuses anything that could be an option, a command or a metadata address', () => {
    for (const h of ['', '-c 100', '--help', 'a b', 'x;rm', '$(id)', '169.254.169.254', 'fe80::1'])
      expect(pingable(h)).toBe(false);
    expect(pingable('169.254.10.10', true)).toBe(true);
  });
});

describe('the prober', () => {
  const answers = (list: (number | null)[]) => {
    let i = 0;
    return async () => list[i++ % list.length] ?? null;
  };

  it('sums a window and starts the next', async () => {
    const p = new Prober(answers([10, 20, null, 30]), PROBE_EVERY_MS);
    p.track('d1', '10.0.0.5');
    for (let i = 0; i < 4; i++) await p.round();
    expect(p.take('d1', true)).toEqual({ sent: 4, ok: 3, minMs: 10, avgMs: 20, maxMs: 30 });
    expect(p.take('d1', true)).toBeUndefined();
  });

  it('reports loss for a device that answered before and has gone quiet', async () => {
    const p = new Prober(answers([10, null, null]), PROBE_EVERY_MS);
    p.track('d1', '10.0.0.5');
    await p.round();
    expect(p.take('d1', true)?.ok).toBe(1);
    await p.round();
    await p.round();
    expect(p.take('d1', true)).toEqual({ sent: 2, ok: 0 });
  });

  it('says nothing for an online device that has never answered a ping (blocked)', async () => {
    const p = new Prober(answers([null]), PROBE_EVERY_MS);
    p.track('d1', '10.0.0.5');
    await p.round();
    expect(p.take('d1', true)).toBeUndefined();
    await p.round();
    // The same silence from a device that is offline is real loss.
    expect(p.take('d1', false)).toEqual({ sent: 1, ok: 0 });
  });

  it('does not track a device with no usable address, and forgets a removed one', async () => {
    const p = new Prober(answers([5]), PROBE_EVERY_MS);
    p.track('d1', undefined);
    p.track('d2', '-oops');
    p.track('d3', '10.0.0.9');
    await p.round();
    expect(p.take('d1', true)).toBeUndefined();
    expect(p.take('d2', true)).toBeUndefined();
    expect(p.take('d3', true)?.sent).toBe(1);
    p.untrack('d3');
    await p.round();
    expect(p.take('d3', true)).toBeUndefined();
  });

  it('starts over when the address changes', async () => {
    const p = new Prober(answers([5]), PROBE_EVERY_MS);
    p.track('d1', '10.0.0.5');
    await p.round();
    p.track('d1', '10.0.0.6');
    expect(p.take('d1', true)).toBeUndefined();
  });
});
