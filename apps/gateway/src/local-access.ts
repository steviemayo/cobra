import { randomBytes } from 'node:crypto';
import { verifyDocument } from '@kestrel/crypto';
import {
  LOCAL_ACCESS_PURPOSE,
  LocalAccessGrant,
  type LocalAccessPolicy,
  type LocalRole,
  type PublicKey,
} from '@kestrel/model';
import type { Logger } from './log';

const FLOW_MS = 5 * 60_000;
const IDLE_MS = 30 * 60_000;
const ABSOLUTE_MS = 8 * 60 * 60_000;
/** A gateway clock this far out still accepts a grant that was just made. */
const SKEW_S = 120;
const MAX_FLOWS = 50;
const MAX_SESSIONS = 50;

export interface LocalSession {
  id: string;
  role: LocalRole;
  /** Who this is, for the log and the page: an email from the portal, or "admin code" on the machine. */
  who: string;
  method: 'kestrel' | 'code';
  ip: string;
  createdAt: number;
  lastSeen: number;
  /** The portal's policy epoch when this sign-in was made; a newer epoch ends it. */
  epoch: number;
}

export interface LocalAccessContext {
  /** The enrolled gateway's id, or null before it has enrolled. */
  gatewayId: string | null;
  /** The signing keys this gateway trusts (the same ones that check releases). */
  keys: PublicKey[];
  /** The portal's last word on who may open this page. */
  policy: LocalAccessPolicy;
  cloudUrl: string;
}

export type RedeemFailure =
  | 'not_enrolled'
  | 'no_flow'
  | 'invalid'
  | 'expired'
  | 'wrong_gateway'
  | 'replayed'
  | 'revoked';

/**
 * Who is signed in to the gateway's own page. People sign in with their Kestrel account: the page
 * sends them to the portal, the portal checks they belong to this gateway's organisation and hands
 * back a short-lived grant signed with a key built into this gateway, so nothing about the person
 * is ever typed here and the gateway can check it with no cloud round trip. The admin code kept on
 * the machine stays as a way in when the organisation allows it (and always for a gateway that has
 * not enrolled yet).
 */
export class LocalAccess {
  private readonly flows = new Map<string, { at: number; ip: string }>();
  private readonly sessions = new Map<string, LocalSession>();
  private readonly used = new Map<string, number>();

