import { describe, expect, it } from 'vitest';
import { GatewayCommand } from '@kestrel/model';
import {
  MAX_COMMANDS_PER_ROOM_MINUTE,
  MAX_SCANS_PER_GATEWAY_MINUTE,
  NIL_UUID,
  applyCommandResults,
  requestCommand,
  requestGatewayCommand,
  takePendingCommands,
  type CommandDb,
} from './commands';
import { RETENTION_DAYS, pruneOldData, type RetentionDb } from './retention';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '11111111-1111-4111-8111-111111111112';
const GW = '99999999-9999-4999-8999-999999999991';
const GW2 = '99999999-9999-4999-8999-999999999992';
const ROOM = '33333333-3333-4333-8333-333333333331';
const T0 = new Date('2026-09-24T10:00:00Z');

function world() {
  const room = table([
    { id: ROOM, orgId: ORG, gatewayId: GW, name: 'Boardroom' },
    { id: 'no-gw', orgId: ORG, gatewayId: null, name: 'Unassigned' },
  ]);
  const remoteCommand = table([]);
  const deviceStatus = table([
    { id: 'd1', roomId: ROOM, deviceId: 'dsp', name: 'DSP', online: true },
  ]);
  const auditLog = table([]);
  const gateway = table([{ id: GW, orgId: ORG, features: ['bindings', 'discovery'] }]);
  return {
    db: { room, remoteCommand, deviceStatus, auditLog, gateway } as unknown as CommandDb,
    remoteCommand,
    auditLog,
    gateway,
  };
}
const ask = (w: ReturnType<typeof world>, over = {}) =>
  requestCommand(
    w.db,
    { orgId: ORG, roomId: ROOM, type: 'diagnostics', requestedBy: 'user-1', ...over },
    T0,
  );

describe('requesting commands', () => {
  it('queues an allowlisted command for the room’s gateway and writes an audit entry', async () => {
    const w = world();
    const res = await ask(w);
    expect(res.ok).toBe(true);
    expect(w.remoteCommand.rows[0]).toMatchObject({
      orgId: ORG,
      gatewayId: GW,
      roomId: ROOM,
      type: 'diagnostics',
      status: 'pending',
    });
    expect(w.auditLog.rows[0]).toMatchObject({
      action: 'command.request',
      orgId: ORG,
      actorId: 'user-1',
    });
  });

  it('refuses anything that is not on the allowlist', async () => {
    const w = world();
    for (const type of ['shell', 'rm -rf /', 'update_gateway', ''])
      expect(await ask(w, { type })).toEqual({ ok: false, error: 'That command is not allowed' });
    expect(w.remoteCommand.rows).toHaveLength(0);
  });

  it('refuses rooms from another org and rooms with no gateway', async () => {
    const w = world();
    expect((await ask(w, { orgId: OTHER_ORG })).ok).toBe(false);
    expect((await ask(w, { roomId: 'no-gw' })).ok).toBe(false);
    expect(w.remoteCommand.rows).toHaveLength(0);
  });

  it('needs a real device of the room for device tests, and passes nothing else through', async () => {
    const w = world();
    expect((await ask(w, { type: 'test_device' })).ok).toBe(false);
    expect((await ask(w, { type: 'test_device', args: { deviceId: 'ghost' } })).ok).toBe(false);
    expect(
      (await ask(w, { type: 'test_device', args: { deviceId: 'dsp', extra: 'x; reboot' } })).ok,
    ).toBe(true);
    expect(w.remoteCommand.rows[0]!.args).toEqual({ deviceId: 'dsp' });
  });

  it('queues a scan of the network, optionally of one network, and refuses a bad address', async () => {
    const w = world();
    expect((await ask(w, { type: 'discover_devices' })).ok).toBe(true);
    expect(w.remoteCommand.rows[0]).toMatchObject({ type: 'discover_devices', args: {} });
    expect((await ask(w, { type: 'discover_devices', args: { subnet: '192.168.1' } })).ok).toBe(true);
    expect(w.remoteCommand.rows[1]!.args).toEqual({ subnet: '192.168.1' });
    for (const subnet of ['192.168.1.0/24', 'x', '1.2.3.4', '10.0', '../etc'])
      expect(await ask(w, { type: 'discover_devices', args: { subnet } })).toEqual({ ok: false, error: 'That is not a network address' });
    expect(w.remoteCommand.rows).toHaveLength(2);
  });

  it('only sends a scan to a gateway that says it can run one', async () => {
    const w = world();
    w.gateway.rows[0]!.features = ['bindings'];
    expect(await ask(w, { type: 'discover_devices' })).toEqual({ ok: false, error: 'This gateway needs updating before it can look for devices.' });
    w.gateway.rows[0]!.features = [];
    expect((await ask(w, { type: 'discover_devices' })).ok).toBe(false);
    expect(w.remoteCommand.rows).toHaveLength(0);
    // Other commands are not affected.
    expect((await ask(w, { type: 'diagnostics' })).ok).toBe(true);
  });

  it('limits how fast commands can be sent to one room', async () => {
    const w = world();
    for (let i = 0; i < MAX_COMMANDS_PER_ROOM_MINUTE; i++) expect((await ask(w)).ok).toBe(true);
    expect((await ask(w)).ok).toBe(false);
  });
});

