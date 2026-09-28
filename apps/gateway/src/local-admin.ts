import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Gateway, LocalStatus } from './gateway';
import type { Logger } from './log';
import type { RoomHost } from './room-host';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_SHAPE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const COOKIE = 'kestrel_admin';
const SESSION_MS = 30 * 60_000;
const MAX_SESSIONS = 20;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60_000;
const RECENT_MS = 3 * 60_000;

export interface LocalAdminOptions {
  host: RoomHost;
  gateway: Pick<Gateway, 'status' | 'enrolWithToken' | 'reset'>;
  log: Logger;
  /** Unlocks the admin page. Kept in a file only people with access to this machine can read. */
  adminCode: string;
  now?: () => number;
}

/**
 * The admin code lives in `admin-code.txt` in the data folder, so a person on the machine (or
 * with `docker exec`) can read it and nobody else can. Delete the file and restart for a new one.
 */
export function loadAdminCode(dataDir: string, log: Logger): { code: string; path: string } {
  const path = join(dataDir, 'admin-code.txt');
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (CODE_SHAPE.test(existing)) return { code: existing, path };
  } catch {
    // none yet
  }
  const pick = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  const code = `${pick()}-${pick()}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${code}\n`, { mode: 0o600 });
  log('info', 'Made the local admin code; it is in this file on the machine', { file: path });
  return { code, path };
}

const digest = (s: string) => createHash('sha256').update(s).digest();
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const MESSAGES: Record<string, { ok: boolean; text: string }> = {
  enrolled: {
    ok: true,
    text: 'Enrolled. This gateway now belongs to the new organisation and is loading its rooms.',
  },
  reset: {
    ok: true,
    text: 'Reset. This gateway has forgotten its organisation and is announcing itself to Kestrel staff.',
  },
  locked: { ok: false, text: 'Too many wrong codes. Wait a minute and try again.' },
  wrong: { ok: false, text: 'That code is not right.' },
  confirm: { ok: false, text: 'Type RESET to confirm.' },
};

const CSS = `
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--card:#fff;--ok:#15803d;--bad:#b91c1c;--accent:#1d4ed8}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--line:#292524;--card:#171412;--ok:#4ade80;--bad:#f87171;--accent:#93c5fd}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
p{margin:8px 0}.muted{color:var(--muted)}section,.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:12px 0}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:8px 0}dt{color:var(--muted)}dd{margin:0}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px 6px;border-top:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500;border-top:0}
code{font:13px ui-monospace,Consolas,monospace;word-break:break-all}a{color:var(--accent)}
.ok{color:var(--ok)}.bad{color:var(--bad)}label{display:block;margin:10px 0 4px}
input[type=text],input[type=password]{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
button{margin-top:10px;padding:8px 14px;border:1px solid var(--line);border-radius:6px;background:var(--fg);color:var(--bg);font:inherit;cursor:pointer}
button.danger{background:var(--bad);color:#fff;border-color:var(--bad)}button.plain{background:transparent;color:var(--fg)}
.banner{padding:10px 12px;border-radius:6px;border:1px solid var(--line);margin:12px 0}
`;