  constructor(
    private readonly context: () => LocalAccessContext,
    private readonly log: Logger,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Whether the admin code may be used right now. */
  breakGlassAllowed(): boolean {
    const c = this.context();
    return c.gatewayId === null || c.policy.breakGlass;
  }

  /** Whether signing in with a Kestrel account can work: the gateway must belong to an organisation. */
  kestrelSigninAvailable(): boolean {
    return this.context().gatewayId !== null;
  }

  /** Begin a sign-in: remember it, and say where to send the person. */
  startSignin(ip: string, returnOrigin: string): { state: string; url: string } | null {
    const c = this.context();
    if (!c.gatewayId) return null;
    const t = this.now();
    for (const [state, f] of this.flows) if (t - f.at > FLOW_MS) this.flows.delete(state);
    if (this.flows.size >= MAX_FLOWS) this.flows.delete(this.flows.keys().next().value!);
    const state = randomBytes(24).toString('base64url');
    this.flows.set(state, { at: t, ip });
    const url = new URL('/gateway-signin', c.cloudUrl);
    url.searchParams.set('gateway', c.gatewayId);
    url.searchParams.set('state', state);
    url.searchParams.set('return', returnOrigin);
    return { state, url: url.toString() };
  }

  /** The portal sent the person back with a grant. Open a session if, and only if, every check passes. */
  redeem(
    rawGrant: string,
    flowState: string | null,
    ip: string,
  ): { ok: true; session: LocalSession } | { ok: false; reason: RedeemFailure } {
    const fail = (reason: RedeemFailure, extra: Record<string, unknown> = {}) => {
      this.log('warn', 'A sign-in to the local page was refused', { reason, ip, ...extra });
      return { ok: false as const, reason };
    };
    const c = this.context();
    if (!c.gatewayId) return fail('not_enrolled');
    const t = this.now();
    // The flow is spent whatever happens next, so a refused grant cannot be tried again with the same state.
    const flow = flowState ? this.flows.get(flowState) : undefined;
    if (flowState) this.flows.delete(flowState);
    if (!flow || t - flow.at > FLOW_MS) return fail('no_flow');

    let doc: unknown;
    try {
      doc = JSON.parse(Buffer.from(rawGrant, 'base64url').toString('utf8'));
    } catch {
      return fail('invalid');
    }
    const checked = verifyDocument(doc, LOCAL_ACCESS_PURPOSE, c.keys);
    if (!checked.ok) return fail('invalid', { why: checked.reason });
    const parsed = LocalAccessGrant.safeParse(checked.document.payload);
    if (!parsed.success) return fail('invalid', { why: 'shape' });
    const g = parsed.data;
    if (g.gatewayId !== c.gatewayId) return fail('wrong_gateway');
    // The grant must be for the sign-in this browser started.
    if (g.state !== flowState) return fail('invalid', { why: 'state' });
    const nowS = Math.floor(t / 1000);
    if (g.expiresAt < nowS || g.issuedAt > nowS + SKEW_S)
      return fail('expired', { hint: 'Check this gateway’s clock' });
    for (const [id, exp] of this.used) if (exp < nowS) this.used.delete(id);
    if (this.used.has(g.id)) return fail('replayed');
    if (g.epoch < c.policy.epoch) return fail('revoked');
    this.used.set(g.id, g.expiresAt);

    const session = this.open({
      role: g.role,
      who: g.email,
      method: 'kestrel',
      ip,
      epoch: g.epoch,
    });
    this.log('info', 'Someone signed in to the local page with their Kestrel account', {
      who: g.email,
      userId: g.userId,
      role: g.role,
      ip,
    });
    return { ok: true, session };
  }

  /** The admin code was entered correctly (the caller checks the code). */
  openWithCode(ip: string): LocalSession | null {
    if (!this.breakGlassAllowed()) return null;
    return this.open({
      role: 'admin',
      who: 'admin code',
      method: 'code',
      ip,
      epoch: this.context().policy.epoch,
    });
  }

  private open(s: Omit<LocalSession, 'id' | 'createdAt' | 'lastSeen'>): LocalSession {
    const t = this.now();
    for (const [id, x] of this.sessions) if (this.expired(x, t)) this.sessions.delete(id);
    if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    const session: LocalSession = {
      ...s,
      id: randomBytes(24).toString('base64url'),
      createdAt: t,
      lastSeen: t,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  private expired(s: LocalSession, t: number): boolean {
    if (t - s.lastSeen > IDLE_MS || t - s.createdAt > ABSOLUTE_MS) return true;
    const c = this.context();
    // "Sign everyone out" in the portal, and an admin code that has been switched off.
    if (s.method === 'kestrel' && s.epoch < c.policy.epoch) return true;
    if (s.method === 'code' && !this.breakGlassAllowed()) return true;
    return false;
  }

  /** The live session for a cookie, refreshed, or null. */
  sessionFor(id: string | null): LocalSession | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    const t = this.now();
    if (this.expired(s, t)) {
      this.sessions.delete(id);
      return null;
    }
    s.lastSeen = t;
    return s;
  }

  end(id: string | null) {
    if (id) this.sessions.delete(id);
  }

  endAll() {
    this.sessions.clear();
  }

  /** For the status page: who is signed in. */
  active(): { who: string; role: LocalRole; method: string; ip: string; since: number }[] {
    const t = this.now();
    return [...this.sessions.values()]
      .filter((s) => !this.expired(s, t))
      .map((s) => ({ who: s.who, role: s.role, method: s.method, ip: s.ip, since: s.createdAt }));
  }
}