describe('delivering commands', () => {
  it('hands each command to the gateway once', async () => {
    const w = world();
    await ask(w);
    const first = await takePendingCommands(w.db, GW, T0);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: 'diagnostics', roomId: ROOM });
    expect(await takePendingCommands(w.db, GW, T0)).toEqual([]);
    expect(w.remoteCommand.rows[0]!.status).toBe('sent');
  });

  it('never hands one gateway another gateway’s commands', async () => {
    const w = world();
    await ask(w);
    expect(await takePendingCommands(w.db, GW2, T0)).toEqual([]);
  });

  it('records results only from the gateway the command was sent to', async () => {
    const w = world();
    await ask(w);
    const [cmd] = await takePendingCommands(w.db, GW, T0);
    await applyCommandResults(w.db, GW2, [{ id: cmd!.id, ok: true, output: {} }], T0);
    expect(w.remoteCommand.rows[0]!.status).toBe('sent');
    await applyCommandResults(w.db, GW, [{ id: cmd!.id, ok: true, output: { devices: 2 } }], T0);
    expect(w.remoteCommand.rows[0]).toMatchObject({ status: 'succeeded', output: { devices: 2 } });
    expect(w.auditLog.rows.at(-1)).toMatchObject({ action: 'command.result', orgId: ORG });
    // A repeat report changes nothing.
    await applyCommandResults(
      w.db,
      GW,
      [{ id: cmd!.id, ok: false, output: {}, error: 'late' }],
      T0,
    );
    expect(w.remoteCommand.rows[0]!.status).toBe('succeeded');
  });

  it('records a failed command with its reason', async () => {
    const w = world();
    await ask(w);
    const [cmd] = await takePendingCommands(w.db, GW, T0);
    await applyCommandResults(
      w.db,
      GW,
      [{ id: cmd!.id, ok: false, output: {}, error: 'Device not found' }],
      T0,
    );
    expect(w.remoteCommand.rows[0]).toMatchObject({ status: 'failed', error: 'Device not found' });
  });
});

