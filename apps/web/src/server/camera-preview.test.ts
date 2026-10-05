import { describe, expect, it } from 'vitest';
import {
  MAX_SNAPSHOTS_PER_GATEWAY_MINUTE,
  SNAPSHOT_FEATURE,
  SNAPSHOT_KEEP_MS,
  purgeSnapshots,
  requestSnapshot,
  snapshotResult,
  type PreviewDb,
} from './camera-preview';
import { table } from './test-db';

// A live picture from a camera: who may ask, which gateway is asked, and that the picture is handed
// over once and never kept.
const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const GW = '99999999-9999-4999-8999-999999999991';
const DEV = '33333333-3333-4333-8333-333333333333';
const ME = 'user-1';
const T0 = new Date('2026-10-05T10:00:00Z');
const JPEG64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64');

function world(over: { preview?: boolean } = {}) {
  const remoteCommand = table([]);
  const device = table([
    {
      id: DEV,
      orgId: ORG,
      siteId: SITE,
      roomId: null,
      gatewayId: GW,
      name: 'Lectern camera',
      kind: 'active',
      control: { kind: 'driver', driverId: 'onvif' },
    },
  ]);
  const gateway = table([
    {
      id: GW,
      orgId: ORG,
      siteId: SITE,
      features: [SNAPSHOT_FEATURE],
      enrolledAt: new Date('2026-01-01T00:00:00Z'),
      lastSeenAt: new Date(T0.getTime() - 1_000),
    },
  ]);
  const org = table([{ id: ORG, cameraPreview: over.preview ?? true }]);
  const auditLog = table([]);
  const db = {
    device,
    gateway,
    remoteCommand,
    org,
    auditLog,
    room: table([]),
    site: table([]),
  } as unknown as PreviewDb;
  return { db, device, gateway, remoteCommand, org, auditLog };
}
type World = ReturnType<typeof world>;

const ask = (w: World, siteScope: string[] | null = null, at = T0) =>
  requestSnapshot(w.db, { orgId: ORG, deviceId: DEV, siteScope, requestedBy: ME }, at);
const read = (w: World, id: string, who: string | null = ME, siteScope: string[] | null = null, at = T0) =>
  snapshotResult(w.db, { orgId: ORG, commandId: id, siteScope, requestedBy: who }, at);

/** What the gateway does: reports the result of the command it was sent. */
function gatewayAnswers(w: World, output: unknown, status = 'succeeded', at = T0) {
  Object.assign(w.remoteCommand.rows[0]!, { status, output, finishedAt: at });
  return w.remoteCommand.rows[0]!.id as string;
}

describe('asking for a picture', () => {
  it('stores a command for the camera’s gateway and audits who asked, naming the camera and not the picture', async () => {
    const w = world();
    const res = await ask(w);
    expect(res.ok).toBe(true);
    expect(w.remoteCommand.rows[0]).toMatchObject({
      gatewayId: GW,
      roomId: null,
      type: 'snapshot',
      args: { deviceId: DEV },
      status: 'pending',
      requestedBy: ME,
    });
    expect(w.auditLog.rows[0]).toMatchObject({
      action: 'camera.preview',
      target: DEV,
      actorId: ME,
      meta: { device: 'Lectern camera' },
    });
  });

  it('is refused until an owner has turned previews on', async () => {
    const w = world({ preview: false });
    expect(await ask(w)).toMatchObject({ ok: false, error: expect.stringContaining('switched off') });
    expect(w.remoteCommand.rows).toHaveLength(0);
  });

  it('is refused for a device whose driver cannot give a picture, a passive one, or one outside the caller’s sites', async () => {
    const plain = world();
    plain.device.rows[0]!.control = { kind: 'driver', driverId: 'visca-ip' };
    expect((await ask(plain)).ok).toBe(false);

    const passive = world();
    passive.device.rows[0]!.kind = 'passive';
    expect((await ask(passive)).ok).toBe(false);

    const scoped = world();
    expect((await ask(scoped, ['44444444-4444-4444-8444-444444444444'])).ok).toBe(false);
    expect((await ask(scoped, [SITE])).ok).toBe(true);
  });

  it('is refused for a gateway that is offline or too old to know the command', async () => {
    const offline = world();
    offline.gateway.rows[0]!.lastSeenAt = new Date(T0.getTime() - 60 * 60_000);
    expect(await ask(offline)).toMatchObject({ ok: false, error: expect.stringContaining('offline') });

    const old = world();
    old.gateway.rows[0]!.features = ['browse-points'];
    expect(await ask(old)).toMatchObject({ ok: false, error: expect.stringContaining('updating') });
    expect(old.remoteCommand.rows).toHaveLength(0);
  });

  it('does not stack requests for the same camera, and limits how often one gateway is asked', async () => {
    const w = world();
    expect((await ask(w)).ok).toBe(true);
    expect(await ask(w)).toMatchObject({ ok: false, error: expect.stringContaining('already on its way') });

    const busy = world();
    for (let i = 0; i < MAX_SNAPSHOTS_PER_GATEWAY_MINUTE; i++) {
      expect((await ask(busy)).ok).toBe(true);
      busy.remoteCommand.rows[i]!.status = 'delivered';
    }
    expect(await ask(busy)).toMatchObject({ ok: false, error: expect.stringContaining('Too many') });
    expect((await ask(busy, null, new Date(T0.getTime() + 61_000))).ok).toBe(true);
  });
});

