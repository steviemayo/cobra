import { describe, expect, it, vi } from 'vitest';
import { parseArp } from './arp';
import {
  AddressWatch,
  LOST_AFTER_MS,
  RETRY_FIRST_MS,
  recoverAddress,
  swapAddress,
  trackingOf,
  type AddressDeps,
  type TrackedSpec,
} from './address-tracker';
import { silentLogger } from './log';

const MAC = 'aa:bb:cc:dd:ee:01';
const OTHER = 'aa:bb:cc:dd:ee:99';
const NET = { prefix: '192.168.1', own: new Set(['192.168.1.2']) };

function deps(opts: {
  open?: string[];
  arp?: Record<string, string>;
  names?: Record<string, string>;
  dns?: Record<string, string>;
  now?: { t: number };
}): AddressDeps & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    lookupHost: async (n) => opts.dns?.[n],
    arp: async () => new Map(Object.entries(opts.arp ?? {})),
    open: async (h) => {
      opened.push(h);
      return (opts.open ?? []).includes(h);
    },
    pjlink: async (h) => ({ name: opts.names?.[h] }),
    subnets: () => [NET],
    now: () => opts.now?.t ?? Date.now(),
  };
}

const spec = (
  over: Partial<TrackedSpec['tracking']> = {},
  extra: Partial<TrackedSpec> = {},
): TrackedSpec => ({
  host: '192.168.1.50',
  port: 4352,
  tracking: { mac: MAC, name: 'Boardroom projector', ...over },
  ...extra,
});

describe('reading the ARP table', () => {
  it('reads Windows, Linux and macOS formats, skipping broadcast and incomplete entries', () => {
    const win = [
      'Interface: 192.168.1.2 --- 0x5',
      '  Internet Address      Physical Address      Type',
      '  192.168.1.1           aa-bb-cc-dd-ee-ff     dynamic',
      '  192.168.1.50          AA-BB-CC-DD-EE-01     dynamic',
      '  192.168.1.255         ff-ff-ff-ff-ff-ff     static',
      '  224.0.0.22            01-00-5e-00-00-16     static',
    ].join('\r\n');
    expect([...parseArp(win)]).toEqual([
      ['192.168.1.1', 'aa:bb:cc:dd:ee:ff'],
      ['192.168.1.50', 'aa:bb:cc:dd:ee:01'],
    ]);
    const nix = [
      '? (192.168.1.7) at aa:bb:cc:dd:ee:07 [ether] on eth0',
      '? (192.168.1.8) at <incomplete> on eth0',
      'router (192.168.1.1) at a:b:c:d:e:f on en0 ifscope [ethernet]',
    ].join('\n');
    expect([...parseArp(nix)]).toEqual([
      ['192.168.1.7', 'aa:bb:cc:dd:ee:07'],
      ['192.168.1.1', '0a:0b:0c:0d:0e:0f'],
    ]);
  });
});

describe('finding a moved device', () => {
  it('follows its hostname first', async () => {
    const d = deps({ dns: { 'proj.local': '192.168.1.61' }, open: ['192.168.1.61'] });
    expect(await recoverAddress(spec({ hostname: 'proj.local' }), new Set(), d)).toEqual({
      kind: 'moved',
      address: '192.168.1.61',
      how: 'hostname',
    });
  });

  it('ignores a hostname that still points at the old address, or at another device', async () => {
    const d = deps({ dns: { 'proj.local': '192.168.1.50' }, open: [] });
    expect(
      (await recoverAddress(spec({ hostname: 'proj.local', mac: undefined }), new Set(), d)).kind,
    ).toBe('none');
    const d2 = deps({ dns: { 'proj.local': '192.168.1.61' }, open: ['192.168.1.61'] });
    expect(
      (
        await recoverAddress(
          spec({ hostname: 'proj.local', mac: undefined }),
          new Set(['192.168.1.61']),
          d2,
        )
      ).kind,
    ).toBe('none');
  });

  it('finds its MAC already in the ARP table at another address', async () => {
    const d = deps({ arp: { '192.168.1.70': MAC }, open: ['192.168.1.70'] });
    expect(await recoverAddress(spec(), new Set(), d)).toEqual({
      kind: 'moved',
      address: '192.168.1.70',
      how: 'mac',
    });
  });

  it('sweeps the network and matches the MAC of exactly one answer', async () => {
    const d = deps({
      open: ['192.168.1.80', '192.168.1.81'],
      arp: { '192.168.1.80': OTHER, '192.168.1.81': MAC },
    });
    // The table is empty until the sweep has connected, so the first read finds nothing.
    let reads = 0;
    const real = d.arp;
    d.arp = async () => (reads++ === 0 ? new Map() : real());
    expect(await recoverAddress(spec(), new Set(), d)).toEqual({
      kind: 'moved',
      address: '192.168.1.81',
      how: 'mac',
    });
  });

  it('says none when its MAC is known and nothing answering has it', async () => {
    const d = deps({ open: ['192.168.1.80'], arp: { '192.168.1.80': OTHER } });
    expect((await recoverAddress(spec(), new Set(), d)).kind).toBe('none');
  });

  it('never takes an address another device is using', async () => {
    const d = deps({ open: ['192.168.1.80'], arp: { '192.168.1.80': MAC } });
    expect((await recoverAddress(spec(), new Set(['192.168.1.80']), d)).kind).toBe('none');
    expect(d.opened).not.toContain('192.168.1.80');
  });

  it('uses a projector name to tell it apart when there is no MAC', async () => {
    const d = deps({
      open: ['192.168.1.80', '192.168.1.81'],
      names: { '192.168.1.80': 'Training room', '192.168.1.81': 'boardroom projector' },
    });
    expect(await recoverAddress(spec({ mac: undefined }, { pjlink: true }), new Set(), d)).toEqual({
      kind: 'moved',
      address: '192.168.1.81',
      how: 'identity',
    });
  });

  it('offers candidates, and adopts none, when it cannot tell which one is the device', async () => {
    const d = deps({ open: ['192.168.1.80', '192.168.1.81'] });
    const r = await recoverAddress(spec({ mac: undefined }), new Set(), d);
    expect(r.kind).toBe('ambiguous');
    expect(r.kind === 'ambiguous' && r.candidates.map((c) => c.address)).toEqual([
      '192.168.1.80',
      '192.168.1.81',
    ]);
  });

  it('cannot sweep a network the gateway is not on, or a device with no known port', async () => {
    const off = deps({ open: ['10.9.9.9'] });
    expect((await recoverAddress(spec({}, { host: '10.1.1.5' }), new Set(), off)).kind).toBe(
      'none',
    );
    expect((await recoverAddress(spec({}, { port: undefined }), new Set(), deps({}))).kind).toBe(
      'none',
    );
  });
});

