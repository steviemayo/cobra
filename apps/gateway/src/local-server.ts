import Fastify, { type FastifyInstance } from 'fastify';
import { localAdmin, type LocalAdminOptions } from './local-admin';
import type { Logger } from './log';
import { makeHostCheck } from './request-guard';

export interface LocalServerOptions {
  log: Logger;
  /** The gateway's own status page (`/`) and admin page (`/admin`). */
  admin: LocalAdminOptions;
  /** Behind a reverse proxy, trust X-Forwarded-For so the address in the log is the real client. */
  trustProxy?: boolean;
  /** Extra names the gateway may be reached by (KESTREL_ALLOWED_HOSTS); see makeHostCheck. */
  allowedHosts?: string[];
  /** The machine's own name, for the host check. Tests set it. */
  machineName?: string;
}

/**
 * The gateway's small local web server: a status page anyone on the network can read, an admin page
 * behind a code, and `/health`. It serves nothing else and takes no commands for devices.
 */
export async function createLocalServer(opts: LocalServerOptions): Promise<FastifyInstance> {
  const { log } = opts;
  const app = Fastify({ logger: false, trustProxy: opts.trustProxy ?? false });

  // Only names the gateway is meant to be reached by (a rebinding page uses a public-looking one).
  const hostAllowed = makeHostCheck(opts.allowedHosts, opts.machineName);
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health' || hostAllowed(req.host)) return;
    log('warn', 'Refused a request for a name this gateway is not meant to be reached by', {
      host: req.host,
      hint: 'Add it to KESTREL_ALLOWED_HOSTS if it is a real name for this gateway',
    });
    return reply
      .code(421)
      .type('text/plain')
      .send('This gateway is not reached by that name. Use its address, or ask whoever runs it.');
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    return payload;
  });

  await app.register(localAdmin, opts.admin);
  app.get('/health', async () => ({ ok: true }));
  return app;
}
