import { describe, expect, it } from 'vitest';
import {
  MAX_COMMANDS_PER_ROOM_MINUTE,
  applyCommandResults,
  requestCommand,
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
  return {
    db: { room, remoteCommand, deviceStatus, auditLog } as unknown as CommandDb,
    remoteCommand,
    auditLog,
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

