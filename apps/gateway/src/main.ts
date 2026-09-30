import { join } from 'node:path';
import { CloudClient } from './cloud';
import { loadConfig } from './config';
import { Gateway } from './gateway';
import { loadAdminCode } from './local-admin';
import { createLocalServer } from './local-server';
import { createLogger } from './log';
import { Store } from './store';

async function main() {
  const cfg = loadConfig();
  const log = createLogger(cfg.logLevel, join(cfg.dataDir, 'logs', 'gateway.log'));
  const store = new Store(join(cfg.dataDir, 'gateway.db'));

  // A gateway must keep watching its devices even if something unexpected throws.
  process.on('unhandledRejection', (e) =>
    log('error', 'Unhandled rejection', { error: String(e) }),
  );
  process.on('uncaughtException', (e) => log('error', 'Uncaught exception', { error: String(e) }));

  const gateway = new Gateway(cfg, store, new CloudClient(cfg.cloudUrl), log);

  const admin = loadAdminCode(cfg.dataDir, log);
  const server = await createLocalServer({
    log,
    admin: { gateway, log, adminCode: admin.code },
    allowedHosts: cfg.allowedHosts,
  });
  await server.listen({ port: cfg.panelPort, host: cfg.panelHost });
  log('info', 'Local status page listening', { port: cfg.panelPort });

  gateway.start();

  const shutdown = async (signal: string) => {
    log('info', 'Shutting down', { signal });
    gateway.stop();
    await server.close();
    gateway.devices.shutdown();
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