describe('reading the picture', () => {
  async function pending() {
    const w = world();
    const res = await ask(w);
    if (!res.ok) throw new Error(res.error);
    return { w, id: res.id };
  }

  it('says it is waiting until the gateway answers', async () => {
    const { w, id } = await pending();
    expect(await read(w, id)).toEqual({ status: 'waiting' });
  });

  it('hands the picture over once and wipes it: a second read finds nothing', async () => {
    const { w, id } = await pending();
    gatewayAnswers(w, { contentType: 'image/jpeg', data: JPEG64 });
    const first = await read(w, id);
    expect(first).toMatchObject({ status: 'ready', contentType: 'image/jpeg', data: JPEG64 });
    // Nothing of it is left in the row.
    expect(w.remoteCommand.rows[0]).toMatchObject({ status: 'delivered', output: {} });
    expect(JSON.stringify(w.remoteCommand.rows[0])).not.toContain(JPEG64);
    expect(await read(w, id)).toEqual({ status: 'gone' });
  });

  it('only the person who asked can read it, and only within their sites', async () => {
    const { w, id } = await pending();
    gatewayAnswers(w, { contentType: 'image/jpeg', data: JPEG64 });
    expect(await read(w, id, 'someone-else')).toBeNull();
    expect(await read(w, id, null)).toBeNull();
    expect(await read(w, id, ME, ['44444444-4444-4444-8444-444444444444'])).toBeNull();
    // The refused reads did not use it up.
    expect(await read(w, id)).toMatchObject({ status: 'ready' });
  });

  it('passes on what the gateway said when it failed, and when it never answered', async () => {
    const failed = await pending();
    failed.w.remoteCommand.rows[0]!.error = 'The camera is offline';
    gatewayAnswers(failed.w, {}, 'failed');
    expect(await read(failed.w, failed.id)).toEqual({ status: 'failed', error: 'The camera is offline' });

    const expired = await pending();
    gatewayAnswers(expired.w, {}, 'expired');
    expired.w.remoteCommand.rows[0]!.error = 'The gateway did not pick this up in time.';
    expect(await read(expired.w, expired.id)).toMatchObject({ status: 'failed' });
  });

  it('refuses anything that is not a JPEG, and wipes it all the same', async () => {
    for (const output of [
      { contentType: 'text/html', data: JPEG64 },
      { contentType: 'image/jpeg', data: Buffer.from('<html>log in</html>').toString('base64') },
      { contentType: 'image/jpeg', data: '!!!not base64!!!' },
      { contentType: 'image/jpeg', data: '' },
      {},
    ]) {
      const { w, id } = await pending();
      gatewayAnswers(w, output);
      expect(await read(w, id)).toMatchObject({ status: 'failed' });
      expect(w.remoteCommand.rows[0]).toMatchObject({ status: 'delivered', output: {} });
    }
  });

  it('is not a way to read another kind of command’s output', async () => {
    const { w, id } = await pending();
    w.remoteCommand.rows[0]!.type = 'browse_points';
    gatewayAnswers(w, { contentType: 'image/jpeg', data: JPEG64 });
    expect(await read(w, id)).toBeNull();
  });
});

describe('wiping pictures nobody fetched', () => {
  it('clears a picture left unread past its time, and leaves a recent one', async () => {
    const old = world();
    await ask(old);
    gatewayAnswers(old, { contentType: 'image/jpeg', data: JPEG64 });
    await purgeSnapshots(old.db, new Date(T0.getTime() + SNAPSHOT_KEEP_MS + 1_000));
    expect(old.remoteCommand.rows[0]).toMatchObject({ status: 'discarded', output: {} });
    const id = old.remoteCommand.rows[0]!.id as string;
    expect(await read(old, id, ME, null, new Date(T0.getTime() + SNAPSHOT_KEEP_MS + 2_000))).toEqual({
      status: 'gone',
    });

    const fresh = world();
    await ask(fresh);
    gatewayAnswers(fresh, { contentType: 'image/jpeg', data: JPEG64 });
    await purgeSnapshots(fresh.db, new Date(T0.getTime() + 30_000));
    expect(fresh.remoteCommand.rows[0]).toMatchObject({ status: 'succeeded' });
  });

  it('asking for another picture wipes old unread ones first', async () => {
    const w = world();
    await ask(w);
    gatewayAnswers(w, { contentType: 'image/jpeg', data: JPEG64 });
    const later = new Date(T0.getTime() + SNAPSHOT_KEEP_MS + 1_000);
    w.gateway.rows[0]!.lastSeenAt = new Date(later.getTime() - 1_000);
    await ask(w, null, later);
    expect(w.remoteCommand.rows[0]).toMatchObject({ status: 'discarded', output: {} });
  });
});