describe('retention', () => {
  it('deletes history past 90 days and leaves everything recent and anything still open', async () => {
    const day = 86_400_000;
    const old = new Date(T0.getTime() - (RETENTION_DAYS + 1) * day);
    const fresh = new Date(T0.getTime() - 10 * day);
    const gatewayEvent = table([
      { id: 'e1', at: old },
      { id: 'e2', at: fresh },
    ]);
    const incident = table([
      { id: 'i1', status: 'resolved', resolvedAt: old },
      { id: 'i2', status: 'resolved', resolvedAt: fresh },
      { id: 'i3', status: 'open', resolvedAt: null },
    ]);
    const alertDelivery = table([
      { id: 'a1', at: old },
      { id: 'a2', at: fresh },
    ]);
    const remoteCommand = table([
      { id: 'c1', finishedAt: old },
      { id: 'c2', finishedAt: fresh },
      { id: 'c3', finishedAt: null },
    ]);
    const calendarFire = table([
      { id: 'f1', firedAt: old },
      { id: 'f2', firedAt: fresh },
    ]);
    const controlIntent = table([
      { id: 'n1', createdAt: old },
      { id: 'n2', createdAt: fresh },
    ]);
    const db = {
      gatewayEvent,
      incident,
      alertDelivery,
      remoteCommand,
      deployment: table([]),
      calendarFire,
      controlIntent,
    } as unknown as RetentionDb;
    const res = await pruneOldData(db, T0);
    expect(res).toMatchObject({ events: 1, incidents: 1, deliveries: 1, commands: 1 });
    expect(gatewayEvent.rows.map((r) => r.id)).toEqual(['e2']);
    expect(incident.rows.map((r) => r.id)).toEqual(['i2', 'i3']);
    expect(remoteCommand.rows.map((r) => r.id)).toEqual(['c2', 'c3']);
    expect(calendarFire.rows.map((r) => r.id)).toEqual(['f2']);
    expect(controlIntent.rows.map((r) => r.id)).toEqual(['n2']);
  });
});

describe('checking a control point', () => {
  const point = (args: Record<string, string>) => ({ type: 'verify_point', args: { deviceId: 'dsp', ...args } });

  it('queues the point with the command, cleaned up', async () => {
    const w = world();
    const res = await ask(w, point({ type: 'level', address: '{ "component": "Room",  "control": "gain" }' }));
    expect(res.ok).toBe(true);
    expect(w.remoteCommand.rows[0]).toMatchObject({
      type: 'verify_point',
      args: { deviceId: 'dsp', type: 'level', address: '{"component":"Room","control":"gain"}' },
    });
  });

  it('refuses a point that is not valid, or too long, or for a device that is not in the room', async () => {
    const w = world();
    expect(await ask(w, point({ type: 'nonsense', address: '{}' }))).toEqual({ ok: false, error: 'That control point is not valid' });
    expect(await ask(w, point({ type: 'level', address: 'nope' }))).toEqual({ ok: false, error: 'That control point is not valid' });
    expect(await ask(w, point({ type: 'level', address: '["a"]' }))).toEqual({ ok: false, error: 'That control point is not valid' });
    const long = JSON.stringify({ component: 'x'.repeat(190), control: 'y'.repeat(20) });
    expect(await ask(w, point({ type: 'level', address: long }))).toMatchObject({ ok: false });
    expect(
      await ask(w, { type: 'verify_point', args: { deviceId: 'ghost', type: 'level', address: '{}' } }),
    ).toEqual({ ok: false, error: 'Choose one of this room’s devices' });
    expect(w.remoteCommand.rows).toHaveLength(0);
  });
});


