import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hostFacts, runChecks, tailLog, type CheckResult } from './diagnostics';
import type { Gateway, GatewaySnapshot, LocalStatus } from './gateway';
import { LocalAccess, type LocalSession } from './local-access';
import { ago, duration, esc, kv, layout, pill, table, type Tab } from './local-ui';
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
  /** What the troubleshooting pages (devices, diagnostics, logs) read. Without it only the overview and admin pages exist. */
  diagnostics?: {
    snapshot: () => GatewaySnapshot;
    dataDir: string;
    cloudUrl: string;
    logFile: string;
    /** Test seam. */
    runChecks?: typeof runChecks;
  };
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

/** What to try next, in plain language, from what the gateway knows about itself. */
function guidance(s: LocalStatus, snap: GatewaySnapshot | null, now: number, cloudHost: string): string[] {
  const out: string[] = [];
  const problem = (s.problem ?? '').toLowerCase();
  if (s.enrolment === 'enrolled') {
    const recent = s.lastContactAt && now - Date.parse(s.lastContactAt) < RECENT_MS;
    if (!recent) {
      if (problem.includes('cannot be reached') || problem.includes('could not reach'))
        out.push(
          `This machine cannot reach ${esc(cloudHost)}. Check it has internet access and that outbound HTTPS (port 443) to that address is allowed by the firewall or proxy, then run the checks on the <a href="/diagnostics">Diagnostics</a> page. Devices keep being watched in the meantime and events are saved to send later.`,
        );
      else if (problem.includes('unauthorised') || problem.includes('credential'))
        out.push(
          'Kestrel no longer recognises this gateway. If its record was deleted it joins again by itself using its enrolment token; otherwise an admin can enter a new token on the <a href="/admin">Admin</a> page.',
        );
      else
        out.push(
          `The last check-in failed${s.problem ? `: ${esc(s.problem)}` : ''}. See <a href="/logs?level=warn">Logs</a> for details.`,
        );
    }
    if (snap?.clockSkewMs != null && Math.abs(snap.clockSkewMs) > 60_000)
      out.push(
        `This machine’s clock is about ${Math.round(Math.abs(snap.clockSkewMs) / 1000)} seconds ${snap.clockSkewMs > 0 ? 'behind' : 'ahead of'} Kestrel’s. Signed releases and sign-ins can be refused when it is this far out; fix the machine’s time settings.`,
      );
    const offline = snap?.devices.filter((d) => !d.online).length ?? 0;
    if (offline > 0)
      out.push(
        `${offline} device${offline === 1 ? ' is' : 's are'} not answering. See <a href="/devices">Devices</a>.`,
      );
    if (s.update?.state === 'failed' || s.update?.state === 'unsupported')
      out.push(`The last update did not go ahead${s.update.error ? ` (${esc(s.update.error)})` : ''}. The previous version is still running.`);
  } else if (s.enrolment === 'refused') {
    out.push('The token was not accepted. It may have been used already or expired: create a new one in the portal (Gateways, then Add gateway) and enter it on the Admin page.');
  }
  return out;
}

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
  const diag = opts.diagnostics;
  const failures = new Map<string, { count: number; until: number }>();
  const code = digest(opts.adminCode.replace(/-/g, ''));
  let lastCheckAt = 0;
  let lastChecks: { at: number; results: CheckResult[] } | null = null;

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
  const bannerHtml = (b?: { ok: boolean; text: string }) =>
    b ? `<div class="banner ${b.ok ? 'ok' : 'bad'}" role="status">${esc(b.text)}</div>` : '';

  /** A page in the shared look, with the header and tabs that fit who is looking. */
  const page = (
    session: LocalSession | null,
    o: { title: string; active?: string; body: string; refresh?: boolean },
  ): string => {
    const s = opts.gateway.status();
    const h = headline(s, now());
    const tabs: Tab[] = session
      ? [
          { href: '/', label: 'Overview' },
          ...(diag
            ? [
                { href: '/devices', label: 'Devices' },
                { href: '/diagnostics', label: 'Diagnostics' },
                { href: '/logs', label: 'Logs' },
              ]
            : []),
          ...(session.role === 'admin' ? [{ href: '/admin', label: 'Admin' }] : []),
        ]
      : [];
    const status: { text: string; kind: 'ok' | 'warn' | 'fail' } =
      s.enrolment === 'enrolled'
        ? h.ok
          ? { text: 'Connected', kind: 'ok' }
          : { text: 'Not connected', kind: 'fail' }
        : s.enrolment === 'unclaimed' || s.enrolment === 'dismissed' || s.enrolment === 'claimed'
          ? { text: 'Not set up', kind: 'warn' }
          : { text: 'Connecting', kind: 'warn' };
    return layout({
      title: o.title,
      body: o.body,
      who: session ? { name: session.who, role: session.role === 'admin' ? 'admin' : 'view only' } : null,
      gatewayName: session ? s.name : null,
      status,
      tabs,
      active: o.active,
      refresh: o.refresh,
      version: session ? s.version : undefined,
    });
  };

  /** Signed-in pages only; anyone else is sent to the front page to sign in. */
  const needSession = (req: FastifyRequest, reply: FastifyReply): LocalSession | null => {
    const s = sessionOf(req);
    if (!s) {
      void reply.redirect('/', 303);
      return null;
    }
    return s;
  };

  const signInButtons = (): string => {
    const kestrel = access.kestrelSigninAvailable()
      ? '<p><a class="btn" href="/signin">Sign in with Kestrel</a></p><p class="muted">Use the same account you use for the Kestrel portal. You must belong to this gateway’s organisation.</p>'
      : '';
    const machine = access.breakGlassAllowed()
      ? '<p class="muted"><a href="/admin">Use the admin code from this machine</a></p>'
      : '';
    return kestrel + machine;
  };

  // ---- overview ----------------------------------------------------------------------------------

  app.get('/', async (req, reply) => {
    const s = opts.gateway.status();
    const t = now();
    const session = sessionOf(req);
    const q = req.query as Record<string, unknown>;
    const banner = bannerHtml(message(q.msg));
    const h = headline(s, t);
    const claimHelp =
      s.enrolment === 'unclaimed' || s.enrolment === 'dismissed'
        ? `<p>Install ID: <code>${esc(s.installId ?? 'still being made')}</code></p>`
        : '';

    // Anyone on the network sees only whether the gateway is working. Everything else needs a sign-in.
    if (!session) {
      const line =
        s.enrolment === 'enrolled'
          ? h.ok
            ? 'Connected to Kestrel.'
            : 'Not connected to Kestrel right now. Devices keep being watched.'
          : h.text;
      const body = `<h1>Kestrel gateway</h1><p class="sub">An on-site gateway that watches this site’s devices and reports to Kestrel.</p>${banner}
<div class="card"><p class="${h.ok ? 'ok' : 'bad'}" style="margin:0"><strong>${esc(line)}</strong></p>${claimHelp}</div>
<div class="card"><h2>Sign in</h2>${signInButtons() || '<p class="muted">Signing in is not available right now.</p>'}</div>`;
      return html(reply, page(null, { title: 'Sign in', body, refresh: true }));
    }

    const snap = diag?.snapshot() ?? null;
    const hints = guidance(s, snap, t, s.cloudHost)
      .map((x) => `<div class="hint">${x}</div>`)
      .join('');
    const online = snap?.devices.filter((d) => d.online).length ?? 0;
    const offline = (snap?.devices.length ?? 0) - online;
    const facts: [string, string][] = [
      ['Name', s.name ? esc(s.name) : '<span class="muted">not set up</span>'],
      ['Version', esc(s.version)],
      ['Kestrel address', esc(s.cloudHost)],
      ['Last contact', esc(ago(s.lastContactAt, t))],
    ];
    if (snap) {
      facts.push(['Running for', esc(duration(snap.uptimeSeconds))]);
      if (snap.heartbeatSeconds) facts.push(['Checks in every', `${snap.heartbeatSeconds} seconds`]);
    }
    if (s.enrolment === 'enrolled')
      facts.push([
        'Devices watched',
        `${s.devices}${snap && s.devices > 0 ? ` (${online} answering${offline ? `, <span class="bad">${offline} not</span>` : ''})` : ''}`,
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
    const checkIns = snap
      ? `<div class="card"><h2>Recent check-ins</h2>${table(
          ['When', 'Result', 'Took'],
          snap.checkIns
            .slice(0, 8)
            .map((c) => [
              `<span class="muted">${esc(ago(c.at, t))}</span>`,
              c.ok ? pill('ok', 'OK') : `${pill('fail', 'Failed')} <span class="muted">${esc(c.error ?? '')}</span>`,
              `${c.ms} ms`,
            ]),
          'No check-ins yet.',
        )}</div>`
      : '';
    const body = `<h1>Overview</h1><p class="sub">How this gateway is getting on.</p>${banner}
<div class="card"><p class="${h.ok ? 'ok' : 'bad'}" style="margin:0"><strong>${esc(h.text)}</strong></p>${claimHelp}${hints}</div>
<div class="grid"><div class="card"><h2>This gateway</h2>${kv(facts)}</div>${checkIns}</div>`;
    return html(reply, page(session, { title: 'Overview', active: '/', body, refresh: true }));
  });

  // ---- troubleshooting pages (signed in) ---------------------------------------------------------

  if (diag) {
    app.get('/devices', async (req, reply) => {
      const session = needSession(req, reply);
      if (!session) return;
      const snap = diag.snapshot();
      const rows = [...snap.devices]
        .sort((a, b) => Number(a.online) - Number(b.online) || a.name.localeCompare(b.name))
        .map((d) => {
          const lat = d.latency;
          const loss = lat && lat.sent > 0 ? Math.round(((lat.sent - lat.ok) / lat.sent) * 100) : null;
          return [
            esc(d.name || d.deviceId),
            d.online
              ? pill('ok', 'Answering')
              : pill('fail', d.offlineForMs ? `Not answering for ${duration(Math.round(d.offlineForMs / 1000))}` : 'Not answering'),
            esc(d.driver ?? ''),
            lat?.avgMs !== undefined
              ? `${Math.round(lat.avgMs)} ms${loss ? ` <span class="warnc">(${loss}% lost)</span>` : ''}`
              : lat && lat.ok === 0
                ? '<span class="bad">no reply</span>'
                : '<span class="muted">-</span>',
            esc(d.firmware ?? ''),
            d.address?.change
              ? `<span class="warnc">moved ${esc(d.address.change.from)} → ${esc(d.address.change.to)}</span>`
              : '',
          ];
        });
      const online = snap.devices.filter((d) => d.online).length;
      const body = `<h1>Devices</h1><p class="sub">${snap.devices.length === 0 ? 'No devices yet.' : `${online} of ${snap.devices.length} answering.`} A device that stops answering is reported to Kestrel after a few quick re-checks.</p>
<div class="card">${table(
        ['Device', 'State', 'Driver', 'Network delay', 'Firmware', 'Address'],
        rows,
        'This gateway has no devices to watch yet. Add devices in the Kestrel portal and assign them to this gateway.',
      )}</div>
<p class="muted">If a device is not answering, check it is powered and on the network, that this gateway can reach its address (firewalls and VLAN rules between the two), and that its login in the portal is still correct.</p>`;
      return html(reply, page(session, { title: 'Devices', active: '/devices', body, refresh: true }));
    });

    const checksCard = () => {
      if (!lastChecks) return '<p class="muted">Not run yet.</p>';
      return `<p class="muted">Run ${esc(ago(new Date(lastChecks.at).toISOString(), now()))}.</p>${table(
        ['Check', 'Result', 'What it found'],
        lastChecks.results.map((r) => [
          esc(r.label),
          pill(r.status, { ok: 'OK', warn: 'Check', fail: 'Problem', info: 'Note' }[r.status]) +
            (r.ms !== undefined ? ` <span class="muted">${r.ms} ms</span>` : ''),
          esc(r.detail),
        ]),
        '',
      )}`;
    };

    const diagnosticsPage = (req: FastifyRequest, reply: FastifyReply, session: LocalSession, banner?: string) => {
      const snap = diag.snapshot();
      const host = hostFacts(diag.dataDir);
      const mb = (n: number) => `${n.toLocaleString('en')} MB`;
      const skew = snap.clockSkewMs;
      const machine: [string, string][] = [
        ['Machine', esc(host.hostname)],
        ['System', esc(`${host.os} (${host.arch})`)],
        ['Memory', `gateway ${mb(host.memoryUsedMb)}; ${mb(host.memoryFreeMb)} free of ${mb(host.memoryTotalMb)}`],
        ['Disk', host.dataFreeGb !== null ? `${host.dataFreeGb} GB free of ${host.dataTotalGb} GB` : '<span class="muted">unknown</span>'],
        ['Data folder', `<code>${esc(host.dataDir)}</code>${host.databaseKb !== null ? ` <span class="muted">(database ${host.databaseKb.toLocaleString('en')} KB)</span>` : ''}`],
        ['Time zone', esc(host.timeZone)],
        ['Local time', esc(host.localTime)],
        [
          'Clock vs Kestrel',
          skew === null
            ? '<span class="muted">not checked yet</span>'
            : Math.abs(skew) > 60_000
              ? `<span class="bad">${Math.round(Math.abs(skew) / 1000)} seconds ${skew > 0 ? 'behind' : 'ahead'}</span>`
              : 'in step',
        ],
        ['Node.js', esc(host.node)],
      ];
      const net: [string, string][] = [
        ['Kestrel address', esc(diag.cloudUrl)],
        ['Reached at', snap.localUrls.length ? snap.localUrls.map((u) => `<code>${esc(u)}</code>`).join('<br>') : '<span class="muted">not known yet</span>'],
        ['This page', snap.tls ? `${pill('ok', 'Encrypted')} HTTPS` : `${pill('warn', 'Not encrypted')} plain HTTP. Set a certificate (see the gateway README) to use HTTPS.`],
        ['Gateway ID', snap.gatewayId ? `<code>${esc(snap.gatewayId)}</code>` : '<span class="muted">not enrolled</span>'],
        ['Settings version', esc(snap.configVersion ?? 'none')],
        ['Device list version', esc(snap.deviceSetVersion ?? 'none')],
        ['Trusted signing keys', String(snap.trustedKeys)],
      ];
      const body = `<h1>Diagnostics</h1><p class="sub">Checks and facts for working out why a gateway is not connecting.</p>${banner ?? ''}
<div class="card"><h2>Run checks</h2><p class="muted" style="margin-top:0">Looks up and connects to Kestrel from this machine, compares the clock, and checks the data folder.</p>
<form method="post" action="/diagnostics/run"><button type="submit">Run checks now</button></form>${checksCard()}</div>
<div class="grid"><div class="card"><h2>This machine</h2>${kv(machine)}</div><div class="card"><h2>Network and identity</h2>${kv(net)}</div></div>
<div class="card"><h2>Support</h2><p class="muted" style="margin-top:0">A file with these facts and the recent log, to send to whoever is helping. It holds no passwords, tokens or admin code.</p>
<a class="btn outline" href="/support-bundle">Download support bundle</a></div>`;
      return html(reply, page(session, { title: 'Diagnostics', active: '/diagnostics', body }));
    };

    app.get('/diagnostics', async (req, reply) => {
      const session = needSession(req, reply);
      if (!session) return;
      return diagnosticsPage(req, reply, session);
    });

    app.post('/diagnostics/run', async (req, reply) => {
      if (!sameOrigin(req)) return reply.code(403).send('Not allowed');
      const session = needSession(req, reply);
      if (!session) return;
      const t = now();
      // One run at a time, and not in quick succession: it makes real network calls.
      if (t - lastCheckAt < 5000)
        return diagnosticsPage(req, reply, session, bannerHtml({ ok: false, text: 'Checks ran a moment ago. Wait a few seconds and try again.' }));
      lastCheckAt = t;
      const results = await (diag.runChecks ?? runChecks)({ cloudUrl: diag.cloudUrl, dataDir: diag.dataDir });
      lastChecks = { at: now(), results };
      record('local.action', { action: 'run-checks', who: session.who, ip: req.ip });
      return diagnosticsPage(req, reply, session);
    });

    app.get('/logs', async (req, reply) => {
      const session = needSession(req, reply);
      if (!session) return;
      const q = req.query as Record<string, unknown>;
      const level = (['info', 'warn', 'error', 'debug'] as const).find((l) => l === q.level) ?? 'info';
      const lines = tailLog(diag.logFile, 300, level);
      const filters = (['info', 'warn', 'error'] as const)
        .map((l) => `<a href="/logs?level=${l}"${l === level ? ' class="on"' : ''}>${{ info: 'Everything', warn: 'Warnings and errors', error: 'Errors only' }[l]}</a>`)
        .join('');
      const rows = lines.map((l) => [
        `<span class="time mono">${esc(l.time.replace('T', ' ').replace(/\.\d+/, ''))}</span>`,
        pill(l.level === 'error' ? 'fail' : l.level === 'warn' ? 'warn' : 'info', l.level),
        `${esc(l.message)}${l.extra ? `<details><summary>details</summary><code>${esc(l.extra)}</code></details>` : ''}`,
      ]);
      const body = `<h1>Logs</h1><p class="sub">The newest ${lines.length} lines, newest first. The full file is <code>${esc(diag.logFile)}</code>.</p>
<div class="filters">${filters}</div>
<div class="card">${table(['Time', 'Level', 'What happened'], rows, 'Nothing logged at this level yet.')}</div>
<a class="btn outline" href="/support-bundle">Download support bundle</a>`;
      return html(reply, page(session, { title: 'Logs', active: '/logs', body }));
    });

    app.get('/support-bundle', async (req, reply) => {
      const session = needSession(req, reply);
      if (!session) return;
      const s = opts.gateway.status();
      const snap = diag.snapshot();
      const bundle = {
        generatedAt: new Date(now()).toISOString(),
        generatedBy: session.who,
        status: s,
        host: hostFacts(diag.dataDir),
        gateway: { ...snap, devices: undefined },
        devices: snap.devices.map((d) => ({
          deviceId: d.deviceId,
          name: d.name,
          online: d.online,
          offlineForMs: d.offlineForMs,
          driver: d.driver,
          firmware: d.firmware,
          latency: d.latency,
        })),
        lastChecks: lastChecks?.results ?? null,
        log: tailLog(diag.logFile, 1000, 'debug'),
      };
      record('local.action', { action: 'support-bundle', who: session.who, ip: req.ip });
      const day = new Date(now()).toISOString().slice(0, 10);
      return reply
        .header('Content-Disposition', `attachment; filename="kestrel-gateway-support-${day}.json"`)
        .type('application/json')
        .send(JSON.stringify(bundle, null, 2));
    });
  }

  // ---- signing in with a Kestrel account ---------------------------------------------------------

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

  // ---- admin: admins only ------------------------------------------------------------------------

  const loginPage = (reply: FastifyReply, msg?: string) =>
    html(
      reply,
      page(null, {
        title: 'Admin',
        body: `<h1>Gateway admin</h1><p class="sub">Change which organisation this gateway belongs to, or reset it.</p>
${msg ? `<div class="banner bad" role="alert">${esc(msg)}</div>` : ''}
${access.kestrelSigninAvailable() ? '<div class="card"><h2>Sign in with Kestrel</h2><p><a class="btn" href="/signin">Sign in with Kestrel</a></p><p class="muted">Owners and developers of this gateway’s organisation can change its settings.</p></div>' : ''}
${
  access.breakGlassAllowed()
    ? `<div class="card"><h2>Admin code</h2><p class="muted" style="margin-top:0">From the machine this gateway runs on: <code>admin-code.txt</code> in its data folder (the tray menu has “Show admin code” on Windows).</p>
<form method="post" action="/admin/login"><label for="code">Admin code</label>
<input id="code" name="code" type="password" autocomplete="off" required maxlength="20">
<button type="submit">Unlock</button></form></div>`
    : '<p class="muted">The admin code on this machine has been switched off by your organisation. Sign in with Kestrel.</p>'
}
<p class="muted"><a href="/">Back to status</a></p>`,
      }),
      msg ? 401 : 200,
    );

  const adminPage = (
    reply: FastifyReply,
    session: LocalSession,
    banner?: { ok: boolean; text: string },
  ) => {
    const s = opts.gateway.status();
    const enrolled = s.enrolment === 'enrolled';
    const body = `<h1>Admin</h1><p class="sub">Signed in as ${esc(session.who)}.</p>
${bannerHtml(banner)}
<div class="card"><h2>Enter an enrolment token</h2>
<p class="muted" style="margin-top:0">Create a token in the portal (Gateways, then Add gateway) and paste it here.${
      enrolled
        ? ` <strong>This gateway already belongs to ${s.name ? esc(s.name) : 'an organisation'}.</strong> A working token moves it: its devices stop being watched and the new organisation’s replace them.`
        : ''
    }</p>
<form method="post" action="/admin/token"><label for="token">Enrolment token</label>
<input id="token" name="token" type="text" autocomplete="off" required maxlength="300">
<button type="submit">Enrol</button></form></div>
<div class="card"><h2>Reset</h2>
<p class="muted" style="margin-top:0">Forget the organisation and start again as an unclaimed gateway. <strong>Its devices stop being watched</strong> until the gateway is claimed or enrolled again. Devices are not touched.</p>
<form method="post" action="/admin/reset"><label for="confirm">Type RESET to confirm</label>
<input id="confirm" name="confirm" type="text" autocomplete="off" required maxlength="10">
<button class="danger" type="submit">Reset this gateway</button></form></div>
<div class="card"><h2>This install</h2>${kv([
      ['Install ID', `<code>${esc(s.installId ?? 'not made yet')}</code>`],
      ['Version', esc(s.version)],
    ])}</div>`;
    return html(reply, page(session, { title: 'Admin', active: '/admin', body }));
  };

  app.get('/admin', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const session = sessionOf(req);
    if (session && session.role !== 'admin')
      return html(
        reply,
        page(session, {
          title: 'Admin',
          body: '<h1>Admin</h1><div class="banner bad" role="alert">Your account can look at this gateway but not change it. Ask an owner or developer of your organisation.</div>',
        }),
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
