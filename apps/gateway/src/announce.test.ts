import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CloudClient } from './cloud';
import type { GatewayConfig } from './config';
import { Gateway } from './gateway';
import { silentLogger } from './log';
import { Store } from './store';
import { CREDENTIAL, ENROLL_TOKEN, FakeCloud } from './test-support/fake-cloud';

// A gateway that is running but cannot enrol says so, so staff can claim it in the portal.

let dir: string;
let cloud: FakeCloud;
const running: { gateway: Gateway; store: Store }[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kestrel-announce-'));
  cloud = await new FakeCloud().start();
});
afterEach(async () => {
  for (const r of running.splice(0)) {
    r.gateway.stop();
    try {
      r.store.close();
    } catch {
      // closed by the test
    }
  }
  await cloud.stop();
  rmSync(dir, { recursive: true, force: true });
});

function boot(over: Partial<GatewayConfig> = {}) {
  const cfg: GatewayConfig = {
    cloudUrl: cloud.url,
    dataDir: dir,
    panelPort: 0,
    panelHost: '127.0.0.1',
    logLevel: 'error',
    version: '0.0.0-test',
    ...over,
  };
  const store = new Store(join(dir, 'gateway.db'));
  const gateway = new Gateway(cfg, store, new CloudClient(cloud.url), silentLogger);
  running.push({ gateway, store });
  return { gateway, store };
}

describe('a gateway that cannot enrol', () => {
  it('announces itself with who it is, and keeps the same install id and secret', async () => {
    const first = boot();
    await first.gateway.tick();
    expect(cloud.announces).toHaveLength(1);
    const a = cloud.announces[0]!;
    expect(a).toMatchObject({ gatewayVersion: '0.0.0-test' });
    expect(a.installId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(a.secret.length).toBeGreaterThanOrEqual(20);
    expect(a.hostname).toBeTruthy();
    expect(first.store.get('credential')).toBeNull();

    // A restart is the same install, not a new one.
    first.gateway.stop();
    first.store.close();
    running.length = 0;
    const second = boot();
    await second.gateway.tick();
    expect(cloud.announces).toHaveLength(2);
    expect(cloud.announces[1]).toMatchObject({ installId: a.installId, secret: a.secret });
  });

  it('asks again only when the portal said to, not on every tick', async () => {
    const { gateway } = boot();
    await gateway.tick();
    await gateway.tick();
    await gateway.tick();
    expect(cloud.announces).toHaveLength(1);
  });

  it('announces when the token in its settings is refused', async () => {
    const { gateway, store } = boot({ enrollToken: 'used-up-token-0000000' });
    await gateway.tick();
    expect(cloud.enrols).toHaveLength(0);
    expect(cloud.announces).toHaveLength(1);
    expect(store.get('credential')).toBeNull();
  });

  it('enrols with the token staff hand back once it has been claimed', async () => {
    cloud.announceReply = { status: 'claimed', enrollToken: ENROLL_TOKEN, retrySeconds: 10 };
    const { gateway, store } = boot();
    await gateway.tick();
    expect(cloud.announces).toHaveLength(1);
    expect(cloud.enrols).toHaveLength(1);
    expect(store.get('credential')).toBe(CREDENTIAL);
    // From here it is an ordinary gateway: no more announcing.
    await gateway.tick();
    expect(cloud.announces).toHaveLength(1);
    expect(cloud.heartbeats.length).toBeGreaterThan(0);
  });

  it('keeps quiet and waits when it is dismissed, without counting it as a failure', async () => {
    cloud.announceReply = { status: 'dismissed', retrySeconds: 3600 };
    const { gateway, store } = boot();
    await gateway.tick();
    await gateway.tick();
    expect(cloud.announces).toHaveLength(1);
    expect(store.get('credential')).toBeNull();
  });

  it('a gateway with a working token never announces', async () => {
    const { gateway, store } = boot({ enrollToken: ENROLL_TOKEN });
    await gateway.tick();
    expect(store.get('credential')).toBe(CREDENTIAL);
    expect(cloud.announces).toHaveLength(0);
  });
});
