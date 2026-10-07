import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Gateway, LocalStatus } from './gateway';
import { LocalAccess, type LocalSession } from './local-access';
import type { Logger } from './log';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_SHAPE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const COOKIE = 'kestrel_gw';
const FLOW_COOKIE = 'kestrel_gw_flow';
const COOKIE_MAX_AGE_S = 8 * 60 * 60;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60_000;
const RECENT_MS = 3 * 60_000;

export interface LocalAdminOptions {
  gateway: Pick<Gateway, 'status' | 'enrolWithToken' | 'reset'> &
    Partial<Pick<Gateway, 'record'>>;
  log: Logger;
  /** Unlocks the admin page from the machine itself. Kept in a file only people with access to this machine can read. */
  adminCode: string;
  /** Who is signed in and how people sign in. Without it only the admin code works (tests, an unenrolled gateway). */
  access?: LocalAccess;
  /** The page is served over HTTPS: cookies are marked Secure. */
  secure?: boolean;
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
    text: 'Enrolled. This gateway now belongs to the new organisation and is loading its devices.',
  },
  reset: {
    ok: true,
    text: 'Reset. This gateway has forgotten its organisation and is announcing itself to Kestrel staff.',
  },
  signedout: { ok: true, text: 'Signed out.' },
  signin_failed: {
    ok: false,
    text: 'That sign-in was not accepted. Start again with Sign in with Kestrel. If it keeps failing, check this machine’s clock and that you belong to this organisation.',
  },
  unavailable: {
    ok: false,
    text: 'Signing in with Kestrel is not available until this gateway has joined an organisation. Use the admin code on this machine.',
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
.btn{display:inline-block;padding:9px 16px;border-radius:6px;background:var(--fg);color:var(--bg);text-decoration:none}form.inline{display:inline}.banner{padding:10px 12px;border-radius:6px;border:1px solid var(--line);margin:12px 0}
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
            text: `Cannot reach Kestrel right now. Devices keep being watched${s.problem ? ` (${s.problem})` : '.'}`,
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

/**
 * The gateway's own pages: a status page anyone on the network can read (what it is
 * doing, nothing secret) and an admin page behind a code for entering a new enrolment token or
 * resetting. Plain server-rendered HTML with no scripts, so it works offline and needs no build.
 */
export async function localAdmin(app: FastifyInstance, opts: LocalAdminOptions): Promise<void> {
  const now = opts.now ?? (() => Date.now());
  const secure = opts.secure ?? false;
  const access =
    opts.access ??
    new LocalAccess(
      () => ({
        gatewayId: null,
        keys: [],
        policy: { breakGlass: true, epoch: 0 },
        cloudUrl: 'http://localhost',
      }),
      opts.log,
      now,
    );
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

  const cookieOf = (req: FastifyRequest, name: string): string | null => {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return v.join('=');
    }
    return null;
  };

  const flags = `HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const sessionCookie = (id: string) =>
    `${COOKIE}=${id}; ${flags}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`;
  const clearCookie = (name: string, path: string) =>
    `${name}=; ${flags}; Path=${path}; Max-Age=0`;

  const sessionOf = (req: FastifyRequest): LocalSession | null =>
    access.sessionFor(cookieOf(req, COOKIE));
  const adminOf = (req: FastifyRequest): LocalSession | null => {
    const s = sessionOf(req);
    return s?.role === 'admin' ? s : null;
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

  const record = (type: 'local.signin' | 'local.action', data: Record<string, unknown>) =>
    opts.gateway.record?.({ type, data });

  const message = (key: unknown) => (typeof key === 'string' ? MESSAGES[key] : undefined);

  const signInButtons = (): string => {
    const kestrel = access.kestrelSigninAvailable()
      ? '<p><a class="btn" href="/signin">Sign in with Kestrel</a></p><p class="muted">Use the same account you use for the Kestrel portal. You must belong to this gateway’s organisation.</p>'
      : '';
    const machine = access.breakGlassAllowed()
      ? '<p class="muted"><a href="/admin">Use the admin code from this machine</a></p>'
      : '';
    return kestrel + machine;
  };

  // ---- status ---------------------------------------------------------------------------------

  app.get('/', async (req, reply) => {
    const s = opts.gateway.status();
    const t = now();
    const session = sessionOf(req);
    const q = req.query as Record<string, unknown>;
    const banner = message(q.msg);
    const bannerHtml = banner
      ? `<div class="banner ${banner.ok ? 'ok' : 'bad'}">${esc(banner.text)}</div>`
      : '';
    const h = headline(s, t);
    const claimHelp =
      s.enrolment === 'unclaimed' || s.enrolment === 'dismissed'
        ? `<p>Install ID: <code>${esc(s.installId ?? 'still being made')}</code></p>`
        : '';

    // Anyone on the network sees only whether the gateway is working. Everything else needs a sign-in.
    if (!session) {
      const line = s.enrolment === 'enrolled' ? (h.ok ? 'Connected to Kestrel.' : 'Not connected to Kestrel right now. Devices keep being watched.') : h.text;
      const body = `<h1>Kestrel gateway</h1>${bannerHtml}
<div class="card"><p class="${h.ok ? 'ok' : 'bad'}"><strong>${esc(line)}</strong></p>${claimHelp}</div>
<div class="card"><h2 style="margin-top:0">Sign in</h2>${signInButtons() || '<p class="muted">Signing in is not available right now.</p>'}</div>`;
      return html(reply, layout('Kestrel gateway', body, true));
    }

    const facts: [string, string][] = [
      ['Name', s.name ? esc(s.name) : '<span class="muted">not set up</span>'],
      ['Version', esc(s.version)],
      ['Kestrel address', esc(s.cloudHost)],
      ['Last contact', esc(ago(s.lastContactAt, t))],
    ];
    if (s.enrolment === 'enrolled') facts.push(['Devices watched', String(s.devices)]);
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
    const body = `<h1>Kestrel gateway</h1>${bannerHtml}
<p class="muted">Signed in as ${esc(session.who)} (${session.role === 'admin' ? 'can change settings' : 'view only'})${secure ? '' : ' · <span class="bad">this connection is not encrypted</span>'}</p>
<div class="card"><p class="${h.ok ? 'ok' : 'bad'}"><strong>${esc(h.text)}</strong></p>${claimHelp}
<dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>
<p class="muted">${session.role === 'admin' ? '<a href="/admin">Admin</a> · ' : ''}<form class="inline" method="post" action="/signout"><button class="plain" type="submit">Sign out</button></form></p>`;
    return html(reply, layout('Kestrel gateway', body, true));
  });

  // ---- signing in with a Kestrel account --------------------------------------------------------

  app.get('/signin', async (req, reply) => {
    const origin = `${secure ? 'https' : 'http'}://${req.host}`;
    const flow = access.startSignin(req.ip, origin);
    if (!flow) return reply.redirect('/?msg=unavailable', 303);
    reply.header('Set-Cookie', `${FLOW_COOKIE}=${flow.state}; ${flags}; Path=/auth; Max-Age=300`);
    return reply.redirect(flow.url, 303);
  });

  app.get('/auth/callback', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const grant = typeof q.grant === 'string' && q.grant.length < 6000 ? q.grant : '';
    const result = access.redeem(grant, cookieOf(req, FLOW_COOKIE), req.ip);
    if (!result.ok) {
      reply.header('Set-Cookie', clearCookie(FLOW_COOKIE, '/auth'));
      return reply.redirect('/?msg=signin_failed', 303);
    }
    reply.header('Set-Cookie', [clearCookie(FLOW_COOKIE, '/auth'), sessionCookie(result.session.id)]);
    record('local.signin', {
      how: 'kestrel',
      who: result.session.who,
      role: result.session.role,
      ip: req.ip,
    });
    return reply.redirect('/', 303);
  });

  app.post('/signout', async (req, reply) => {
    if (!sameOrigin(req)) return reply.code(403).send('Not allowed');
    const s = sessionOf(req);
    access.end(cookieOf(req, COOKIE));
    if (s) record('local.signin', { how: 'signout', who: s.who, ip: req.ip });
    reply.header('Set-Cookie', clearCookie(COOKIE, '/'));
    return reply.redirect('/?msg=signedout', 303);
  });

  // ---- admin: admins only -----------------------------------------------------------------------

  const loginPage = (reply: FastifyReply, msg?: string) =>
    html(
      reply,
      layout(
        'Kestrel gateway admin',
        `<h1>Gateway admin</h1>
${msg ? `<div class="banner bad">${esc(msg)}</div>` : ''}
${access.kestrelSigninAvailable() ? '<div class="card"><p><a class="btn" href="/signin">Sign in with Kestrel</a></p><p class="muted">Owners and developers of this gateway’s organisation can change its settings.</p></div>' : ''}
${
  access.breakGlassAllowed()
    ? `<div class="card"><h2 style="margin-top:0">Admin code</h2><p class="muted">From the machine this gateway runs on: <code>admin-code.txt</code> in its data folder (the tray menu has “Show admin code” on Windows).</p>
<form method="post" action="/admin/login"><label for="code">Admin code</label>
<input id="code" name="code" type="password" autocomplete="off" required maxlength="20">
<button type="submit">Unlock</button></form></div>`
    : '<p class="muted">The admin code on this machine has been switched off by your organisation. Sign in with Kestrel.</p>'
}
<p class="muted"><a href="/">Back to status</a></p>`,
      ),
      msg ? 401 : 200,
    );

  const adminPage = (
    reply: FastifyReply,
    session: LocalSession,
    banner?: { ok: boolean; text: string },
  ) => {
    const s = opts.gateway.status();
    const enrolled = s.enrolment === 'enrolled';
    const body = `<h1>Gateway admin</h1><p class="muted"><a href="/">Back to status</a> · signed in as ${esc(session.who)}</p>
${banner ? `<div class="banner ${banner.ok ? 'ok' : 'bad'}">${esc(banner.text)}</div>` : ''}
<section><h2 style="margin-top:0">Enter an enrolment token</h2>
<p>Create a token in the portal (Gateways, then Add gateway) and paste it here.${
      enrolled
        ? ` <strong>This gateway already belongs to ${s.name ? esc(s.name) : 'an organisation'}.</strong> A working token moves it: its devices stop being watched and the new organisation’s replace them.`
        : ''
    }</p>
<form method="post" action="/admin/token"><label for="token">Enrolment token</label>
<input id="token" name="token" type="text" autocomplete="off" required maxlength="300">
<button type="submit">Enrol</button></form></section>
<section><h2 style="margin-top:0">Reset</h2>
<p>Forget the organisation and start again as an unclaimed gateway. <strong>Its devices stop being watched</strong> until the gateway is claimed or enrolled again. Devices are not touched.</p>
<form method="post" action="/admin/reset"><label for="confirm">Type RESET to confirm</label>
<input id="confirm" name="confirm" type="text" autocomplete="off" required maxlength="10">
<button class="danger" type="submit">Reset this gateway</button></form></section>
<section><h2 style="margin-top:0">This install</h2>
<dl><dt>Install ID</dt><dd><code>${esc(s.installId ?? 'not made yet')}</code></dd><dt>Version</dt><dd>${esc(s.version)}</dd></dl></section>
<form method="post" action="/signout"><button class="plain" type="submit">Sign out</button></form>`;
    return html(reply, layout('Kestrel gateway admin', body));
  };

  app.get('/admin', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const session = sessionOf(req);
    if (session && session.role !== 'admin')
      return html(
        reply,
        layout(
          'Kestrel gateway admin',
          '<h1>Gateway admin</h1><div class="banner bad">Your account can look at this gateway but not change it. Ask an owner or developer of your organisation.</div><p class="muted"><a href="/">Back to status</a></p>',
        ),
        403,
      );
    if (!session)
      return loginPage(reply, message(q.msg)?.ok === false ? message(q.msg)!.text : undefined);
    return adminPage(reply, session, message(q.msg));
  });

  // The admin code, from the machine. Refused when the organisation has switched it off.
  app.post('/admin/login', async (req, reply) => {
    if (!sameOrigin(req)) return reply.code(403).send('Not allowed');
    if (!access.breakGlassAllowed()) return reply.redirect('/admin', 303);
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
    const session = access.openWithCode(req.ip);
    if (!session) return reply.redirect('/admin', 303);
    opts.log('info', 'The local admin page was unlocked with the admin code', { ip: req.ip });
    record('local.signin', { how: 'admin-code', who: session.who, role: 'admin', ip: req.ip });
    reply.header('Set-Cookie', sessionCookie(session.id));
    return reply.redirect('/admin', 303);
  });

  app.post('/admin/logout', async (req, reply) => {
    if (!sameOrigin(req)) return reply.code(403).send('Not allowed');
    access.end(cookieOf(req, COOKIE));
    reply.header('Set-Cookie', clearCookie(COOKIE, '/'));
    return reply.redirect('/admin', 303);
  });

  app.post('/admin/token', async (req, reply) => {
    if (!sameOrigin(req)) return reply.code(403).send('Not allowed');
    const session = adminOf(req);
    if (!session) return reply.redirect('/admin', 303);
    const result = await opts.gateway.enrolWithToken(String(form(req).token ?? ''));
    record('local.action', { action: 'enrol', who: session.who, ok: result.ok, ip: req.ip });
    if (result.ok) {
      // It now belongs to another organisation: sign-ins made for the old one end here.
      access.endAll();
      return reply.redirect('/?msg=enrolled', 303);
    }
    return adminPage(reply, session, { ok: false, text: result.message });
  });

  app.post('/admin/reset', async (req, reply) => {
    if (!sameOrigin(req)) return reply.code(403).send('Not allowed');
    const session = adminOf(req);
    if (!session) return reply.redirect('/admin', 303);
    if (String(form(req).confirm ?? '').trim() !== 'RESET')
      return adminPage(reply, session, MESSAGES.confirm!);
    await opts.gateway.reset();
    access.endAll();
    return reply.redirect('/?msg=reset', 303);
  });
}
