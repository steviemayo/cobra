// Manual end-to-end check of the released gateway image against a local cloud.
// Needs Docker, a built web app (`pnpm --filter @kestrel/web build`), a built panel, and the DEV database in .env.
// Build the image first: docker build -f apps/gateway/Dockerfile -t kestrel-gateway:local .
// Run from apps/web: ../gateway/node_modules/.bin/tsx --env-file=../../.env scripts/e2e-docker.mts
// Covers: enrol + first release, publish + rollback, PIN-protected panel. Creates and deletes a temp org.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { db } from '@kestrel/db';
import { generateKeyPair, hashPin, signManifest } from '@kestrel/crypto';
import { STARTER_TEMPLATES, type RoomModel } from '@kestrel/model';
import { roomDeployStates } from '../src/server/deployment-queries';
import { createDeployment } from '../src/server/deployment-service';
import { newEnrollToken } from '../src/server/gateway-service';

const PORT = 3201;
const PANEL_PORT = 8093;
const IMAGE = process.env.KESTREL_IMAGE ?? 'kestrel-gateway:local';
const CONTAINER = 'kestrel-e2e-gateway';
const keys = generateKeyPair();
const KEY_ID = 'e2e-docker';
const children: ChildProcess[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (m: string) => console.log(`[e2e] ${m}`);
const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });

function plain(mutate?: (m: RoomModel) => void): RoomModel {
  const m = structuredClone(STARTER_TEMPLATES[0]!.model);
  for (const d of m.devices) delete d.control;
  mutate?.(m);
  return m;
}

async function until<T>(what: string, check: () => Promise<T | null | false>, ms = 120_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await wait(1500);
  }
}

