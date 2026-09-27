import { describe, expect, it } from 'vitest';
import {
  BrandError,
  BrandInput,
  getProviderBrand,
  orgPanelBranding,
  portalBrandFor,
  saveProviderBrand,
  setUseBrand,
  withProviderBrand,
  type BrandDb,
} from './provider-brand';
import { table } from './test-db';

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const OTHER_CUSTOMER = '11111111-1111-4111-8111-111111111112';
const MSP = '22222222-2222-4222-8222-222222222221';
const MSP2 = '22222222-2222-4222-8222-222222222222';
const USER = '77777777-7777-4777-8777-777777777771';
const G1 = '88888888-8888-4888-8888-888888888881';
const G2 = '88888888-8888-4888-8888-888888888882';

function world() {
  const org = table([
    { id: CUSTOMER, name: 'Acme', kind: 'customer', branding: null },
    { id: OTHER_CUSTOMER, name: 'Other', kind: 'customer', branding: null },
    { id: MSP, name: 'AV Partners Pty Ltd', kind: 'msp' },
    { id: MSP2, name: 'Second Provider', kind: 'msp' },
  ]);
  const mspGrant = table([
    { id: G1, mspOrgId: MSP, customerOrgId: CUSTOMER, status: 'active', useBrand: false },
    { id: G2, mspOrgId: MSP2, customerOrgId: CUSTOMER, status: 'active', useBrand: false },
  ]);
  const providerBrand = table([]);
  const auditLog = table([]);
  return {
    db: { org, mspGrant, providerBrand, auditLog } as unknown as BrandDb,
    org,
    mspGrant,
    providerBrand,
    auditLog,
  };
}
const brand = { name: 'AV Partners', logoUrl: 'https://cdn.example/logo.png', accent: '#e4572e' };

describe('a provider’s brand', () => {
  it('is saved and replaced, with an audit entry', async () => {
    const w = world();
    await saveProviderBrand(w.db, { mspOrgId: MSP, input: brand, actorId: USER });
    expect(await getProviderBrand(w.db, MSP)).toEqual(brand);
    await saveProviderBrand(w.db, {
      mspOrgId: MSP,
      input: { name: 'AV Partners AU' },
      actorId: USER,
    });
    expect(w.providerBrand.rows).toHaveLength(1);
    expect(await getProviderBrand(w.db, MSP)).toEqual({
      name: 'AV Partners AU',
      logoUrl: null,
      accent: null,
    });
    expect(w.auditLog.rows.map((r) => r.action)).toEqual(['msp.brand', 'msp.brand']);
  });

  it('belongs only to service providers', async () => {
    const w = world();
    await expect(
      saveProviderBrand(w.db, { mspOrgId: CUSTOMER, input: brand, actorId: USER }),
    ).rejects.toBeInstanceOf(BrandError);
  });

  it('accepts only an https logo and a real colour', () => {
    expect(BrandInput.safeParse(brand).success).toBe(true);
    for (const logoUrl of [
      'http://x.example/l.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'https://x.example/a b.png',
      'https://x.example/"onload=1',
    ])
      expect(BrandInput.safeParse({ ...brand, logoUrl }).success, logoUrl).toBe(false);
    for (const accent of ['red', '#12', 'url(x)', '#12345g'])
      expect(BrandInput.safeParse({ ...brand, accent }).success, accent).toBe(false);
    expect(BrandInput.safeParse({ name: '   ' }).success).toBe(false);
  });
});

