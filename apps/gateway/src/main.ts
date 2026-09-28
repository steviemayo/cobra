import { join } from 'node:path';
import { CloudClient } from './cloud';
import { loadConfig } from './config';
import { Gateway } from './gateway';
import { loadAdminCode } from './local-admin';
import { createLogger } from './log';
import { createPanelServer } from './panel-server';
import { RoomHost } from './room-host';
import { Store } from './store';

async function main() {
  const cfg = loadConfig();
  const log = createLogger(cfg.logLevel, join(cfg.dataDir, 'logs', 'gateway.log'));
  const store = new Store(join(cfg.dataDir, 'gateway.db'));

  // A gateway must keep running rooms even if something unexpected throws.
  process.on('unhandledRejection', (e) =>
    log('error', 'Unhandled rejection', { error: String(e) }),
  );
  process.on('uncaughtException', (e) => log('error', 'Uncaught exception', { error: String(e) }));

  const host = new RoomHost(cfg.simulate, log, (event) => store.enqueue(event));
  const gateway = new Gateway(cfg, store, new CloudClient(cfg.cloudUrl), host, log);

  const admin = loadAdminCode(cfg.dataDir, log);
  const panel = await createPanelServer({
    host,
    log,
    panelDir: cfg.panelDir,
    phone: gateway.phone,
    schedule: gateway.bookings,
    admin: { gateway, adminCode: admin.code },
  });
  await panel.listen({ port: cfg.panelPort, host: cfg.panelHost });
  log('info', 'Panel server listening', { port: cfg.panelPort });

  gateway.start();

  const shutdown = async (signal: string) => {
    log('info', 'Shutting down', { signal });
    gateway.stop();
    await panel.close();
    host.shutdown();
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
