import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CloudClient } from './cloud';
import { loadConfig } from './config';
import { Gateway } from './gateway';
import { LocalAccess } from './local-access';
import { loadAdminCode } from './local-admin';
import { createLocalServer } from './local-server';
import { createLogger } from './log';
import { openStore } from './store';

async function main() {
  const cfg = loadConfig();
  const log = createLogger(cfg.logLevel, join(cfg.dataDir, 'logs', 'gateway.log'));
  const store = openStore(join(cfg.dataDir, 'gateway.db'), log);

  // A gateway must keep watching its devices even if something unexpected throws.
  process.on('unhandledRejection', (e) =>
    log('error', 'Unhandled rejection', { error: String(e) }),
  );
  process.on('uncaughtException', (e) => log('error', 'Uncaught exception', { error: String(e) }));

  const gateway = new Gateway(cfg, store, new CloudClient(cfg.cloudUrl), log);

  // The local page is a convenience. If it cannot start (the port is taken, the admin code cannot be
  // written) the gateway still watches its devices rather than exiting and being restarted for ever.
  let server: Awaited<ReturnType<typeof createLocalServer>> | null = null;
  try {
    const admin = loadAdminCode(cfg.dataDir, log);
    let tls: { cert: Buffer; key: Buffer } | undefined;
    if (cfg.tlsCertFile || cfg.tlsKeyFile) {
      try {
        if (!cfg.tlsCertFile || !cfg.tlsKeyFile) throw new Error('both a certificate and a key are needed');
        tls = { cert: readFileSync(cfg.tlsCertFile), key: readFileSync(cfg.tlsKeyFile) };
      } catch (e) {
        // A bad certificate must not take the gateway down, but it must not quietly fall back to HTTP unnoticed either.
        log('error', 'The TLS certificate could not be loaded; the local page is served over plain HTTP', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    const access = new LocalAccess(() => gateway.localAccessContext(), log);
    server = await createLocalServer({
      log,
      admin: {
        gateway,
        log,
        adminCode: admin.code,
        access,
        diagnostics: {
          snapshot: () => gateway.snapshot(),
          dataDir: cfg.dataDir,
          cloudUrl: cfg.cloudUrl,
          logFile: join(cfg.dataDir, 'logs', 'gateway.log'),
        },
      },
      allowedHosts: cfg.allowedHosts,
      tls,
    });
    let bound = false;
    for (let i = 0; i < 10 && !bound; i++) {
      const port = cfg.panelPort + i;
      try {
        await server.listen({ port, host: cfg.panelHost });
        log('info', 'Local status page listening', { port, https: !!tls });
        gateway.setListener(port, !!tls);
        if (i > 0)
          log('warn', 'The usual port was busy, so the status page moved', {
            wanted: cfg.panelPort,
            using: port,
          });
        bound = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
      }
    }
    if (!bound) throw new Error(`ports ${cfg.panelPort} to ${cfg.panelPort + 9} are all in use`);
  } catch (e) {
    log('error', 'The local status page could not start; the gateway carries on without it', {
      error: e instanceof Error ? e.message : String(e),
    });
    await server?.close().catch(() => undefined);
    server = null;
  }

  gateway.start();

  const shutdown = async (signal: string) => {
    log('info', 'Shutting down', { signal });
    // A service that takes too long to stop is killed by its wrapper, which can leave the state file
    // half written; leaving promptly and on our own terms is safer.
    setTimeout(() => process.exit(0), 5000).unref();
    gateway.stop();
    await server?.close().catch(() => undefined);
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
