import { describe, expect, it } from 'vitest';
import { normaliseCore, reflect } from './reflect';
import type { ProviderDeps } from './types';

const core = (status: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: 855,
  serial: '3-12345',
  name: 'Auditorium Core',
  model: 'Core 510i',
  firmware: '8.2.0',
  status,
  ...extra,
});

describe('normaliseCore', () => {
  it('reads a running Core as online with its identity', () => {
    expect(normaliseCore(core({ code: 0, message: 'Running', details: '' }))).toMatchObject({
      externalId: '855',
      name: 'Auditorium Core',
      category: 'dsp',
      make: 'QSC',
      model: 'Core 510i',
      serial: '3-12345',
      firmware: '8.2.0',
      online: true,
      issues: [],
    });
  });
  it('reads code 7 as offline with no separate fault', () => {
    expect(normaliseCore(core({ code: 7, message: 'Offline' }))).toMatchObject({
      online: false,
      issues: [],
    });
  });
  it('reads another non-zero code as a fault on a Core that is up', () => {
    expect(
      normaliseCore(core({ code: 2, message: 'Fault', details: 'Audio engine' })),
    ).toMatchObject({
      online: true,
      issues: ['Fault: Audio engine'],
    });
  });
  it('says unknown when there is no status', () => {
    expect(normaliseCore(core({}))?.online).toBeNull();
  });
  it('drops junk', () => {
    expect(normaliseCore(null)).toBeNull();
    expect(normaliseCore({ model: 'x' })).toBeNull();
  });
});

const deps = (res: Response): ProviderDeps => ({
  fetch: (async () => res) as typeof fetch,
  mtlsGet: async () => {
    throw new Error('no mtls');
  },
  now: () => 0,
});

describe('reflect provider', () => {
  const creds = { apiToken: 'x'.repeat(64) };
  it('lists Cores from the array answer', async () => {
    const out = await reflect.list(
      creds,
      deps(Response.json([core({ code: 0, message: 'Running' })])),
    );
    expect(out).toHaveLength(1);
  });
  it('explains a refused token', async () => {
    await expect(reflect.test(creds, deps(new Response('no', { status: 401 })))).rejects.toThrow(
      /refused the credentials/,
    );
  });
  it('rejects an unexpected shape', async () => {
    await expect(reflect.list(creds, deps(Response.json({ cores: [] })))).rejects.toThrow(
      /did not expect/,
    );
  });
});
