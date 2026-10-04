import { describe, expect, it } from 'vitest';
import { LEGAL_DOCUMENTS, LEGAL_VERSION, signupAcceptanceMetadata } from '../lib/legal';
import {
  acceptanceRequired,
  hasAccepted,
  legalGate,
  pendingDocuments,
  recordAcceptance,
  type LegalDb,
} from './legal';
import { table } from './test-db';

const USER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-04T10:00:00Z');

function world(rows: Record<string, unknown>[] = []) {
  const legalAcceptance = table(rows);
  return { db: { legalAcceptance } as unknown as LegalDb, rows: legalAcceptance.rows };
}

describe('acceptanceRequired', () => {
  it('is off unless explicitly set to required', () => {
    expect(acceptanceRequired(undefined)).toBe(false);
    expect(acceptanceRequired('')).toBe(false);
    expect(acceptanceRequired('true')).toBe(false);
    expect(acceptanceRequired('required')).toBe(true);
  });
});

describe('recording acceptance', () => {
  it('writes a row for each document at the current version, with who, how and when', async () => {
    const w = world();
    await recordAcceptance(w.db, { userId: USER, orgId: ORG, source: 'org_create', now: NOW });
    expect(w.rows).toHaveLength(LEGAL_DOCUMENTS.length);
    for (const d of LEGAL_DOCUMENTS)
      expect(w.rows).toContainEqual(
        expect.objectContaining({
          userId: USER,
          orgId: ORG,
          document: d,
          version: LEGAL_VERSION[d],
          source: 'org_create',
          acceptedAt: NOW,
        }),
      );
  });

  it('does not repeat itself, and keeps the first record', async () => {
    const w = world();
    await recordAcceptance(w.db, { userId: USER, source: 'signup', now: NOW });
    await recordAcceptance(w.db, { userId: USER, orgId: ORG, source: 'org_create' });
    expect(w.rows).toHaveLength(LEGAL_DOCUMENTS.length);
    expect(w.rows.every((r) => r.source === 'signup')).toBe(true);
  });
});

describe('who has accepted', () => {
  it('needs every document at the current version', async () => {
    const w = world();
    expect(await hasAccepted(w.db, USER)).toBe(false);
    expect(await pendingDocuments(w.db, USER)).toEqual([...LEGAL_DOCUMENTS]);
    await recordAcceptance(w.db, { userId: USER, source: 'gate' });
    expect(await hasAccepted(w.db, USER)).toBe(true);
    expect(await pendingDocuments(w.db, USER)).toEqual([]);
  });

  it('does not count an older version, or someone else', async () => {
    const old = world(
      LEGAL_DOCUMENTS.map((document) => ({
        userId: USER,
        document,
        version: 'an-older-version',
        source: 'signup',
      })),
    );
    expect(await hasAccepted(old.db, USER)).toBe(false);
    const other = world();
    await recordAcceptance(other.db, {
      userId: '99999999-9999-4999-8999-999999999999',
      source: 'gate',
    });
    expect(await hasAccepted(other.db, USER)).toBe(false);
  });
});

describe('the gate', () => {
  it('lets everyone in when acceptance is not required and they have no sign-up record', async () => {
    const w = world();
    expect(await legalGate(w.db, { id: USER, user_metadata: {} }, false)).toBe('ok');
    expect(w.rows).toHaveLength(0);
  });

  it('turns the sign-up checkbox into a record, dated when it was ticked', async () => {
    const w = world();
    const at = new Date('2026-10-01T01:02:03Z');
    const meta = signupAcceptanceMetadata(at);
    expect(await legalGate(w.db, { id: USER, user_metadata: meta }, false)).toBe('ok');
    expect(w.rows).toHaveLength(LEGAL_DOCUMENTS.length);
    expect(
      w.rows.every(
        (r) => r.source === 'signup' && (r.acceptedAt as Date).getTime() === at.getTime(),
      ),
    ).toBe(true);
    // The second visit finds it already recorded.
    await legalGate(w.db, { id: USER, user_metadata: meta }, false);
    expect(w.rows).toHaveLength(LEGAL_DOCUMENTS.length);
  });

  it('asks for acceptance when required and there is none', async () => {
    const w = world();
    expect(await legalGate(w.db, { id: USER, user_metadata: {} }, true)).toBe('accept');
  });

  it('asks again when the sign-up checkbox was for an older version', async () => {
    const w = world();
    const stale = {
      accepted_terms: 'old',
      accepted_privacy: 'old',
      accepted_at: NOW.toISOString(),
    };
    expect(await legalGate(w.db, { id: USER, user_metadata: stale }, true)).toBe('accept');
    expect(await legalGate(w.db, { id: USER, user_metadata: stale }, false)).toBe('ok');
    expect(w.rows).toHaveLength(0);
  });

  it('lets someone in who has accepted the current version', async () => {
    const w = world();
    await recordAcceptance(w.db, { userId: USER, source: 'gate' });
    expect(await legalGate(w.db, { id: USER, user_metadata: null }, true)).toBe('ok');
  });

  it('ignores a malformed date on the sign-up record', async () => {
    const w = world();
    const meta = { ...signupAcceptanceMetadata(NOW), accepted_at: 'not a date' };
    expect(await legalGate(w.db, { id: USER, user_metadata: meta }, false)).toBe('ok');
    expect(w.rows).toHaveLength(LEGAL_DOCUMENTS.length);
    expect(w.rows.every((r) => r.acceptedAt instanceof Date)).toBe(true);
  });
});
