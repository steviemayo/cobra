// Manual end-to-end check of monitoring against a real gateway container and the DEV database.
// Needs Docker, a built web app, the gateway image (see e2e-docker.mts) and a service role key in .env.
// Run from apps/web: ../gateway/node_modules/.bin/tsx --env-file=../../.env scripts/e2e-monitoring.mts
// E2E_KEEP_MINUTES=20 leaves everything running (and prints a login) so the portal can be looked at.
// Covers: healthy room, device unplugged -> incident + alert record, remote diagnostics, device
// back -> resolved, gateway offline -> critical incident, retention. Creates and deletes a temp org and user.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { createClient } from '@supabase/supabase-js';
import { db } from '@kestrel/db';
import { generateKeyPair, signManifest } from '@kestrel/crypto';
import { STARTER_TEMPLATES, type RoomModel } from '@kestrel/model';
import { requestCommand } from '../src/server/commands';
import { orgOverview } from '../src/server/monitoring-queries';
import { sweep } from '../src/server/monitoring';
import { pruneOldData } from '../src/server/retention';
import { createDeployment } from '../src/server/deployment-service';
import { newEnrollToken } from '../src/server/gateway-service';

const PORT = 3202;
const PANEL_PORT = 8094;
const DEVICE_PORT = 9911;
const IMAGE = process.env.KESTREL_IMAGE ?? 'kestrel-gateway:local';
const CONTAINER = 'kestrel-e2e-monitoring';
const keys = generateKeyPair();
const children: ChildProcess[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (m: string) => console.log(`[e2e] ${m}`);
const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) process.exitCode = 1;
};

async function until<T>(what: string, fn: () => Promise<T | null | false>, ms = 180_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await wait(2000);
  }
}

let device: Server | null = null;
const listen = () =>
  new Promise<void>((resolve) => {
    device = createServer((s) => s.on('error', () => undefined));
    device.listen(DEVICE_PORT, '0.0.0.0', () => resolve());
  });
const unplug = () => new Promise<void>((resolve) => (device ? device.close(() => resolve()) : resolve()));