function panelHello(roomId: string): Promise<{ pinRequired: boolean; gotSnapshotBeforeAuth: boolean }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PANEL_PORT}/ws/${roomId}`);
    let pinRequired: boolean | undefined;
    let snapshot = false;
    const timer = setTimeout(() => reject(new Error('panel websocket timed out')), 10_000);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { t: string; pinRequired?: boolean };
      if (msg.t === 'hello') {
        pinRequired = msg.pinRequired;
        ws.send(JSON.stringify({ t: 'intent', intent: { type: 'activity.start', activityId: 'present' } }));
        setTimeout(() => {
          clearTimeout(timer);
          ws.close();
          resolve({ pinRequired: !!pinRequired, gotSnapshotBeforeAuth: snapshot });
        }, 500);
      }
      if (msg.t === 'snapshot') snapshot = true;
    };
    ws.onerror = () => reject(new Error('panel websocket error'));
  });
}

let orgId = '';
try {
  docker('rm', '-f', CONTAINER);
  const org = await db.org.create({ data: { name: 'E2E docker gateway (temporary)' } });
  orgId = org.id;
  const site = await db.site.create({ data: { orgId, name: 'Test site' } });
  const token = newEnrollToken();
  const gateway = await db.gateway.create({
    data: { orgId, siteId: site.id, name: 'E2E docker gateway', enrollTokenHash: token.hash, enrollTokenExpiresAt: token.expiresAt },
  });
  const room = await db.room.create({ data: { orgId, siteId: site.id, gatewayId: gateway.id, name: 'E2E room', type: 'meeting' } });
  await db.roomDraft.create({ data: { orgId, roomId: room.id, model: plain() as never } });

  const publish = async (model: RoomModel, access: { mode: 'open' | 'pin'; pinHash?: string } = { mode: 'open' }) => {
    const last = await db.release.aggregate({ where: { roomId: room.id }, _max: { number: true } });
    const number = (last._max.number ?? 0) + 1;
    const id = randomUUID();
    const signed = signManifest(
      {
        manifestVersion: 1,
        orgId,
        roomId: room.id,
        roomName: room.name,
        releaseId: id,
        releaseNumber: number,
        createdAt: new Date().toISOString(),
        model,
        panel: { access: { ...access, trustedIps: [] }, branding: { mode: 'dark', language: 'en' } },
      } as never,
      { privateKeyPem: keys.privateKeyPem, keyId: KEY_ID },
    );
    return db.release.create({ data: { id, orgId, roomId: room.id, number, manifest: signed as never, hash: signed.hash, draftRevision: 1 } });
  };
  const deploy = (releaseId: string, kind: 'deploy' | 'rollback') =>
    createDeployment(db, { orgId, roomId: room.id, gatewayId: gateway.id, releaseId, kind, createdBy: null, scheduledFor: null });
  const settled = (id: string) =>
    until(`deployment ${id} to settle`, async () => {
      const d = await db.deployment.findUnique({ where: { id }, include: { events: { orderBy: { at: 'asc' } } } });
      return d && ['active', 'failed', 'rolled_back'].includes(d.status) ? d : null;
    });
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
    if (!ok) process.exitCode = 1;
  };
  const state = async () => (await roomDeployStates(orgId, [room.id]))[0]!;

  const r1 = await publish(plain());
  const d1 = await deploy(r1.id, 'deploy');

  say('starting cloud on :' + PORT);
  const web = spawn(`pnpm --filter @kestrel/web exec next start -p ${PORT}`, {
    shell: true,
    stdio: 'ignore',
    env: { ...process.env, KESTREL_SIGNING_KEY: Buffer.from(keys.privateKeyPem).toString('base64'), KESTREL_SIGNING_KEY_ID: KEY_ID },
  });
  children.push(web);
  await until('cloud to answer', async () => (await fetch(`http://localhost:${PORT}/api/gateway/v1/config`).then((r) => r.status).catch(() => 0)) !== 0, 90_000);

  say(`starting gateway container from ${IMAGE}`);
  const run = docker(
    'run', '-d', '--name', CONTAINER,
    '--add-host', 'host.docker.internal:host-gateway',
    '-p', `${PANEL_PORT}:8080`,
    '-e', `KESTREL_CLOUD_URL=http://host.docker.internal:${PORT}`,
    '-e', `KESTREL_ENROLL_TOKEN=${token.token}`,
    '-e', 'KESTREL_SIMULATE=missing',
    IMAGE,
  );
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`);

  // Scenario 1: enrol, first release, panel served.
  const a = await settled(d1.id);
  check(a.status === 'active', `enrolled in Docker and release 1 deployed: status ${a.status}`);
  let s = await state();
  check(s.state === 'in_sync' && s.reportedRelease?.number === 1, `room is ${s.state}, running release ${s.reportedRelease?.number}`);
  const page = await fetch(`http://127.0.0.1:${PANEL_PORT}/room/${room.id}`).catch(() => null);
  check(!!page && page.ok, `panel page served from the container: HTTP ${page?.status}`);
  const gw = await db.gateway.findUniqueOrThrow({ where: { id: gateway.id } });
  check(gw.enrollTokenHash === null && !!gw.credentialHash, 'enrol token cleared, credential stored as hash');
  const open = await panelHello(room.id);
  check(!open.pinRequired, 'open panel does not ask for a PIN');

  // Scenario 2: publish a second release, then roll back to the first.
  const r2 = await publish(plain((m) => void (m.settings.defaultVolume = 65)));
  const d2 = await settled((await deploy(r2.id, 'deploy')).id);
  check(d2.status === 'active', `release 2 deployed: status ${d2.status}`);
  s = await state();
  check(s.reportedRelease?.number === 2, `room runs release ${s.reportedRelease?.number}`);
  const back = await settled((await deploy(r1.id, 'rollback')).id);
  check(back.status === 'active', `rollback to release 1: status ${back.status}`);
  s = await state();
  check(s.state === 'in_sync' && s.reportedRelease?.number === 1, `after rollback room is ${s.state}, running release ${s.reportedRelease?.number}`);

  // Scenario 3: a PIN-protected release shows the keypad and sends nothing before the PIN.
  const r3 = await publish(plain(), { mode: 'pin', pinHash: hashPin('4821') });
  const d3 = await settled((await deploy(r3.id, 'deploy')).id);
  check(d3.status === 'active', `release 3 (PIN) deployed: status ${d3.status}`);
  const locked = await panelHello(room.id);
  check(locked.pinRequired, 'panel asks for a PIN');
  check(!locked.gotSnapshotBeforeAuth, 'no room state sent before the PIN');
} catch (e) {
  console.error('[e2e] ERROR', e);
  process.exitCode = 1;
} finally {
  const logs = docker('logs', '--tail', '15', CONTAINER);
  if (process.exitCode) console.log(`[gateway logs]\n${logs.stdout}${logs.stderr}`);
  docker('rm', '-f', CONTAINER);
  for (const c of children) spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { shell: true, stdio: 'ignore' });
  await wait(1500);
  if (orgId) await db.org.delete({ where: { id: orgId } }).then(() => say('temporary org deleted'));
  await db.$disconnect();
  process.exit(process.exitCode ?? 0);
}
