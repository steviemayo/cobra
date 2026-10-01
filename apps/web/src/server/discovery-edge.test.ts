import { describe, expect, it } from 'vitest';
import { MAX_FOUND, normaliseHost, parseDiscoveryOutput, parseSubnet } from './discovery';
import { discoveryResult, type DiscoveryDb } from './discovery-service';
import { table } from './test-db';

describe('parseSubnet edge cases', () => {
  it('rejects four-digit and signed octets, inner spaces, newlines, non-ASCII digits and stray dots', () => {
    for (const s of [
      '0192.168.1',
      '192.168.0001',
      '+10.0.0',
      '-10.0.0',
      '10. 0.0',
      '10.0.0\n10.0.1',
      '１０.0.0',
      '10.0.0.',
      '.10.0.0',
      '10..0',
      '1e1.0.0',
      '0x0a.0.0',
    ])
      expect(parseSubnet(s)).toBeNull();
  });
  it('normalises leading zeros instead of passing them on (no octal surprises)', () => {
    expect(parseSubnet('010.000.001')).toBe('10.0.1');
    expect(parseSubnet('192.168.001')).toBe('192.168.1');
    expect(parseSubnet('172.016.5')).toBe('172.16.5');
  });
  it('refuses loopback, link-local, carrier-grade NAT, multicast and zero', () => {
    for (const s of ['127.0.0', '169.254.1', '100.64.0', '224.0.0', '0.0.0', '255.255.255'])
      expect(parseSubnet(s)).toBeNull();
  });
  it('keeps the private range edges', () => {
    expect(parseSubnet('10.255.255')).toBe('10.255.255');
    expect(parseSubnet('172.16.0')).toBe('172.16.0');
    expect(parseSubnet('192.168.0')).toBe('192.168.0');
    expect(parseSubnet('172.0.16')).toBeNull();
  });
});

describe('parseDiscoveryOutput untrusted input', () => {
  it('drops hosts that are blank or too long, and ignores unknown fields', () => {
    const r = parseDiscoveryOutput({
      found: [
        { host: '   ', ports: [80] },
        { host: 'x'.repeat(65), ports: [] },
        { host: '10.0.0.5', ports: [80], evil: '<script>' },
        'text',
        null,
        42,
      ],
    });
    expect(r.found).toHaveLength(1);
    expect(r.found[0]).not.toHaveProperty('evil');
  });
  it('replaces bad ports and fields instead of failing the whole row', () => {
    const r = parseDiscoveryOutput({
      found: [{ host: '10.0.0.5', ports: [0, 70000, 'a'], name: { x: 1 }, kind: 'y'.repeat(101) }],
    });
    expect(r.found[0]).toMatchObject({ host: '10.0.0.5', ports: [] });
    expect(r.found[0]!.name).toBeUndefined();
    expect(r.found[0]!.kind).toBeUndefined();
  });
  it('clamps absurd counts and reads non-array shapes as empty', () => {
    expect(parseDiscoveryOutput({ hostsScanned: -5, found: 'x', subnets: 'y' })).toMatchObject({
      hostsScanned: 0,
      found: [],
      subnets: [],
    });
    expect(parseDiscoveryOutput({ hostsScanned: 1e12 }).hostsScanned).toBe(1_000_000);
    expect(parseDiscoveryOutput({ hostsScanned: NaN }).hostsScanned).toBe(0);
  });
  it('flags truncation when the gateway sent more than the cap', () => {
    const found = Array.from({ length: MAX_FOUND + 1 }, (_, i) => ({
      host: `10.0.${i}.1`,
      ports: [],
    }));
    const r = parseDiscoveryOutput({ found });
    expect(r.found).toHaveLength(MAX_FOUND);
    expect(r.truncated).toBe(true);
  });
  it('compares addresses without a port, case or spaces', () => {
    expect(normaliseHost(' 10.0.0.5:4352 ')).toBe('10.0.0.5');
    expect(normaliseHost('Proj.Local')).toBe('proj.local');
  });
});

describe('discoveryResult scoping details', () => {
  const ORG = '11111111-1111-4111-8111-111111111111';
  const GW = '99999999-9999-4999-8999-999999999991';
  const SITE = '22222222-2222-4222-8222-222222222221';
  const SITE2 = '22222222-2222-4222-8222-222222222222';
  const CMD = '55555555-5555-4555-8555-555555555551';
  const mk = (gatewayOrg = ORG) =>
    ({
      remoteCommand: table([
        {
          id: CMD,
          orgId: ORG,
          gatewayId: GW,
          type: 'discover_devices',
          status: 'succeeded',
          error: null,
          output: { found: [{ host: '10.0.0.9', ports: [] }] },
        },
      ]),
      gateway: table([{ id: GW, orgId: gatewayOrg, siteId: SITE }]),
      device: table([
        { id: 'in', orgId: ORG, siteId: SITE, name: 'In', ip: '10.0.0.9', values: {} },
        { id: 'out', orgId: ORG, siteId: SITE2, name: 'Out', ip: '10.0.0.9', values: {} },
      ]),
    }) as unknown as DiscoveryDb;
  it('is not found when the gateway belongs to a different org than the command', async () => {
    const other = '11111111-1111-4111-8111-111111111112';
    expect(
      await discoveryResult(mk(other), { orgId: ORG, commandId: CMD, siteScope: null }),
    ).toBeNull();
  });
  it('is not found for an empty site scope, and only matches devices in the callers sites', async () => {
    const r = await discoveryResult(mk(), { orgId: ORG, commandId: CMD, siteScope: [SITE] });
    expect(r?.found[0]?.existing?.id).toBe('in');
    expect(
      await discoveryResult(mk(), { orgId: ORG, commandId: CMD, siteScope: [] }),
    ).toBeNull();
  });
});
