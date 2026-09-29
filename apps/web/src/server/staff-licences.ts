import type { PrismaClient } from '@kestrel/db';
import {
  entitlementsFor,
  entitlementsWithOverride,
  overrideActive,
  type Entitlements,
  type StoredPlan,
} from '@kestrel/model';
import { writeAudit } from './audit';
import { activeOverride, ensureBilling } from './billing';
import { recordStaffAudit, type StaffDb } from './staff';

// Licences and trials as staff manage them: adjust what an organisation may do on top of what it
// pays for, always with a reason. Stripe stays the source of truth for paid plans; these are for
// extensions, pilots and comps. Every change is written to the staff audit trail (with the
// reason) and to the organisation's own activity log (without it).
export type LicenceDb = StaffDb & Pick<PrismaClient, 'orgLicenseOverride' | 'orgNote'>;

export class LicenceError extends Error {}

export interface OverrideInput {
  plan?: 'trial' | 'basic' | 'pro' | null;
  trialEndsAt?: Date | null;
  maxRooms?: number | null;
  unlimitedRooms?: boolean;
  monitoring?: boolean | null;
  expiresAt?: Date | null;
  /** Why. Required, and never shown to the customer. */
  reason: string;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** What the customer is told, in words. Never includes the reason. */
export function describeOverride(o: OverrideInput): string {
  const bits: string[] = [];
  if (o.plan === 'trial') bits.push(`trial${o.trialEndsAt ? ` until ${day(o.trialEndsAt)}` : ''}`);
  else if (o.plan) bits.push(`${o.plan} plan`);
  else if (o.trialEndsAt) bits.push(`trial extended to ${day(o.trialEndsAt)}`);
  if (o.unlimitedRooms) bits.push('no room limit');
  else if (o.maxRooms != null) bits.push(`up to ${o.maxRooms} rooms`);
  if (o.monitoring === true) bits.push('monitoring on');
  if (o.monitoring === false) bits.push('monitoring off');
  if (o.expiresAt) bits.push(`until ${day(o.expiresAt)}`);
  return bits.join(', ');
}

function validate(o: OverrideInput, now: Date): void {
  const reason = o.reason?.trim() ?? '';
  if (reason.length < 5) throw new LicenceError('Give a reason of at least 5 characters.');
  if (reason.length > 500) throw new LicenceError('Keep the reason under 500 characters.');
  const sets =
    !!o.plan ||
    !!o.trialEndsAt ||
    (o.maxRooms !== null && o.maxRooms !== undefined) ||
    !!o.unlimitedRooms ||
    (o.monitoring !== null && o.monitoring !== undefined);
  if (!sets) throw new LicenceError('Choose something to change.');
  if (o.plan && !['trial', 'basic', 'pro'].includes(o.plan))
    throw new LicenceError('Choose trial, basic or pro.');
  if (o.maxRooms != null && o.unlimitedRooms)
    throw new LicenceError('Choose a room limit or no limit, not both.');
  if (o.maxRooms != null && (!Number.isInteger(o.maxRooms) || o.maxRooms < 1 || o.maxRooms > 1000))
    throw new LicenceError('The room limit must be a whole number from 1 to 1000.');
  if (o.trialEndsAt && o.trialEndsAt.getTime() <= now.getTime())
    throw new LicenceError('Choose a trial end date in the future.');
  if (o.plan && o.plan !== 'trial' && o.trialEndsAt)
    throw new LicenceError('A trial end date only applies to a trial.');
  if (o.expiresAt && o.expiresAt.getTime() <= now.getTime())
    throw new LicenceError('Choose an end date for the adjustment in the future.');
}

/** Sets a new adjustment for an organisation. It replaces any earlier one. */
export async function setOverride(
  db: LicenceDb,
  args: { orgId: string; staffUserId: string; input: OverrideInput; now?: Date },
): Promise<{ id: string }> {
  const now = args.now ?? new Date();
  validate(args.input, now);
  if (!(await db.org.findFirst({ where: { id: args.orgId } })))
    throw new LicenceError('Organisation not found.');

  // One adjustment at a time: the new one replaces the old.
  const current = await db.orgLicenseOverride.findMany({
    where: { orgId: args.orgId, revokedAt: null },
  });
  for (const c of current)
    await db.orgLicenseOverride.update({
      where: { id: c.id },
      data: { revokedAt: now, revokedBy: args.staffUserId },
    });

  const i = args.input;
  const row = await db.orgLicenseOverride.create({
    data: {
      orgId: args.orgId,
      plan: i.plan ?? null,
      trialEndsAt: i.trialEndsAt ?? null,
      maxRooms: i.maxRooms ?? null,
      unlimitedRooms: !!i.unlimitedRooms,
      monitoring: i.monitoring ?? null,
      expiresAt: i.expiresAt ?? null,
      reason: i.reason.trim(),
      setBy: args.staffUserId,
    },
  });
  await writeAudit(
    {
      orgId: args.orgId,
      actorId: null,
      action: 'license.adjust',
      target: row.id,
      meta: { staff: true, summary: describeOverride(i) },
    },
    db,
  );
  await recordStaffAudit(db, {
    staffUserId: args.staffUserId,
    action: 'license.set',
    orgId: args.orgId,
    target: row.id,
    meta: { summary: describeOverride(i), reason: i.reason.trim() },
  });
  return { id: row.id };
}

export async function revokeOverride(
  db: LicenceDb,
  args: { orgId: string; overrideId: string; staffUserId: string; now?: Date },
): Promise<void> {
  const now = args.now ?? new Date();
  const row = await db.orgLicenseOverride.findFirst({
    where: { id: args.overrideId, orgId: args.orgId },
  });
  if (!row) throw new LicenceError('Adjustment not found.');
  if (row.revokedAt) throw new LicenceError('That adjustment was already removed.');
  await db.orgLicenseOverride.update({
    where: { id: row.id },
    data: { revokedAt: now, revokedBy: args.staffUserId },
  });
  await writeAudit(
    { orgId: args.orgId, actorId: null, action: 'license.revoke', target: row.id, meta: { staff: true } },
    db,
  );
  await recordStaffAudit(db, {
    staffUserId: args.staffUserId,
    action: 'license.revoke',
    orgId: args.orgId,
    target: row.id,
  });
}

export interface OverrideView {
  id: string;
  plan: string | null;
  trialEndsAt: Date | null;
  maxRooms: number | null;
  unlimitedRooms: boolean;
  monitoring: boolean | null;
  expiresAt: Date | null;
  reason: string;
  setBy: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  /** Counts right now: not revoked, not expired. */
  active: boolean;
}

export interface LicenceState {
  billing: { plan: string; status: string; trialEndsAt: Date | null; managedByStripe: boolean };
  /** What the organisation pays for, ignoring any adjustment. */
  base: Entitlements;
  /** What it may do right now. */
  effective: Entitlements;
  overrides: OverrideView[];
}

export async function licenceState(
  db: LicenceDb,
  orgId: string,
  now = new Date(),
): Promise<LicenceState> {
  const billing = await ensureBilling(db, orgId, now);
  const state = {
    plan: billing.plan as StoredPlan,
    status: billing.status,
    trialEndsAt: billing.trialEndsAt,
  };
  const active = await activeOverride(db, orgId, now);
  const [rows, staff] = await Promise.all([
    db.orgLicenseOverride.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 20 }),
    db.staffUser.findMany({}),
  ]);
  const email = new Map(staff.map((s) => [s.userId, s.email]));
  return {
    billing: {
      plan: billing.plan,
      status: billing.status,
      trialEndsAt: billing.trialEndsAt,
      managedByStripe: !!billing.stripeCustomerId,
    },
    base: entitlementsFor(state, now),
    effective: entitlementsWithOverride(state, active, now),
    overrides: rows.map((r) => ({
      id: r.id,
      plan: r.plan,
      trialEndsAt: r.trialEndsAt,
      maxRooms: r.maxRooms,
      unlimitedRooms: r.unlimitedRooms,
      monitoring: r.monitoring,
      expiresAt: r.expiresAt,
      reason: r.reason,
      setBy: email.get(r.setBy) ?? null,
      createdAt: r.createdAt,
      revokedAt: r.revokedAt,
      active: overrideActive(r, now),
    })),
  };
}

export interface NoteView {
  id: string;
  body: string;
  author: string | null;
  createdAt: Date;
}

export async function addNote(
  db: LicenceDb,
  args: { orgId: string; authorId: string; body: string },
): Promise<void> {
  const body = args.body.trim();
  if (!body) throw new LicenceError('Write something first.');
  if (body.length > 2000) throw new LicenceError('Keep a note under 2000 characters.');
  if (!(await db.org.findFirst({ where: { id: args.orgId } })))
    throw new LicenceError('Organisation not found.');
  const note = await db.orgNote.create({
    data: { orgId: args.orgId, body, authorId: args.authorId },
  });
  await recordStaffAudit(db, {
    staffUserId: args.authorId,
    action: 'note.add',
    orgId: args.orgId,
    target: note.id,
  });
}

export async function listNotes(db: LicenceDb, orgId: string): Promise<NoteView[]> {
  const [notes, staff] = await Promise.all([
    db.orgNote.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    db.staffUser.findMany({}),
  ]);
  const email = new Map(staff.map((s) => [s.userId, s.email]));
  return notes.map((n) => ({
    id: n.id,
    body: n.body,
    author: email.get(n.authorId) ?? null,
    createdAt: n.createdAt,
  }));
}