describe('gateway-level commands (finding devices)', () => {
  const online = new Date(T0.getTime() - 10_000);
  function gw() {
    const w = world();
    w.gateway.rows[0]!.enrolledAt = new Date('2026-01-01T00:00:00Z');
    w.gateway.rows[0]!.lastSeenAt = online;
    w.gateway.rows[0]!.name = 'Gateway one';
    return w;
  }
  const scan = (w: ReturnType<typeof world>, over = {}, at = T0) =>
    requestGatewayCommand(
      w.db,
      { orgId: ORG, gatewayId: GW, type: 'discover_devices', requestedBy: 'user-1', ...over },
      at,
    );

  it('queues a scan with no room and writes an audit entry', async () => {
    const w = gw();
    const res = await scan(w, { args: { subnet: '192.168.1' } });
    expect(res.ok).toBe(true);
    expect(w.remoteCommand.rows[0]).toMatchObject({
      orgId: ORG,
      gatewayId: GW,
      roomId: null,
      type: 'discover_devices',
      args: { subnet: '192.168.1' },
      status: 'pending',
    });
    expect(w.auditLog.rows[0]).toMatchObject({
      action: 'command.request',
      target: GW,
      actorId: 'user-1',
    });
  });

  it('accepts no network at all', async () => {
    const w = gw();
    expect((await scan(w)).ok).toBe(true);
    expect(w.remoteCommand.rows[0]!.args).toEqual({});
  });

  it('refuses an unknown gateway, another org, an offline one and one that cannot scan', async () => {
    const w = gw();
    expect((await scan(w, { gatewayId: GW2 })).ok).toBe(false);
    expect(await scan(w, { orgId: OTHER_ORG })).toEqual({ ok: false, error: 'Gateway not found' });
    w.gateway.rows[0]!.features = ['bindings'];
    expect(await scan(w)).toEqual({
      ok: false,
      error: 'This gateway needs updating before it can look for devices.',
    });
    w.gateway.rows[0]!.features = ['discovery'];
    w.gateway.rows[0]!.lastSeenAt = new Date(T0.getTime() - 10 * 60_000);
    expect((await scan(w)).ok).toBe(false);
    w.gateway.rows[0]!.enrolledAt = null;
    expect((await scan(w)).ok).toBe(false);
    expect(w.remoteCommand.rows).toHaveLength(0);
  });

  it('refuses a bad or public network', async () => {
    const w = gw();
    for (const subnet of ['8.8.8', '192.168.1.0/24', '300.1.1', 'x', '172.40.1'])
      expect((await scan(w, { args: { subnet } })).ok).toBe(false);
    expect(w.remoteCommand.rows).toHaveLength(0);
  });

  it('refuses a second scan while one is running, then allows it once it is old or done', async () => {
    const w = gw();
    expect((await scan(w)).ok).toBe(true);
    expect(await scan(w, {}, new Date(T0.getTime() + 5_000))).toEqual({
      ok: false,
      error: 'A scan is already running',
    });
    // Finished: allowed again.
    w.remoteCommand.rows[0]!.status = 'succeeded';
    w.gateway.rows[0]!.lastSeenAt = new Date(T0.getTime() + 69_000);
    expect((await scan(w, {}, new Date(T0.getTime() + 70_000))).ok).toBe(true);
    // A scan stuck for over two minutes does not block forever.
    const w2 = gw();
    await scan(w2);
    w2.gateway.rows[0]!.lastSeenAt = new Date(T0.getTime() + 3 * 60_000);
    expect((await scan(w2, {}, new Date(T0.getTime() + 3 * 60_000))).ok).toBe(true);
  });

  it('limits how many scans one gateway can be asked for in a minute', async () => {
    const w = gw();
    for (let i = 0; i < MAX_SCANS_PER_GATEWAY_MINUTE; i++) {
      expect((await scan(w, {}, new Date(T0.getTime() + i * 1_000))).ok).toBe(true);
      w.remoteCommand.rows[i]!.status = 'succeeded';
    }
    const res = await scan(w, {}, new Date(T0.getTime() + 10_000));
    expect(res.ok).toBe(false);
    expect(w.remoteCommand.rows).toHaveLength(MAX_SCANS_PER_GATEWAY_MINUTE);
    w.gateway.rows[0]!.lastSeenAt = new Date(T0.getTime() + 89_000);
    expect((await scan(w, {}, new Date(T0.getTime() + 90_000))).ok).toBe(true);
  });

  it('hands the gateway the nil room id and the message still parses', async () => {
    const w = gw();
    await scan(w, { args: { subnet: '10.1.2' } });
    const out = await takePendingCommands(w.db, GW, T0);
    expect(out[0]).toMatchObject({ type: 'discover_devices', roomId: NIL_UUID });
    expect(NIL_UUID).toBe('00000000-0000-0000-0000-000000000000');
    expect(GatewayCommand.safeParse(out[0]).success).toBe(true);
  });

  it('records a result for a room-less command, audited against the gateway, and not from another gateway', async () => {
    const w = gw();
    await scan(w);
    const [cmd] = await takePendingCommands(w.db, GW, T0);
    await applyCommandResults(w.db, GW2, [{ id: cmd!.id, ok: true, output: {} }], T0);
    expect(w.remoteCommand.rows[0]!.status).toBe('sent');
    await applyCommandResults(w.db, GW, [{ id: cmd!.id, ok: true, output: { found: [] } }], T0);
    expect(w.remoteCommand.rows[0]).toMatchObject({ status: 'succeeded', roomId: null });
    expect(w.auditLog.rows.at(-1)).toMatchObject({ action: 'command.result', target: GW });
  });
});