describe('who sees a brand', () => {
  it('a customer sees nothing until its owner turns a provider’s brand on', async () => {
    const w = world();
    await saveProviderBrand(w.db, { mspOrgId: MSP, input: brand, actorId: USER });
    expect(await portalBrandFor(w.db, CUSTOMER)).toBeNull();
    await setUseBrand(w.db, { customerOrgId: CUSTOMER, grantId: G1, on: true, actorId: USER });
    expect(await portalBrandFor(w.db, CUSTOMER)).toEqual({
      mspOrgId: MSP,
      name: 'AV Partners',
      logoUrl: 'https://cdn.example/logo.png',
      accent: '#e4572e',
    });
    // Another customer of the same provider is unaffected.
    expect(await portalBrandFor(w.db, OTHER_CUSTOMER)).toBeNull();
  });

  it('a provider always wears its own brand', async () => {
    const w = world();
    expect(await portalBrandFor(w.db, MSP)).toBeNull();
    await saveProviderBrand(w.db, { mspOrgId: MSP, input: { name: 'AV Partners' }, actorId: USER });
    expect(await portalBrandFor(w.db, MSP)).toEqual({ mspOrgId: MSP, name: 'AV Partners' });
  });

  it('only one provider’s brand at a time, and the audit log says what changed', async () => {
    const w = world();
    await saveProviderBrand(w.db, { mspOrgId: MSP, input: brand, actorId: USER });
    await saveProviderBrand(w.db, { mspOrgId: MSP2, input: { name: 'Second' }, actorId: USER });
    await setUseBrand(w.db, { customerOrgId: CUSTOMER, grantId: G1, on: true, actorId: USER });
    await setUseBrand(w.db, { customerOrgId: CUSTOMER, grantId: G2, on: true, actorId: USER });
    expect(w.mspGrant.rows.map((g) => g.useBrand)).toEqual([false, true]);
    expect((await portalBrandFor(w.db, CUSTOMER))?.name).toBe('Second');
    await setUseBrand(w.db, { customerOrgId: CUSTOMER, grantId: G2, on: false, actorId: USER });
    expect(await portalBrandFor(w.db, CUSTOMER)).toBeNull();
    const log = w.auditLog.rows.filter((r) => String(r.action).startsWith('msp.brand_'));
    expect(log.map((r) => r.action)).toEqual(['msp.brand_on', 'msp.brand_on', 'msp.brand_off']);
    expect(log[0]).toMatchObject({ orgId: CUSTOMER, meta: { msp: 'AV Partners Pty Ltd' } });
  });

  it('stops the moment the connection ends', async () => {
    const w = world();
    await saveProviderBrand(w.db, { mspOrgId: MSP, input: brand, actorId: USER });
    await setUseBrand(w.db, { customerOrgId: CUSTOMER, grantId: G1, on: true, actorId: USER });
    w.mspGrant.rows[0]!.status = 'ended';
    expect(await portalBrandFor(w.db, CUSTOMER)).toBeNull();
  });

  it('cannot be turned on for another organisation’s connection, an inactive one, or a provider with no brand', async () => {
    const w = world();
    await expect(
      setUseBrand(w.db, { customerOrgId: OTHER_CUSTOMER, grantId: G1, on: true, actorId: USER }),
    ).rejects.toBeInstanceOf(BrandError);
    await expect(
      setUseBrand(w.db, { customerOrgId: CUSTOMER, grantId: G1, on: true, actorId: USER }),
    ).rejects.toThrow(/not set up/);
    await saveProviderBrand(w.db, { mspOrgId: MSP, input: brand, actorId: USER });
    w.mspGrant.rows[0]!.status = 'pending';
    await expect(
      setUseBrand(w.db, { customerOrgId: CUSTOMER, grantId: G1, on: true, actorId: USER }),
    ).rejects.toThrow(/not active/);
    expect(w.mspGrant.rows[0]!.useBrand).toBe(false);
  });
});

describe('panels', () => {
  const portal = {
    mspOrgId: MSP,
    name: 'AV Partners',
    logoUrl: 'https://cdn.example/logo.png',
    accent: '#e4572e',
  };

  it('keep the customer’s own logo and colour, and take the provider’s where it set none', () => {
    const own = { mode: 'light' as const, language: 'fr', accent: '#112233' };
    expect(withProviderBrand(own, portal)).toEqual({
      mode: 'light',
      language: 'fr',
      accent: '#112233',
      logoUrl: 'https://cdn.example/logo.png',
    });
    expect(withProviderBrand({ mode: 'dark', language: 'en' }, portal)).toEqual({
      mode: 'dark',
      language: 'en',
      logoUrl: 'https://cdn.example/logo.png',
      accent: '#e4572e',
    });
    expect(withProviderBrand(own, null)).toBe(own);
  });

  it('use the chosen provider’s brand as the starting look', async () => {
    const w = world();
    await saveProviderBrand(w.db, { mspOrgId: MSP, input: brand, actorId: USER });
    expect(await orgPanelBranding(w.db, CUSTOMER, { mode: 'light', language: 'en' })).toEqual({
      mode: 'light',
      language: 'en',
    });
    await setUseBrand(w.db, { customerOrgId: CUSTOMER, grantId: G1, on: true, actorId: USER });
    expect(await orgPanelBranding(w.db, CUSTOMER, { mode: 'light', language: 'en' })).toMatchObject(
      {
        mode: 'light',
        logoUrl: 'https://cdn.example/logo.png',
        accent: '#e4572e',
      },
    );
  });
});
