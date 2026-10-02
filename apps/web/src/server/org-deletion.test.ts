import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DELETE_REQUEST_TITLE,
  GRACE_DAYS,
  KEPT,
  PURGED_BY_ORG_ID,
  purgeDueOrgs,
  requestDeletion,
  restoreOrg,
  scheduleDeletion,
  type DeletionEffects,
  type OrgDeletionDb,
} from './org-deletion';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '11111111-1111-4111-8111-111111111112';
const STAFF = '55555555-5555-4555-8555-555555555551';
const NOW = new Date('2026-10-01T00:00:00Z');
const DAY = 86_400_000;

function world() {
  return {
    org: table([
      { id: ORG, name: 'Acme AV', deletedAt: null },
      { id: OTHER, name: 'Other Co', deletedAt: null },
    ]),
    gateway: table([
      { id: 'g1', orgId: ORG, credentialHash: 'abc', enrollTokenHash: 'def' },
      { id: 'g2', orgId: ORG, credentialHash: 'ghi', enrollTokenHash: null },
      { id: 'g3', orgId: OTHER, credentialHash: 'zzz', enrollTokenHash: null },
    ]),
    apiKey: table([
      { id: 'k1', orgId: ORG, revokedAt: null },
      { id: 'k2', orgId: OTHER, revokedAt: null },
    ]),
    invite: table([
      { id: 'i1', orgId: ORG },
      { id: 'i2', orgId: OTHER },
    ]),
    alertChannel: table([
      { id: 'a1', orgId: ORG, enabled: true },
      { id: 'a2', orgId: OTHER, enabled: true },
    ]),
    orgBilling: table([
      {
        id: 'b1',
        orgId: ORG,
        status: 'active',
        stripeSubscriptionId: 'sub_1',
        cancelAtPeriodEnd: false,
      },
    ]),
    callout: table([]),
    ticket: table([]),
    staffAudit: table([]),
  };
}
type W = ReturnType<typeof world>;
const asDb = (w: W) => w as unknown as OrgDeletionDb;

const effects = (over: Partial<DeletionEffects> = {}) => {
  const cancelled: string[] = [];
  const e: DeletionEffects = {
    cancelSubscription: async (id) => void cancelled.push(id),
    ...over,
  };
  return { e, cancelled };
};

const input = (over: Partial<Parameters<typeof scheduleDeletion>[2]> = {}) => ({
  orgId: ORG,
  staffUserId: STAFF,
  confirmName: 'Acme AV',
  reason: 'Customer left',
  ...over,
});

describe('scheduling a deletion', () => {
  it('switches the organisation off now and sets the day it goes for good', async () => {
    const w = world();
    const { e, cancelled } = effects();
    const out = await scheduleDeletion(asDb(w), e, input(), NOW);
    expect(out).toMatchObject({ gatewaysReleased: 2, subscriptionCancelled: true, warnings: [] });
    expect(out.deleteAfter.getTime()).toBe(NOW.getTime() + GRACE_DAYS * DAY);
    expect(w.org.rows[0]).toMatchObject({
      deletedAt: NOW,
      deleteAfter: out.deleteAfter,
      deletedBy: STAFF,
      deleteReason: 'Customer left',
    });
    // Its gateways forget it (no credential, no token), its keys stop working, its alerts stop.
    expect(
      w.gateway.rows
        .filter((g) => g.orgId === ORG)
        .every((g) => g.credentialHash === null && g.enrollTokenHash === null),
    ).toBe(true);
    expect(w.apiKey.rows[0]!.revokedAt).toEqual(NOW);
    expect(w.invite.rows.map((i) => i.id)).toEqual(['i2']);
    expect(w.alertChannel.rows[0]!.enabled).toBe(false);
    expect(cancelled).toEqual(['sub_1']);
    expect(w.orgBilling.rows[0]).toMatchObject({ status: 'canceled', cancelAtPeriodEnd: true });
  });

  it('touches nothing of another organisation', async () => {
    const w = world();
    await scheduleDeletion(asDb(w), effects().e, input(), NOW);
    expect(w.org.rows[1]).toMatchObject({ deletedAt: null });
    expect(w.gateway.rows[2]!.credentialHash).toBe('zzz');
    expect(w.apiKey.rows[1]!.revokedAt).toBeNull();
    expect(w.alertChannel.rows[1]!.enabled).toBe(true);
  });

  it('wants the name typed exactly and a reason, and refuses twice', async () => {
    const w = world();
    const { e, cancelled } = effects();
    await expect(
      scheduleDeletion(asDb(w), e, input({ confirmName: 'acme av' }), NOW),
    ).rejects.toThrow(/name exactly/);
    await expect(scheduleDeletion(asDb(w), e, input({ reason: '  ' }), NOW)).rejects.toThrow(
      /Say why/,
    );
    expect(cancelled).toEqual([]);
    expect(w.org.rows[0]!.deletedAt).toBeNull();
    await scheduleDeletion(asDb(w), e, input(), NOW);
    await expect(scheduleDeletion(asDb(w), e, input(), NOW)).rejects.toThrow(/already scheduled/);
    await expect(
      scheduleDeletion(asDb(w), e, input({ orgId: '11111111-1111-4111-8111-1111111111ff' }), NOW),
    ).rejects.toThrow(/No such organisation/);
  });

  it('refuses while a paid callout is not finished, so nothing paid for is lost', async () => {
    const w = world();
    w.callout.rows.push({ id: 'c1', orgId: ORG, status: 'booked' });
    await expect(scheduleDeletion(asDb(w), effects().e, input(), NOW)).rejects.toThrow(
      /paid callout/,
    );
    expect(w.org.rows[0]!.deletedAt).toBeNull();
    w.callout.rows[0]!.status = 'completed';
    await expect(scheduleDeletion(asDb(w), effects().e, input(), NOW)).resolves.toBeDefined();
  });

  it('carries on and says so when Stripe will not cancel', async () => {
    const w = world();
    const { e } = effects({
      cancelSubscription: async () => {
        throw new Error('Stripe is down');
      },
    });
    const out = await scheduleDeletion(asDb(w), e, input(), NOW);
    expect(out.subscriptionCancelled).toBe(false);
    expect(out.warnings[0]).toMatch(/Stripe is down.*Cancel it in Stripe/);
    // It is still switched off.
    expect(w.org.rows[0]!.deletedAt).toEqual(NOW);
    expect(w.orgBilling.rows[0]!.status).toBe('active');
  });
});