function model(): RoomModel {
  const m = structuredClone(STARTER_TEMPLATES[0]!.model);
  for (const d of m.devices) delete d.control;
  const dsp = m.devices.find((d) => d.id === 'dsp')!;
  dsp.control = { kind: 'generic', protocol: 'tcp' };
  dsp.settings = { host: 'host.docker.internal', port: DEVICE_PORT, timeoutMs: 1500, probeIntervalMs: 5000, commands: {} };
  return m;
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const email = `kestrel-e2e-${randomBytes(4).toString('hex')}@example.test`;
const password = randomBytes(12).toString('base64url');
let userId = '';
let orgId = '';

try {
  docker('rm', '-f', CONTAINER);
  const created = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  userId = created.data.user.id;
  const org = await db.org.create({ data: { name: 'E2E monitoring (temporary)' } });
  orgId = org.id;
  await db.member.create({ data: { orgId, userId, email, role: 'owner' } });
  const site = await db.site.create({ data: { orgId, name: 'Test site' } });
  const token = newEnrollToken();
  const gateway = await db.gateway.create({
    data: { orgId, siteId: site.id, name: 'E2E gateway', enrollTokenHash: token.hash, enrollTokenExpiresAt: token.expiresAt },
  });
  const room = await db.room.create({ data: { orgId, siteId: site.id, gatewayId: gateway.id, name: 'Boardroom', type: 'meeting' } });
  await db.roomDraft.create({ data: { orgId, roomId: room.id, model: model() as never } });
  await db.alertChannel.create({ data: { orgId, name: 'AV support', type: 'email', config: { to: ['ops@example.com'] }, minSeverity: 'warning' } });
  await db.ticket.create({
    data: { orgId, roomId: room.id, title: 'Screen is black in the Boardroom', body: 'Started this morning.', createdBy: userId, createdByEmail: email },
  });

  const releaseId = randomUUID();
  const signed = signManifest(
    {
      manifestVersion: 1, orgId, roomId: room.id, roomName: room.name, releaseId, releaseNumber: 1,
      createdAt: new Date().toISOString(), model: model(),
      panel: { access: { mode: 'open', trustedIps: [] }, branding: { mode: 'dark', language: 'en' } },
    } as never,
    { privateKeyPem: keys.privateKeyPem, keyId: 'e2e-mon' },
  );
  await db.release.create({ data: { id: releaseId, orgId, roomId: room.id, number: 1, manifest: signed as never, hash: signed.hash, draftRevision: 1 } });
  await createDeployment(db, { orgId, roomId: room.id, gatewayId: gateway.id, releaseId, kind: 'deploy', createdBy: null, scheduledFor: null });

  await listen();
  say('starting cloud on :' + PORT);
  children.push(
    spawn(`pnpm --filter @kestrel/web exec next start -p ${PORT}`, {
      shell: true,
      stdio: 'ignore',
      env: { ...process.env, KESTREL_SIGNING_KEY: Buffer.from(keys.privateKeyPem).toString('base64'), KESTREL_SIGNING_KEY_ID: 'e2e-mon' },
    }),
  );
  await until('cloud', async () => (await fetch(`http://localhost:${PORT}/api/gateway/v1/config`).then((r) => r.status).catch(() => 0)) !== 0, 90_000);

  say('starting gateway container');
  const run = docker('run', '-d', '--name', CONTAINER, '--add-host', 'host.docker.internal:host-gateway', '-p', `${PANEL_PORT}:8080`,
    '-e', `KESTREL_CLOUD_URL=http://host.docker.internal:${PORT}`, '-e', `KESTREL_ENROLL_TOKEN=${token.token}`, '-e', 'KESTREL_SIMULATE=missing', IMAGE);
  if (run.status !== 0) throw new Error(run.stderr);

  const roomLive = async () => (await orgOverview(db, orgId)).rooms.find((r) => r.id === room.id)!;

  // 1. Healthy room.
  await until('DSP to report online', async () => (await db.deviceStatus.findFirst({ where: { roomId: room.id, deviceId: 'dsp', online: true } })) !== null);
  let live = await roomLive();
  check(live.health.level === 'healthy' && live.devices.total > 3, `room is ${live.health.level}, ${live.devices.online}/${live.devices.total} devices online`);
  check((await db.incident.count({ where: { orgId } })) === 0, 'no incidents while everything answers');

  // 2. Unplug the DSP.
  say('unplugging the DSP');
  await unplug();
  const incident = await until('device incident', () => db.incident.findFirst({ where: { orgId, kind: 'device_offline', status: 'open' } }), 240_000);
  check(incident.title === 'DSP is offline' && incident.severity === 'warning', `incident opened: "${incident.title}"`);
  live = await roomLive();
  check(live.health.level !== 'healthy' && live.openIncidents === 1, `room is ${live.health.level} (${live.health.reasons[0]})`);
  const delivery = await until('alert record', () => db.alertDelivery.findFirst({ where: { orgId, event: 'opened' } }), 30_000);
  check(delivery.status === 'skipped', `alert to the email channel recorded as "${delivery.status}" (${delivery.error})`);
  check((await db.gatewayEvent.count({ where: { orgId, type: 'device.offline' } })) > 0, 'gateway sent a device.offline event');

  // 3. Remote diagnostics while it is down.
  const asked = await requestCommand(db, { orgId, roomId: room.id, type: 'diagnostics', requestedBy: userId });
  check(asked.ok, 'diagnostics requested');
  if (asked.ok) {
    const cmd = await until('diagnostics result', async () => {
      const c = await db.remoteCommand.findUnique({ where: { id: asked.id } });
      return c && !['pending', 'sent'].includes(c.status) ? c : null;
    }, 120_000);
    const out = cmd.output as { devices?: { name: string; online: boolean }[] } | null;
    check(cmd.status === 'failed' && /DSP/.test(cmd.error ?? ''), `diagnostics ran on the gateway: ${cmd.status} (${cmd.error})`);
    check(!!out?.devices?.some((d) => d.name === 'DSP' && !d.online), 'diagnostics output lists the DSP as offline');
  }
  const rogue = await requestCommand(db, { orgId, roomId: room.id, type: 'run_shell', requestedBy: userId });
  check(!rogue.ok, 'a command outside the allowlist is refused');

  // 4. Plug it back in.
  say('plugging the DSP back in');
  await listen();
  await until('incident to resolve', async () => (await db.incident.findFirst({ where: { id: incident.id, status: 'resolved' } })) !== null, 180_000);
  check(true, 'incident resolved by itself');
  check((await db.alertDelivery.count({ where: { orgId, event: 'resolved' } })) === 1, 'resolution alert recorded');
  live = await roomLive();
  check(live.health.level === 'healthy', `room is ${live.health.level} again`);

  // 5. Gateway goes quiet.
  say('stopping the gateway (takes about two minutes to be noticed)');
  docker('stop', CONTAINER);
  await until('gateway offline', async () => {
    await sweep(db);
    return db.incident.findFirst({ where: { orgId, kind: 'gateway_offline', status: 'open' } });
  }, 240_000).then((i) => check(i.severity === 'critical', `gateway incident opened: "${i.title}"`));
  live = await roomLive();
  check(live.health.level === 'unknown', `room is ${live.health.level} while its gateway is offline`);

  // 6. Retention.
  await db.gatewayEvent.create({ data: { orgId, gatewayId: gateway.id, type: 'room.status', at: new Date(Date.now() - 100 * 86_400_000), data: {} } });
  const pruned = await pruneOldData(db);
  check(pruned.events >= 1, `retention removed ${pruned.events} old event(s)`);

  const keep = Number(process.env.E2E_KEEP_MINUTES ?? 0);
  if (keep > 0) {
    docker('start', CONTAINER);
    console.log(`\n[e2e] KEEPING RUNNING for ${keep} min\n  url:      http://localhost:${PORT}\n  email:    ${email}\n  password: ${password}\n  org:      ${orgId}\n  room:     ${room.id}\n`);
    await wait(keep * 60_000);
  }
} catch (e) {
  console.error('[e2e] ERROR', e);
  process.exitCode = 1;
} finally {
  if (process.exitCode) console.log(`[gateway logs]\n${docker('logs', '--tail', '20', CONTAINER).stdout}`);
  docker('rm', '-f', CONTAINER);
  await unplug();
  for (const c of children) spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { shell: true, stdio: 'ignore' });
  await wait(1500);
  if (orgId) await db.org.delete({ where: { id: orgId } }).then(() => say('temporary org deleted'));
  if (userId) await supabase.auth.admin.deleteUser(userId).then(() => say('temporary user deleted'));
  await db.$disconnect();
  process.exit(process.exitCode ?? 0);
}
