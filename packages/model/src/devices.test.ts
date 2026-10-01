import { describe, expect, it } from 'vitest';
import {
  deviceLiveState,
  identityFromDetails,
  mergeDiscovered,
  mergeManual,
  resolveGatewayId,
} from './devices';

const now = '2026-09-30T00:00:00.000Z';

describe('mergeDiscovered', () => {
  it('fills an empty field from the device without calling it a swap', () => {
    const r = mergeDiscovered('serial', { value: null }, 'ABC123', now);
    expect(r.value).toBe('ABC123');
    expect(r.provenance?.source).toBe('discovered');
    expect(r.change).toMatchObject({ oldValue: null, newValue: 'ABC123', possibleSwap: false });
  });

  it('flags a changed serial as a possible swap', () => {
    const r = mergeDiscovered(
      'serial',
      { value: 'ABC123', provenance: { source: 'discovered', at: now } },
      'XYZ789',
      now,
    );
    expect(r.value).toBe('XYZ789');
    expect(r.change?.possibleSwap).toBe(true);
  });

  it('does not flag a changed firmware as a swap', () => {
    const r = mergeDiscovered(
      'firmware',
      { value: '1.0', provenance: { source: 'discovered', at: now } },
      '1.1',
      now,
    );
    expect(r.change).toMatchObject({ oldValue: '1.0', newValue: '1.1', possibleSwap: false });
  });

  it('never overwrites a manual value, and records the disagreement', () => {
    const r = mergeDiscovered(
      'serial',
      { value: 'TYPED', provenance: { source: 'manual', at: now } },
      'REAL',
      now,
    );
    expect(r.value).toBe('TYPED');
    expect(r.provenance).toMatchObject({ source: 'manual', discovered: 'REAL' });
    expect(r.change).toBeUndefined();
  });

  it('clears the mismatch when the device comes to agree with the manual value', () => {
    const r = mergeDiscovered(
      'serial',
      { value: 'SAME', provenance: { source: 'manual', discovered: 'OLD', at: now } },
      'same',
      now,
    );
    expect(r.provenance).toEqual({ source: 'manual', at: now });
  });

  it('compares MACs without separators or case', () => {
    const r = mergeDiscovered(
      'mac',
      { value: 'AA:BB:CC:00:11:22', provenance: { source: 'discovered', at: now } },
      'aa-bb-cc-00-11-22',
      now,
    );
    expect(r.change).toBeUndefined();
  });

  it('ignores a device that reports nothing', () => {
    const r = mergeDiscovered('serial', { value: 'KEEP' }, undefined, now);
    expect(r.value).toBe('KEEP');
    expect(r.change).toBeUndefined();
  });
});

describe('mergeManual', () => {
  it('records a typed value as manual', () => {
    const r = mergeManual('serial', { value: null }, ' S1 ', now, 'user-1');
    expect(r.value).toBe('S1');
    expect(r.provenance).toMatchObject({ source: 'manual', by: 'user-1' });
    expect(r.change?.possibleSwap).toBe(false);
  });

  it('flags editing an existing serial', () => {
    const r = mergeManual('serial', { value: 'A', provenance: { source: 'manual', at: now } }, 'B', now);
    expect(r.change?.possibleSwap).toBe(true);
  });

  it('keeps the device reading beside a value that disagrees', () => {
    const r = mergeManual(
      'serial',
      { value: 'DEV1', provenance: { source: 'discovered', at: now } },
      'MINE',
      now,
    );
    expect(r.provenance).toMatchObject({ source: 'manual', discovered: 'DEV1' });
  });

  it('goes back to discovered when the typed value matches the device', () => {
    const r = mergeManual(
      'serial',
      { value: 'MINE', provenance: { source: 'manual', discovered: 'DEV1', at: now } },
      'dev1',
      now,
    );
    expect(r.provenance?.source).toBe('discovered');
  });

  it('does nothing when the value is unchanged', () => {
    const r = mergeManual('model', { value: 'X', provenance: { source: 'manual', at: now } }, 'x', now);
    expect(r.change).toBeUndefined();
  });

  it('clears a field', () => {
    const r = mergeManual('model', { value: 'X', provenance: { source: 'manual', at: now } }, '', now);
    expect(r.value).toBeNull();
    expect(r.provenance).toBeUndefined();
  });
});

describe('identityFromDetails', () => {
  it('reads serial, MAC and model from whatever sections a driver sends', () => {
    const id = identityFromDetails([
      {
        title: 'Device',
        rows: [
          { label: 'Model', value: 'DM-NVX-360' },
          { label: 'Serial number', value: '1234ABCD' },
          { label: 'MAC address', value: 'aa:bb:cc:dd:ee:ff' },
          { label: 'Uptime', value: '3 days' },
        ],
      },
    ]);
    expect(id).toEqual({ model: 'DM-NVX-360', serial: '1234ABCD', mac: 'aa:bb:cc:dd:ee:ff' });
  });

  it('returns nothing for no details', () => {
    expect(identityFromDetails(undefined)).toEqual({});
  });
});

describe('gateway resolution and state', () => {
  it('prefers the device gateway, then the room, then the site', () => {
    expect(resolveGatewayId({ deviceGatewayId: 'd', roomGatewayId: 'r', siteGatewayId: 's' })).toBe('d');
    expect(resolveGatewayId({ roomGatewayId: 'r', siteGatewayId: 's' })).toBe('r');
    expect(resolveGatewayId({ siteGatewayId: 's' })).toBe('s');
    expect(resolveGatewayId({})).toBeNull();
  });

  it('shows unknown when the gateway is down, and none for passive devices', () => {
    expect(deviceLiveState({ kind: 'active', online: true, gatewayOnline: false })).toBe('unknown');
    expect(deviceLiveState({ kind: 'active', online: false, gatewayOnline: true })).toBe('offline');
    expect(deviceLiveState({ kind: 'active', online: true, gatewayOnline: true })).toBe('online');
    expect(deviceLiveState({ kind: 'active', online: null, gatewayOnline: true })).toBe('unknown');
    expect(deviceLiveState({ kind: 'passive', online: null, gatewayOnline: true })).toBe('none');
  });
});
