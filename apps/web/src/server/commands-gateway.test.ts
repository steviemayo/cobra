import { describe, expect, it } from 'vitest';
import {
  MAX_SCANS_PER_GATEWAY_MINUTE,
  SCAN_IN_FLIGHT_MS,
  requestGatewayCommand,
  type CommandDb,
} from './commands';
import { table } from './test-db';

// Boundary cases for gateway-level commands (finding devices): the in-flight window, the rate
// limit window and what is stored.
const ORG = '11111111-1111-4111-8111-111111111111';
const GW = '99999999-9999-4999-8999-999999999991';
const GW2 = '99999999-9999-4999-8999-999999999992';
const T0 = new Date('2026-09-24T10:00:00Z');

function world() {
  const remoteCommand = table([]);
  const gateway = table([
    {
      id: GW,
      orgId: ORG,
      name: 'Gateway one',
      features: ['discovery'],
      enrolledAt: new Date('2026-01-01T00:00:00Z'),
      lastSeenAt: T0,
    },
  ]);
  return {
    db: {
      room: table([]),
      deviceStatus: table([]),
      auditLog: table([]),
      remoteCommand,
      gateway,
    } as unknown as CommandDb,
    remoteCommand,
    gateway,
  };
}
type World = ReturnType<typeof world>;

/** Asks for a scan at `at`, with the gateway having checked in a second earlier. */
function scan(w: World, at: Date, args?: { subnet?: string }) {
  w.gateway.rows[0]!.lastSeenAt = new Date(at.getTime() - 1_000);
  return requestGatewayCommand(
    w.db,
    { orgId: ORG, gatewayId: GW, type: 'discover_devices', args, requestedBy: 'user-1' },
    at,
  );
}

describe('gateway-level commands: boundaries', () => {
  it('blocks on a pending or sent scan up to exactly two minutes old, then lets a new one through', async () => {
    for (const status of ['pending', 'sent']) {
      const w = world();
      await scan(w, T0);
      w.remoteCommand.rows[0]!.status = status;
      expect((await scan(w, new Date(T0.getTime() + SCAN_IN_FLIGHT_MS))).ok).toBe(false);
      expect((await scan(w, new Date(T0.getTime() + SCAN_IN_FLIGHT_MS + 1))).ok).toBe(true);
    }
  });

  it('does not let a scan on another gateway block this one', async () => {
    const w = world();
    await scan(w, T0);
    w.remoteCommand.rows[0]!.gatewayId = GW2;
    expect((await scan(w, new Date(T0.getTime() + 1_000))).ok).toBe(true);
  });

  it('does not let a different command type block a scan', async () => {
    const w = world();
    await scan(w, T0);
    w.remoteCommand.rows[0]!.type = 'diagnostics';
    expect((await scan(w, new Date(T0.getTime() + 1_000))).ok).toBe(true);
  });

  it('counts a scan asked for exactly a minute ago toward the rate limit, then stops counting it', async () => {
    const w = world();
    for (let i = 0; i < MAX_SCANS_PER_GATEWAY_MINUTE; i++) {
      await scan(w, new Date(T0.getTime() + i));
      w.remoteCommand.rows[i]!.status = 'succeeded';
    }
    expect((await scan(w, new Date(T0.getTime() + 60_000))).ok).toBe(false);
    expect(
      (await scan(w, new Date(T0.getTime() + 60_000 + MAX_SCANS_PER_GATEWAY_MINUTE))).ok,
    ).toBe(true);
  });

  it('does not count a scan on another gateway toward the rate limit', async () => {
    const w = world();
    for (let i = 0; i < MAX_SCANS_PER_GATEWAY_MINUTE; i++) {
      await scan(w, new Date(T0.getTime() + i));
      w.remoteCommand.rows[i]!.status = 'succeeded';
      w.remoteCommand.rows[i]!.gatewayId = GW2;
    }
    expect((await scan(w, new Date(T0.getTime() + 5_000))).ok).toBe(true);
  });

  it('stores a cleaned network, and treats a blank one as none', async () => {
    const w = world();
    await scan(w, T0, { subnet: '  010.000.001 ' });
    expect(w.remoteCommand.rows[0]!.args).toEqual({ subnet: '10.0.1' });
    const w2 = world();
    await scan(w2, T0, { subnet: '   ' });
    expect(w2.remoteCommand.rows[0]!.args).toEqual({});
  });

  it('a refused scan leaves no row behind', async () => {
    const w = world();
    expect((await scan(w, T0, { subnet: '8.8.8' })).ok).toBe(false);
    expect(w.remoteCommand.rows).toHaveLength(0);
  });

  it('refuses a type that is not a gateway command', async () => {
    const w = world();
    const res = await requestGatewayCommand(
      w.db,
      { orgId: ORG, gatewayId: GW, type: 'restart_room' as never, requestedBy: null },
      T0,
    );
    expect(res.ok).toBe(false);
    expect(w.remoteCommand.rows).toHaveLength(0);
  });
});
