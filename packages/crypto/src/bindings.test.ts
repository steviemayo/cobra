import { describe, expect, it } from 'vitest';
import type { PublicKey } from '@kestrel/model';
import { generateKeyPair, signBindings, verifyBindings } from './index';

const keys = generateKeyPair();
const signing = { privateKeyPem: keys.privateKeyPem, keyId: 'k1' };
const trusted: PublicKey[] = [{ keyId: 'k1', publicKeyPem: keys.publicKeyPem }];
/** What actually crosses the wire. */
const wire = (v: unknown) => JSON.parse(JSON.stringify(v)) as Record<string, unknown>;

const payload = () => ({
  orgId: '11111111-1111-4111-8111-111111111111',
  roomId: '33333333-3333-4333-8333-333333333331',
  version: 3,
  devices: { dsp: { host: '10.0.0.5', password: 'hunter2' } },
});

describe('signed bindings', () => {
  it('verify after a trip over the wire', () => {
    const r = verifyBindings(wire(signBindings(payload(), signing)), trusted);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.signed.payload.devices.dsp).toEqual({ host: '10.0.0.5', password: 'hunter2' });
  });

  it('are refused when an address is changed', () => {
    const signed = wire(signBindings(payload(), signing)) as {
      payload: { devices: { dsp: { host: string } } };
    };
    signed.payload.devices.dsp.host = '10.9.9.9';
    expect(verifyBindings(signed, trusted)).toEqual({ ok: false, reason: 'hash_mismatch' });
  });

  it('are refused from an untrusted key, with a wrong signature, or when malformed', () => {
    const good = wire(signBindings(payload(), signing));
    expect(verifyBindings(good, [])).toEqual({ ok: false, reason: 'unknown_key' });
    const other = generateKeyPair();
    expect(verifyBindings(good, [{ keyId: 'k1', publicKeyPem: other.publicKeyPem }])).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verifyBindings({ nope: true }, trusted)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('are not accepted as a manifest, and a manifest is not accepted as bindings', () => {
    const good = wire(signBindings(payload(), signing));
    expect((good as { manifest?: unknown }).manifest).toBeUndefined();
    expect(verifyBindings({ ...good, payload: { ...payload(), version: 0 } }, trusted).ok).toBe(false);
  });
});