function layout(title: string, body: string, refresh = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="30">' : ''}<title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

function ago(iso: string | null, now: number): string {
  if (!iso) return 'not yet';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

function headline(s: LocalStatus, now: number): { text: string; ok: boolean } {
  switch (s.enrolment) {
    case 'enrolled': {
      const recent = s.lastContactAt && now - Date.parse(s.lastContactAt) < RECENT_MS;
      return recent
        ? { text: 'Connected to Kestrel.', ok: true }
        : {
            text: `Cannot reach Kestrel right now. Rooms keep running${s.problem ? ` (${s.problem})` : '.'}`,
            ok: false,
          };
    }
    case 'unclaimed':
    case 'dismissed':
      return {
        text: 'Not set up yet. Kestrel staff can claim this gateway in the staff portal once you have told them its install ID (below).',
        ok: false,
      };
    case 'claimed':
      return { text: 'Claimed by Kestrel staff. Joining the organisation now.', ok: true };
    case 'refused':
      return {
        text: 'The enrolment token was not accepted. Enter a new one on the Admin page.',
        ok: false,
      };
    default:
      return { text: s.problem ?? 'Connecting to Kestrel…', ok: false };
  }
}

function roomRows(host: RoomHost, hostHeader: string): string {
  const rooms = host
    .ids()
    .flatMap((id) => {
      const room = host.get(id);
      return room
        ? [{ id, name: room.signed.manifest.roomName, offline: room.offline().length }]
        : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  if (rooms.length === 0) return '<p class="muted">No rooms are running on this gateway yet.</p>';
  const rows = rooms
    .map((r) => {
      const url = `http://${hostHeader}/room/${r.id}`;
      const state = r.offline
        ? `<span class="bad">${r.offline} device${r.offline === 1 ? '' : 's'} not answering</span>`
        : '<span class="ok">Running</span>';
      return `<tr><td>${esc(r.name)}</td><td>${state}</td><td><a href="/room/${esc(r.id)}">Open panel</a><br><code>${esc(url)}</code></td></tr>`;
    })
    .join('');
  return `<table><thead><tr><th>Room</th><th>State</th><th>Panel link</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * The gateway's own pages: a status page anyone on the network can read (rooms and their panel
 * links, nothing secret) and an admin page behind a code for entering a new enrolment token or
 * resetting. Plain server-rendered HTML with no scripts, so it works offline and needs no build.
 */
export async function localAdmin(app: FastifyInstance, opts: LocalAdminOptions): Promise<void> {
  const now = opts.now ?? (() => Date.now());
  const sessions = new Map<string, number>();
  const failures = new Map<string, { count: number; until: number }>();
  const code = digest(opts.adminCode.replace(/-/g, ''));

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 4096 },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    return payload;
  });

  const html = (reply: FastifyReply, page: string, status = 200) =>
    reply.code(status).type('text/html; charset=utf-8').send(page);

  const cookieOf = (req: FastifyRequest): string | null => {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return v.join('=');
    }
    return null;
  };

  const signedIn = (req: FastifyRequest): boolean => {
    const id = cookieOf(req);
    const until = id ? sessions.get(id) : undefined;
    if (!id || !until) return false;
    if (until < now()) {
      sessions.delete(id);
      return false;
    }
    sessions.set(id, now() + SESSION_MS);
    return true;
  };

  /** A form posted from another site (or another port) must not act on this page. */
  const sameOrigin = (req: FastifyRequest): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };

  const form = (req: FastifyRequest): Record<string, string> =>
    typeof req.body === 'object' && req.body ? (req.body as Record<string, string>) : {};

  // ---- status: open on the network -----------------------------------------------------------

  app.get('/', async (req, reply) => {
    const s = opts.gateway.status();
    const t = now();
    const h = headline(s, t);
    const claimHelp =
      s.enrolment === 'unclaimed' || s.enrolment === 'dismissed'
        ? `<p>Install ID: <code>${esc(s.installId ?? 'still being made')}</code></p>`
        : '';
    const facts: [string, string][] = [
      ['Name', s.name ? esc(s.name) : '<span class="muted">not set up</span>'],
      ['Version', esc(s.version)],
      ['Kestrel address', esc(s.cloudHost)],
      ['Last contact', esc(ago(s.lastContactAt, t))],
    ];
    if (s.enrolment === 'enrolled')
      facts.push([
        'Control',
        s.control ? 'On' : 'Off: this organisation’s plan is monitoring only',
      ]);
    if (s.bufferedEvents > 0)
      facts.push([
        'Waiting to send',
        `${s.bufferedEvents} event${s.bufferedEvents === 1 ? '' : 's'}`,
      ]);
    if (s.update)
      facts.push([
        'Update',
        `${esc(s.update.state)}${s.update.version ? ` to ${esc(s.update.version)}` : ''}${s.update.error ? ` (${esc(s.update.error)})` : ''}`,
      ]);
    const body = `<h1>Kestrel gateway</h1>
<div class="card"><p class="${h.ok ? 'ok' : 'bad'}"><strong>${esc(h.text)}</strong></p>${claimHelp}
<dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>
<h2>Rooms on this gateway</h2>${roomRows(opts.host, req.headers.host ?? 'this-gateway')}
<p class="muted"><a href="/admin">Admin</a></p>`;
    return html(reply, layout('Kestrel gateway', body, true));
  });

  // ---- admin: behind the code -----------------------------------------------------------------

  const loginPage = (reply: FastifyReply, message?: string) =>
    html(
      reply,
      layout(
        'Kestrel gateway admin',
        `<h1>Gateway admin</h1><p class="muted">Enter the admin code. It is in <code>admin-code.txt</code> in this gateway’s data folder (the tray menu has “Show admin code” on Windows).</p>
${message ? `<div class="banner bad">${esc(message)}</div>` : ''}
<form method="post" action="/admin/login"><label for="code">Admin code</label>
<input id="code" name="code" type="password" autocomplete="off" autofocus required maxlength="20">
<button type="submit">Unlock</button></form><p class="muted"><a href="/">Back to status</a></p>`,
      ),
      message ? 401 : 200,
    );

  const adminPage = (reply: FastifyReply, banner?: { ok: boolean; text: string }) => {
    const s = opts.gateway.status();
    const enrolled = s.enrolment === 'enrolled';
    const body = `<h1>Gateway admin</h1><p class="muted"><a href="/">Back to status</a></p>
${banner ? `<div class="banner ${banner.ok ? 'ok' : 'bad'}">${esc(banner.text)}</div>` : ''}
<section><h2 style="margin-top:0">Enter an enrolment token</h2>
<p>Create a token in the portal (Gateways, then Add gateway) and paste it here.${
      enrolled
        ? ` <strong>This gateway already belongs to ${s.name ? esc(s.name) : 'an organisation'}.</strong> A working token moves it: its rooms stop and the new organisation’s rooms replace them.`
        : ''
    }</p>
<form method="post" action="/admin/token"><label for="token">Enrolment token</label>
<input id="token" name="token" type="text" autocomplete="off" required maxlength="300">
<button type="submit">Enrol</button></form></section>
<section><h2 style="margin-top:0">Reset</h2>
<p>Forget the organisation and start again as an unclaimed gateway. <strong>Its rooms stop running</strong> until the gateway is claimed or enrolled again. Devices are not touched.</p>
<form method="post" action="/admin/reset"><label for="confirm">Type RESET to confirm</label>
<input id="confirm" name="confirm" type="text" autocomplete="off" required maxlength="10">
<button class="danger" type="submit">Reset this gateway</button></form></section>
<section><h2 style="margin-top:0">This install</h2>
<dl><dt>Install ID</dt><dd><code>${esc(s.installId ?? 'not made yet')}</code></dd><dt>Version</dt><dd>${esc(s.version)}</dd></dl></section>
<form method="post" action="/admin/logout"><button class="plain" type="submit">Lock admin</button></form>`;
    return html(reply, layout('Kestrel gateway admin', body));
  };

  const message = (key: unknown) => (typeof key === 'string' ? MESSAGES[key] : undefined);

  app.get('/admin', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    if (!signedIn(req))
      return loginPage(reply, message(q.msg)?.ok === false ? message(q.msg)!.text : undefined);
    return adminPage(reply, message(q.msg));
  });

  app.post('/admin/login', async (req, reply) => {
    if (!sameOrigin(req)) return reply.code(403).send('Not allowed');
    const t = now();
    const slot = failures.get(req.ip);
    if (slot && slot.until > t) return reply.redirect('/admin?msg=locked', 303);
    const given = String(form(req).code ?? '')
      .toUpperCase()
      .replace(/[\s-]/g, '');
    if (!timingSafeEqual(digest(given), code)) {
      const count = (slot && slot.until > 0 && slot.until <= t ? 0 : (slot?.count ?? 0)) + 1;
      failures.set(req.ip, { count, until: count >= MAX_FAILURES ? t + LOCKOUT_MS : 0 });
      if (failures.size > 500) for (const [ip, f] of failures) if (f.until < t) failures.delete(ip);
      opts.log('warn', 'A wrong admin code was entered on the local admin page', { ip: req.ip });
      return reply.redirect('/admin?msg=wrong', 303);
    }
    failures.delete(req.ip);
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    const id = randomBytes(24).toString('base64url');
    sessions.set(id, t + SESSION_MS);
    opts.log('info', 'The local admin page was unlocked', { ip: req.ip });
    reply.header(
      'Set-Cookie',
      `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${SESSION_MS / 1000}`,
    );
    return reply.redirect('/admin', 303);
  });

  app.post('/admin/logout', async (req, reply) => {
    if (!sameOrigin(req)) return reply.code(403).send('Not allowed');
    const id = cookieOf(req);
    if (id) sessions.delete(id);
    reply.header('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`);
    return reply.redirect('/admin', 303);
  });

  app.post('/admin/token', async (req, reply) => {
    if (!sameOrigin(req)) return reply.code(403).send('Not allowed');
    if (!signedIn(req)) return reply.redirect('/admin', 303);
    const result = await opts.gateway.enrolWithToken(String(form(req).token ?? ''));
    if (result.ok) return reply.redirect('/admin?msg=enrolled', 303);
    return adminPage(reply, { ok: false, text: result.message });
  });

  app.post('/admin/reset', async (req, reply) => {
    if (!sameOrigin(req)) return reply.code(403).send('Not allowed');
    if (!signedIn(req)) return reply.redirect('/admin', 303);
    if (String(form(req).confirm ?? '').trim() !== 'RESET')
      return adminPage(reply, MESSAGES.confirm!);
    await opts.gateway.reset();
    return reply.redirect('/admin?msg=reset', 303);
  });
}
