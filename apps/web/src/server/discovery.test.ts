import { describe, expect, it } from 'vitest';
import { BUILT_IN_DRIVERS, DeviceCategory } from '@kestrel/model';
import {
  MAX_FOUND,
  annotateFound,
  normaliseHost,
  parseDiscoveryOutput,
  parseSubnet,
  suggestForFound,
} from './discovery';
import { discoveryResult, type DiscoveryDb } from './discovery-service';
import { table } from './test-db';

describe('parseSubnet', () => {
  it('accepts three numbers in a private range', () => {
    for (const s of ['10.0.0', '192.168.1', '172.16.5', '172.31.255', ' 192.168.20 '])
      expect(parseSubnet(s)).toBe(s.trim());
  });
  it('refuses anything else', () => {
    for (const s of [
      '8.8.8',
      '172.15.1',
      '172.32.1',
      '192.169.1',
      '256.1.1',
      '10.0.0.0',
      '10.0',
      '192.168.1.0/24',
      '',
      'x.y.z',
      '../etc',
    ])
      expect(parseSubnet(s)).toBeNull();
  });
});

describe('suggestForFound', () => {
  it('maps each known port', () => {
    expect(suggestForFound({ ports: [4352] })).toMatchObject({
      kind: 'active',
      category: 'projector',
      driver: 'pjlink',
    });
    expect(suggestForFound({ ports: [1710] })).toMatchObject({
      kind: 'active',
      category: 'audio_matrix',
      driver: 'qsys-core',
    });
    expect(suggestForFound({ ports: [22023] })).toMatchObject({ driver: 'lib:extron-sis' });
    expect(suggestForFound({ ports: [5000] })).toMatchObject({ driver: 'lib:kramer-p3000' });
    expect(suggestForFound({ ports: [23] })).toMatchObject({
      kind: 'passive',
      note: 'Telnet device: choose a driver',
    });
    expect(suggestForFound({ ports: [2202] })).toMatchObject({ kind: 'passive', make: 'Shure' });
    expect(suggestForFound({ ports: [] })).toBeNull();
    expect(suggestForFound({ ports: [80] })).toBeNull();
  });
  it('lets the most specific port win', () => {
    expect(suggestForFound({ ports: [23, 22023] })?.driver).toBe('lib:extron-sis');
    expect(suggestForFound({ ports: [23, 4352] })?.driver).toBe('pjlink');
    expect(suggestForFound({ ports: [4352, 1710] })?.driver).toBe('qsys-core');
  });
  it('only names real categories and drivers', () => {
    for (const ports of [[4352], [1710], [22023], [5000], [23], [2202]]) {
      const s = suggestForFound({ ports })!;
      if (s.category) expect(DeviceCategory.options).toContain(s.category);
      if (s.driver && s.driver !== 'pjlink')
        expect(Object.keys(BUILT_IN_DRIVERS)).toContain(s.driver);
    }
  });
});

describe('parseDiscoveryOutput', () => {
  it('reads a good answer', () => {
    const r = parseDiscoveryOutput({
      subnets: ['192.168.1'],
      hostsScanned: 253,
      truncated: false,
      found: [{ host: '192.168.1.20', ports: [4352], kind: 'projector', name: 'Lens 1' }],
    });
    expect(r).toMatchObject({ subnets: ['192.168.1'], hostsScanned: 253, truncated: false });
    expect(r.found).toHaveLength(1);
  });
  it('survives rubbish', () => {
    for (const bad of [null, undefined, 'x', 5, [], { found: 'nope' }, { found: [1, null, {}] }])
      expect(parseDiscoveryOutput(bad).found).toEqual([]);
    const r = parseDiscoveryOutput({
      found: [{ host: '10.0.0.5', ports: 'x', name: 42 }, { host: '' }, { ports: [1] }],
      hostsScanned: 'many',
    });
    expect(r.found).toEqual([{ host: '10.0.0.5', ports: [] }]);
    expect(r.hostsScanned).toBe(0);
  });
  it('caps the list and the text', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ host: `10.0.0.${i}`, ports: [23] }));
    const r = parseDiscoveryOutput({ found: many });
    expect(r.found).toHaveLength(MAX_FOUND);
    expect(r.truncated).toBe(true);
    const long = parseDiscoveryOutput({
      found: [{ host: '10.0.0.1', ports: [], name: 'x'.repeat(500) }],
    });
    expect(long.found[0]!.name).toBeUndefined();
  });
});

