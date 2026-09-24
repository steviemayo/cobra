// Manual end-to-end check of staged deployments. Runs against the DEV database (needs .env); creates and deletes a temp org.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '@kestrel/db';
import { generateKeyPair, hashSecret, signManifest } from '@kestrel/crypto';
import { STARTER_TEMPLATES, type RoomModel } from '@kestrel/model';
import { roomDeployStates } from '../src/server/deployment-queries';
import { createDeployment } from '../src/server/deployment-service';
import { newEnrollToken } from '../src/server/gateway-service';

const PORT = 3200;
const keys = generateKeyPair();
const KEY_ID = 'e2e';
const children: ChildProcess[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'kestrel-e2e-'));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (m: string) => console.log(`[e2e] ${m}`);

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

function start(name: string, cmd: string, env: Record<string, string>) {
  const p = spawn(cmd, { shell: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout?.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  p.stderr?.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(`[${name}] ${d}`));
  children.push(p);
}

let orgId = '';
try {
  const org = await db.org.create({ data: { name: 'E2E deployments (temporary)' } });
  orgId = org.id;
  const site = await db.site.create({ data: { orgId, name: 'Test site' } });
  const token = newEnrollToken();
  const gateway = await db.gateway.create({
    data: { orgId, siteId: site.id, name: 'E2E gateway', enrollTokenHash: token.hash, enrollTokenExpiresAt: token.expiresAt },
  });
  const room = await db.room.create({ data: { orgId, siteId: site.id, gatewayId: gateway.id, name: 'E2E room', type: 'meeting' } });
  await db.roomDraft.create({ data: { orgId, roomId: room.id, model: plain() as never } });

  const publish = async (model: RoomModel) => {
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
        panel: { access: { mode: 'open', trustedIps: [] }, branding: { mode: 'dark', language: 'en' } },
      },
      { privateKeyPem: keys.privateKeyPem, keyId: KEY_ID },
    );
    return db.release.create({ data: { id, orgId, roomId: room.id, number, manifest: signed as never, hash: signed.hash, draftRevision: 1 } });
  };
  const settled = (id: string) =>
    until(`deployment ${id} to settle`, async () => {
      const d = await db.deployment.findUnique({ where: { id }, include: { events: { orderBy: { at: 'asc' } } } });
      return d && ['active', 'failed', 'rolled_back'].includes(d.status) ? d : null;
    });
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
    if (!ok) process.exitCode = 1;
  };

  // 1. First release, deployed before the gateway has even enrolled.
  const r1 = await publish(plain());
  const d1 = await createDeployment(db, { orgId, roomId: room.id, gatewayId: gateway.id, releaseId: r1.id, kind: 'deploy', createdBy: null, scheduledFor: null });

  say('starting cloud on :' + PORT);
  start('web', `pnpm --filter @kestrel/web exec next start -p ${PORT}`, {
    KESTREL_SIGNING_KEY: Buffer.from(keys.privateKeyPem).toString('base64'),
    KESTREL_SIGNING_KEY_ID: KEY_ID,
  });
  await until('cloud to answer', async () => (await fetch(`http://localhost:${PORT}/api/gateway/v1/config`).then((r) => r.status).catch(() => 0)) !== 0, 90_000);

  say('starting gateway');
  start('gateway', 'pnpm --filter @kestrel/gateway start', {
    KESTREL_CLOUD_URL: `http://localhost:${PORT}`,
    KESTREL_ENROLL_TOKEN: token.token,
    KESTREL_DATA_DIR: dataDir,
    KESTREL_PANEL_PORT: '8091',
    KESTREL_SIMULATE: 'missing',
    KESTREL_HEALTH_TIMEOUT_SECONDS: '3',
    KESTREL_PANEL_DIR: join(process.cwd(), '..', 'panel', 'dist'),
  });

  const a = await settled(d1.id);
  check(a.status === 'active', `release 1 deployed: status ${a.status}`);
  check(
    a.events.map((e) => e.stage).join(',') === 'downloading,verifying,staging,health_check,active',
    `timeline: ${a.events.map((e) => e.stage).join(' > ')}`,
  );
  let s = (await roomDeployStates(orgId, [room.id]))[0]!;
  check(s.state === 'in_sync', `room is ${s.state}, running release ${s.reportedRelease?.number}`);

  // 2. A release whose device cannot be reached must be refused and the old one kept.
  const r2 = await publish(
    plain((m) => {
      const dsp = m.devices.find((d) => d.id === 'dsp')!;
      dsp.control = { kind: 'generic', protocol: 'tcp' };
      dsp.settings = { host: '127.0.0.1', port: 1, timeoutMs: 500, commands: {} };
    }),
  );
  const d2 = await createDeployment(db, { orgId, roomId: room.id, gatewayId: gateway.id, releaseId: r2.id, kind: 'deploy', createdBy: null, scheduledFor: null });
  const b = await settled(d2.id);
  check(b.status === 'rolled_back', `bad release refused: status ${b.status}`);
  check(!!b.error && /could not reach DSP/.test(b.error), `reason: ${b.error}`);
  const roomNow = await db.room.findUniqueOrThrow({ where: { id: room.id } });
  check(roomNow.reportedReleaseId === r1.id, `gateway still runs release 1 (reports ${roomNow.reportedReleaseId === r1.id ? 1 : '?'})`);
  s = (await roomDeployStates(orgId, [room.id]))[0]!;
  check(s.state === 'failed', `room state is ${s.state}`);

  // 3. A scheduled deployment waits, then starts on its own.
  const r3 = await publish(plain((m) => void (m.settings.defaultVolume = 60)));
  const at = new Date(Date.now() + 25_000);
  const d3 = await createDeployment(db, { orgId, roomId: room.id, gatewayId: gateway.id, releaseId: r3.id, kind: 'deploy', createdBy: null, scheduledFor: at });
  check(d3.status === 'scheduled', `release 3 scheduled for +25s: status ${d3.status}`);
  const c = await settled(d3.id);
  check(c.status === 'active', `scheduled release started by itself: status ${c.status}`);
  check((c.startedAt?.getTime() ?? 0) >= at.getTime() - 2000, 'it did not start before its time');
  s = (await roomDeployStates(orgId, [room.id]))[0]!;
  check(s.state === 'in_sync' && s.reportedRelease?.number === 3, `room is ${s.state}, running release ${s.reportedRelease?.number}`);
} catch (e) {
  console.error('[e2e] ERROR', e);
  process.exitCode = 1;
} finally {
  for (const c of children) {
    try {
      spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { shell: true, stdio: 'ignore' });
    } catch {
      // already gone
    }
  }
  await wait(1500);
  if (orgId) await db.org.delete({ where: { id: orgId } }).then(() => say('temporary org deleted'));
  rmSync(dataDir, { recursive: true, force: true });
  void hashSecret;
  await db.$disconnect();
  process.exit(process.exitCode ?? 0);
}