describe('watching tracked devices', () => {
  const claimed = new Set<string>();

  it('waits, searches, and keeps saying where it found the device until the cloud catches up', async () => {
    const now = { t: 1_000_000 };
    const d = deps({ arp: { '192.168.1.70': MAC }, open: ['192.168.1.70'], now });
    const moved = vi.fn();
    const w = new AddressWatch(silentLogger, d, moved);
    w.track('dev', spec());
    await w.tick(() => false, claimed);
    expect(moved).not.toHaveBeenCalled(); // only just went quiet
    now.t += LOST_AFTER_MS + 1;
    await w.tick(() => false, claimed);
    expect(moved).toHaveBeenCalledWith('dev');
    expect(w.override('dev')).toEqual({ from: '192.168.1.50', to: '192.168.1.70' });
    expect(w.report('dev')?.change).toEqual({
      from: '192.168.1.50',
      to: '192.168.1.70',
      how: 'mac',
    });
    // The cloud's next set still has the old address: the move is still reported.
    w.track('dev', spec());
    expect(w.report('dev')?.change?.to).toBe('192.168.1.70');
    // Once the set carries the new address, it stops.
    w.track('dev', spec({}, { host: '192.168.1.70' }));
    expect(w.override('dev')).toBeNull();
    expect(w.report('dev')?.change).toBeUndefined();
  });

  it('backs off after a search finds nothing, and "Find again" skips the wait', async () => {
    const now = { t: 1_000_000 };
    const d = deps({ now });
    const w = new AddressWatch(silentLogger, d);
    w.track('dev', spec());
    await w.tick(() => false, claimed);
    now.t += LOST_AFTER_MS + 1;
    await w.tick(() => false, claimed);
    expect(w.report('dev')?.issue).toBe('not_found');
    const before = d.opened.length;
    now.t += 5_000;
    await w.tick(() => false, claimed);
    expect(d.opened.length).toBe(before); // still backing off
    w.track('dev', spec({ refindAt: '2026-10-03T09:00:00Z' }));
    await w.tick(() => false, claimed);
    expect(d.opened.length).toBeGreaterThan(before);
    expect(RETRY_FIRST_MS).toBeGreaterThan(5_000);
  });

  it('learns the MAC of a healthy device and clears a problem once it is back', async () => {
    const now = { t: 1_000_000 };
    const d = deps({ arp: { '192.168.1.50': MAC }, now });
    const w = new AddressWatch(silentLogger, d);
    w.track('dev', spec({ mac: undefined }));
    await w.tick(() => true, claimed);
    expect(w.report('dev')?.mac).toBe(MAC);
    expect(w.report('dev')?.issue).toBeUndefined();
  });

  it('notices when another device answers at its address', async () => {
    const now = { t: 1_000_000 };
    const d = deps({ arp: { '192.168.1.50': OTHER }, now });
    const w = new AddressWatch(silentLogger, d);
    w.track('dev', spec());
    await w.tick(() => true, claimed);
    expect(w.identityChanged('dev')).toBe(true);
    expect(w.report('dev')?.issue).toBe('identity_changed');
  });

  it('does not watch a fixed device', () => {
    const w = new AddressWatch(silentLogger, deps({}));
    w.track('dev', undefined);
    expect(w.report('dev')).toBeUndefined();
    expect(w.override('dev')).toBeNull();
  });
});

describe('settings helpers', () => {
  it('reads the tracking details and swaps only the address that matched', () => {
    expect(trackingOf({ host: 'x' })).toBeUndefined();
    expect(trackingOf({ addressTracking: { mac: MAC, hostname: 'p.local' } })).toMatchObject({
      mac: MAC,
    });
    expect(swapAddress({ host: '1.1.1.1', ip: '9.9.9.9', port: 1 }, '1.1.1.1', '2.2.2.2')).toEqual({
      host: '2.2.2.2',
      ip: '9.9.9.9',
      port: 1,
    });
  });
});