describe('annotateFound', () => {
  const register = [
    { id: 'd1', name: 'Projector', ip: null, values: { host: '192.168.1.20' } },
    { id: 'd2', name: 'DSP', ip: null, values: { address: ' 192.168.1.30:1710 ' } },
    { id: 'd3', name: 'Asset', ip: '192.168.1.40', values: null },
    { id: 'd4', name: 'Odd', ip: null, values: { ip: 7 } },
  ];
  it('matches by connection settings or recorded ip, after cleaning', () => {
    const out = annotateFound(
      [
        { host: '192.168.1.20', ports: [4352] },
        { host: '192.168.1.30', ports: [1710] },
        { host: '192.168.1.40', ports: [23] },
        { host: '192.168.1.50', ports: [5000] },
      ],
      register,
    );
    expect(out.map((o) => o.existing?.id ?? null)).toEqual(['d1', 'd2', 'd3', null]);
    expect(out[3]!.suggestion?.driver).toBe('lib:kramer-p3000');
  });
  it('normalises hosts', () => {
    expect(normaliseHost(' 192.168.1.5:4352 ')).toBe('192.168.1.5');
    expect(normaliseHost('Room-DSP.local')).toBe('room-dsp.local');
    expect(normaliseHost(null)).toBe('');
  });
});

describe('discoveryResult', () => {
  const ORG = '11111111-1111-4111-8111-111111111111';
  const GW = '99999999-9999-4999-8999-999999999991';
  const SITE = '22222222-2222-4222-8222-222222222221';
  const CMD = '55555555-5555-4555-8555-555555555551';
  function world(over: Record<string, unknown> = {}) {
    return {
      remoteCommand: table([
        {
          id: CMD,
          orgId: ORG,
          gatewayId: GW,
          type: 'discover_devices',
          status: 'succeeded',
          error: null,
          output: {
            subnets: ['192.168.1'],
            hostsScanned: 253,
            found: [{ host: '192.168.1.20', ports: [4352] }],
          },
          ...over,
        },
        {
          id: 'other',
          orgId: ORG,
          gatewayId: GW,
          type: 'diagnostics',
          status: 'succeeded',
          output: {},
        },
      ]),
      gateway: table([{ id: GW, orgId: ORG, siteId: SITE }]),
      device: table([
        {
          id: 'd1',
          orgId: ORG,
          siteId: SITE,
          name: 'Proj',
          ip: null,
          values: { host: '192.168.1.20' },
        },
      ]),
    } as unknown as DiscoveryDb;
  }
  const ask = (db: DiscoveryDb, o: Record<string, unknown> = {}) =>
    discoveryResult(db, { orgId: ORG, commandId: CMD, siteScope: null, ...o });

  it('annotates a finished scan', async () => {
    const r = await ask(world());
    expect(r?.found[0]).toMatchObject({ host: '192.168.1.20', existing: { id: 'd1' } });
  });
  it('is not found for another org, another type, or a site out of scope', async () => {
    expect(await ask(world(), { orgId: '11111111-1111-4111-8111-111111111112' })).toBeNull();
    expect(await ask(world(), { commandId: 'other' })).toBeNull();
    expect(await ask(world(), { siteScope: ['22222222-2222-4222-8222-222222222299'] })).toBeNull();
    expect((await ask(world(), { siteScope: [SITE] }))?.found).toHaveLength(1);
  });
  it('reports a failure and a running scan without a list', async () => {
    const failed = await ask(
      world({ status: 'failed', error: 'The gateway is not on that network' }),
    );
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'The gateway is not on that network',
      found: [],
    });
    expect((await ask(world({ status: 'sent' })))?.found).toEqual([]);
  });
});