describe('restoring', () => {
  it('brings it back before its day, and not after', async () => {
    const w = world();
    await scheduleDeletion(asDb(w), effects().e, input(), NOW);
    await restoreOrg(asDb(w), { orgId: ORG }, new Date(NOW.getTime() + 5 * DAY));
    expect(w.org.rows[0]).toMatchObject({
      deletedAt: null,
      deleteAfter: null,
      deletedBy: null,
      deleteReason: null,
    });
    // What was switched off stays off.
    expect(w.alertChannel.rows[0]!.enabled).toBe(false);
    await expect(restoreOrg(asDb(w), { orgId: ORG })).rejects.toThrow(/not scheduled/);

    await scheduleDeletion(asDb(w), effects().e, input(), NOW);
    await expect(
      restoreOrg(asDb(w), { orgId: ORG }, new Date(NOW.getTime() + 31 * DAY)),
    ).rejects.toThrow(/past its deletion date/);
  });
});

function purgeWorld(deleteAfter: Date | null) {
  const org = table([
    {
      id: ORG,
      name: 'Acme AV',
      deletedAt: deleteAfter ? NOW : null,
      deleteAfter,
      deletedBy: STAFF,
      deleteReason: 'Left',
    },
    { id: OTHER, name: 'Other Co', deletedAt: null, deleteAfter: null },
  ]);
  const staffAudit = table([]);
  // ONLY: in this organisation alone. BOTH: also in Other Co. STAFFER: in this organisation and is staff.
  const member = table([
    { id: 'm1', orgId: ORG, userId: 'u-only' },
    { id: 'm2', orgId: ORG, userId: 'u-both' },
    { id: 'm3', orgId: OTHER, userId: 'u-both' },
    { id: 'm4', orgId: ORG, userId: 'u-staff' },
  ]);
  const staffUser = table([{ id: 's1', userId: 'u-staff' }]);
  const joinRequest = table([
    { id: 'j1', orgId: OTHER, userId: 'u-only' },
    { id: 'j2', orgId: OTHER, userId: 'u-both' },
  ]);
  const tables = Object.fromEntries(
    PURGED_BY_ORG_ID.map((t) => [
      t,
      table([
        { id: `${t}-mine`, orgId: ORG },
        { id: `${t}-theirs`, orgId: OTHER },
      ]),
    ]),
  );
  return {
    db: { org, staffAudit, member, staffUser, joinRequest, ...tables } as never,
    org,
    staffAudit,
    member,
    joinRequest,
    tables,
  };
}

