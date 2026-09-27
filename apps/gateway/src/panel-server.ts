import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { verifyPin } from '@kestrel/crypto';
import { PanelClientMessage, type PanelServerMessage } from '@kestrel/model';
import type { WebSocket } from 'ws';
import type { Logger } from './log';
import type { PhoneLinks } from './phone';
import type { ScheduleStore } from './schedule';
import type { RoomHost } from './room-host';

const MAX_PIN_FAILURES = 5;
const LOCKOUT_MS = 60_000;
const MAX_INTENTS_PER_SECOND = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PanelServerOptions {
  host: RoomHost;
  log: Logger;
  panelDir: string;
  /** Behind a reverse proxy, trust X-Forwarded-For so trusted-IP checks see the real client. */
  trustProxy?: boolean;
  /** When set, authorised panels are sent a QR link for controlling the room from a phone. */
  phone?: PhoneLinks;
  /** How often the QR link is replaced. */
  qrRefreshMs?: number;
  /** When set, panels are sent the room's bookings from its calendar. */
  schedule?: ScheduleStore;
}

const PLACEHOLDER_PAGE = `<!doctype html><meta charset="utf-8"><title>Kestrel panel</title>
<body style="font-family:system-ui;padding:2rem"><h1>Panel app not built</h1>
<p>Build it with <code>pnpm --filter @kestrel/panel-app build</code> and restart the gateway.</p>`;

/**
 * Serves the panel web app and one WebSocket per room. The socket carries the room's view model
 * out and validated intents in; access control (open, PIN, trusted IPs) is enforced per connection.
 */
export async function createPanelServer(opts: PanelServerOptions): Promise<FastifyInstance> {
  const { host, log } = opts;
  const app = Fastify({ logger: false, trustProxy: opts.trustProxy ?? false });
  await app.register(fastifyWebsocket, { options: { maxPayload: 4096 } });

  const failures = new Map<string, { count: number; until: number }>();
  const sockets = new Map<string, Set<WebSocket>>();

  // When a room's release is replaced or removed, drop its panels so they reconnect to the new one.
  host.onReload((roomId) => {
    for (const s of sockets.get(roomId) ?? []) s.close(1012, 'room reloaded');
  });
  // When walls move, a panel follows the room that is now running its space. Each open panel
  // registers a function here that checks and re-binds.
  const followers = new Set<() => void>();
  host.onActiveChange(() => {
    for (const follow of followers) follow();
  });

  // While the cloud cannot be reached nothing new arrives, so old bookings are cleared on a timer.
  if (opts.schedule) {
    const store = opts.schedule;
    const sweep = setInterval(() => store.expire(), 60_000);
    sweep.unref?.();
    app.addHook('onClose', async () => clearInterval(sweep));
  }

  const dir = resolve(opts.panelDir);
  const built = existsSync(resolve(dir, 'index.html'));
  // serve:false decorates reply.sendFile without exposing the whole directory over HTTP;
  // only the routes below hand files out.
  if (built) await app.register(fastifyStatic, { root: dir, serve: false });

  app.get('/health', async () => ({
    ok: true,
    rooms: host.ids().length,
  }));

  app.get<{ Params: { roomId: string } }>('/room/:roomId', async (req, reply) => {
    if (!UUID.test(req.params.roomId) || !host.get(req.params.roomId))
      return reply.code(404).type('text/plain').send('This room is not running on this gateway.');
    if (!built) return reply.type('text/html').send(PLACEHOLDER_PAGE);
    return reply.sendFile('index.html', dir);
  });

  if (built)
    app.get<{ Params: { '*': string } }>('/assets/*', async (req, reply) =>
      reply.sendFile(`assets/${req.params['*']}`, dir),
    );

  app.get<{ Params: { roomId: string } }>('/ws/:roomId', { websocket: true }, (socket, req) => {
    const roomId = req.params.roomId;
    const room = UUID.test(roomId) ? host.get(roomId) : undefined;
    const send = (m: PanelServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };
    if (!room) {
      send({ t: 'error', message: 'This room is not running on this gateway.' });
      socket.close(1008, 'unknown room');
      return;
    }

    const ip = req.ip;
    const { access } = room;
    const trusted = access.trustedIps.includes(ip);
    const pinRequired = access.mode === 'pin' && !!access.pinHash && !trusted;
    let authed = !pinRequired;
    let unsubscribe: (() => void) | null = null;
    let qrTimer: ReturnType<typeof setInterval> | null = null;
    let offSchedule: (() => void) | null = null;
    let windowStart = Date.now();
    let intents = 0;

    let set = sockets.get(roomId);
    if (!set) sockets.set(roomId, (set = new Set()));
    set.add(socket);

    // The room actually running this panel's space: itself, or a combined room while walls are open.
    let shown = host.active(roomId) ?? room;
    let follow: (() => void) | null = null;

    const startStreaming = () => {
      const push = () => send({ t: 'snapshot', vm: shown.runtime.getSnapshot() });
      const bind = () => {
        unsubscribe?.();
        unsubscribe = shown.runtime.subscribe(push);
        push();
      };
      bind();
      follow = () => {
        const now = host.active(roomId);
        if (!now || now === shown) return;
        shown = now;
        bind();
      };
      followers.add(follow);
      const sendQr = () => {
        const link = opts.phone?.link(roomId);
        if (link) send({ t: 'qr', ...link });
      };
      sendQr();
      // Bookings belong to the room the panel is in, not to whichever combined room is running.
      if (opts.schedule) {
        const store = opts.schedule;
        const sendSchedule = () => send({ t: 'schedule', meetings: store.get(roomId) });
        sendSchedule();
        offSchedule = store.onChange((id) => {
          if (id === roomId) sendSchedule();
        });
      }
      if (opts.phone) {
        qrTimer = setInterval(sendQr, opts.qrRefreshMs ?? 5 * 60_000);
        qrTimer.unref?.();
      }
    };

    send({ t: 'hello', roomId, pinRequired, branding: room.branding });
    if (authed) startStreaming();

    socket.on('message', (raw: Buffer) => {
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const msg = PanelClientMessage.safeParse(json);
      if (!msg.success) return;

      if (msg.data.t === 'auth') {
        if (authed) return;
        const lock = failures.get(ip);
        if (lock && lock.count >= MAX_PIN_FAILURES && Date.now() < lock.until) {
          send({ t: 'error', message: 'Too many attempts. Try again in a minute.' });
          return;
        }
        if (access.pinHash && verifyPin(msg.data.pin, access.pinHash)) {
          failures.delete(ip);
          authed = true;
          startStreaming();
        } else {
          const count = (lock && Date.now() < lock.until ? lock.count : 0) + 1;
          failures.set(ip, { count, until: Date.now() + LOCKOUT_MS });
          log('warn', 'Wrong panel PIN', { roomId, ip, attempts: count });
          send({ t: 'error', message: 'Wrong PIN.' });
        }
        return;
      }

      if (!authed) return;
      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        intents = 0;
      }
      if (++intents > MAX_INTENTS_PER_SECOND) return; // a runaway panel; ignore the flood
      shown.runtime.dispatch(msg.data.intent);
    });

    socket.on('close', () => {
      unsubscribe?.();
      if (follow) followers.delete(follow);
      if (qrTimer) clearInterval(qrTimer);
      offSchedule?.();
      sockets.get(roomId)?.delete(socket);
    });
    socket.on('error', () => socket.close());
  });

  return app;
}