describe('the clean-up', () => {
  it('deletes an organisation whose day has come, and everything keyed to it that would not cascade', async () => {
    const w = purgeWorld(new Date(NOW.getTime() + 30 * DAY));
    const out = await purgeDueOrgs(w.db, new Date(NOW.getTime() + 31 * DAY));
    expect(out).toEqual({ purged: [ORG], failed: [], accountsDeleted: [], accountsFailed: [] });
    expect(w.org.rows.map((o) => o.id)).toEqual([OTHER]);
    for (const t of PURGED_BY_ORG_ID)
      expect(w.tables[t]!.rows.map((r) => r.id)).toEqual([`${t}-theirs`]);
    // The staff audit trail says what was deleted, with its name.
    expect(w.staffAudit.rows[0]).toMatchObject({
      action: 'org.delete.purge',
      staffUserId: STAFF,
      meta: { name: 'Acme AV', reason: 'Left' },
    });
  });

  it('deletes the sign-in account of someone who was only in it, and nobody else', async () => {
    const w = purgeWorld(new Date(NOW.getTime() + 30 * DAY));
    const deleted: string[] = [];
    const out = await purgeDueOrgs(w.db, new Date(NOW.getTime() + 31 * DAY), async (id) => {
      deleted.push(id);
    });
    // u-both is also in Other Co, u-staff is Kestrel staff: both keep their accounts.
    expect(deleted).toEqual(['u-only']);
    expect(out.accountsDeleted).toEqual(['u-only']);
    expect(w.joinRequest.rows.map((r) => r.id)).toEqual(['j2']);
    expect(w.member.rows.map((m) => m.id)).toEqual(['m3']);
    expect(w.staffAudit.rows.map((a) => a.action)).toEqual([
      'org.delete.purge',
      'org.delete.accounts',
    ]);
  });

  it('reports an account it could not delete, since the organisation is already gone', async () => {
    const w = purgeWorld(new Date(NOW.getTime() + 30 * DAY));
    const out = await purgeDueOrgs(w.db, new Date(NOW.getTime() + 31 * DAY), async () => {
      throw new Error('auth down');
    });
    expect(out.purged).toEqual([ORG]);
    expect(out.accountsFailed).toEqual([{ userId: 'u-only', error: 'auth down' }]);
  });

  it('leaves alone one that is not due yet, and one not scheduled at all', async () => {
    const w = purgeWorld(new Date(NOW.getTime() + 30 * DAY));
    expect((await purgeDueOrgs(w.db, new Date(NOW.getTime() + 10 * DAY))).purged).toEqual([]);
    expect(w.org.rows).toHaveLength(2);
    const unscheduled = purgeWorld(null);
    expect(
      (await purgeDueOrgs(unscheduled.db, new Date(NOW.getTime() + 400 * DAY))).purged,
    ).toEqual([]);
  });

  it('carries on past one that fails, and tries it again next time', async () => {
    const w = purgeWorld(new Date(NOW.getTime() + 30 * DAY));
    (w.tables.ticketRule as { deleteMany: unknown }).deleteMany = async () => {
      throw new Error('locked');
    };
    const out = await purgeDueOrgs(w.db, new Date(NOW.getTime() + 31 * DAY));
    expect(out.purged).toEqual([]);
    expect(out.failed).toEqual([{ orgId: ORG, error: 'locked' }]);
    expect(w.org.rows).toHaveLength(2);
  });
});

describe('asking for a deletion', () => {
  it('opens a high priority ticket for Kestrel and deletes nothing, once', async () => {
    const ticket = table([]);
    const db = { ticket } as unknown as Pick<OrgDeletionDb, 'ticket'>;
    const first = await requestDeletion(
      db,
      { orgId: ORG, userId: STAFF, email: 'pat@example.com', reason: 'Closing down' },
      NOW,
    );
    expect(first.alreadyRequested).toBe(false);
    expect(ticket.rows[0]).toMatchObject({
      orgId: ORG,
      title: DELETE_REQUEST_TITLE,
      routedTo: 'kestrel',
      priority: 'high',
    });
    expect(String(ticket.rows[0]!.body)).toContain('Closing down');
    expect(String(ticket.rows[0]!.body)).toContain('Nothing has been deleted');
    const again = await requestDeletion(
      db,
      { orgId: ORG, userId: STAFF, email: null, reason: '' },
      NOW,
    );
    expect(again).toEqual({ ticketId: first.ticketId, alreadyRequested: true });
    expect(ticket.rows).toHaveLength(1);
  });
});

describe('a table added later', () => {
  it('is not forgotten: every table keyed by orgId with no relation to the organisation is purged or knowingly kept', () => {
    const schema = readFileSync(
      join(__dirname, '../../../../packages/db/prisma/schema.prisma'),
      'utf8',
    );
    const uncovered: string[] = [];
    for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
      const [, name, body] = m;
      const keyed = /^\s+orgId\s/m.test(body!);
      const related = /@relation\(fields: \[orgId\]/.test(body!);
      if (!keyed || related) continue;
      const delegate = name!.charAt(0).toLowerCase() + name!.slice(1);
      if (
        !(PURGED_BY_ORG_ID as readonly string[]).includes(delegate) &&
        !(KEPT as readonly string[]).includes(delegate)
      )
        uncovered.push(name!);
    }
    expect(uncovered).toEqual([]);
  });

  it('every listed table is a real model', () => {
    const schema = readFileSync(
      join(__dirname, '../../../../packages/db/prisma/schema.prisma'),
      'utf8',
    );
    for (const t of [...PURGED_BY_ORG_ID, ...KEPT])
      expect(schema).toContain(`model ${t.charAt(0).toUpperCase()}${t.slice(1)} {`);
  });
});
