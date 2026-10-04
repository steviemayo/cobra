import type { PrismaClient } from '@kestrel/db';
import { LEGAL_DOCUMENTS, LEGAL_VERSION } from '../lib/legal';

// Accepting the Terms and Privacy Policy (LR-5). Each acceptance is a row that is never edited or
// removed: who, which document, which version, when, and how (at sign-up, making an organisation, or
// being asked again after the text changed).

export type LegalDb = Pick<PrismaClient, 'legalAcceptance'>;
export type AcceptanceSource = 'signup' | 'org_create' | 'gate';

/**
 * Whether people must accept the current documents before using the portal. Off until the real text
 * is in place (the draft should not be forced on existing customers); set LEGAL_ACCEPTANCE=required to
 * turn it on. Accepting at sign-up and when making an organisation is recorded either way.
 */
export function acceptanceRequired(
  env: string | undefined = process.env.LEGAL_ACCEPTANCE,
): boolean {
  return env === 'required';
}

/** Records acceptance of the current version of every document. Safe to repeat. */
export async function recordAcceptance(
  db: LegalDb,
  args: { userId: string; orgId?: string | null; source: AcceptanceSource; now?: Date },
): Promise<void> {
  for (const document of LEGAL_DOCUMENTS) {
    const version = LEGAL_VERSION[document];
    const have = await db.legalAcceptance.findFirst({
      where: { userId: args.userId, document, version },
    });
    if (have) continue;
    await db.legalAcceptance.create({
      data: {
        userId: args.userId,
        orgId: args.orgId ?? null,
        document,
        version,
        source: args.source,
        acceptedAt: args.now ?? new Date(),
      },
    });
  }
}

/** Whether this person has accepted the current version of every document. */
export async function hasAccepted(db: LegalDb, userId: string): Promise<boolean> {
  const rows = await db.legalAcceptance.findMany({ where: { userId } });
  return LEGAL_DOCUMENTS.every((d) =>
    rows.some((r) => r.document === d && r.version === LEGAL_VERSION[d]),
  );
}

/** Which documents a person still has to accept, for the page that asks. */
export async function pendingDocuments(db: LegalDb, userId: string) {
  const rows = await db.legalAcceptance.findMany({ where: { userId } });
  return LEGAL_DOCUMENTS.filter(
    (d) => !rows.some((r) => r.document === d && r.version === LEGAL_VERSION[d]),
  );
}

/**
 * Called when a signed-in person opens the portal. Turns the sign-up checkbox (kept on the account) into
 * an acceptance row the first time, and, when acceptance is required, says whether they must accept
 * the current documents first.
 */
export async function legalGate(
  db: LegalDb,
  user: { id: string; user_metadata?: Record<string, unknown> | null },
  required = acceptanceRequired(),
): Promise<'ok' | 'accept'> {
  const m = user.user_metadata ?? {};
  const atSignup =
    m.accepted_terms === LEGAL_VERSION.terms && m.accepted_privacy === LEGAL_VERSION.privacy;
  if (!atSignup && !required) return 'ok';
  if (await hasAccepted(db, user.id)) return 'ok';
  if (atSignup) {
    const when = typeof m.accepted_at === 'string' ? new Date(m.accepted_at) : null;
    await recordAcceptance(db, {
      userId: user.id,
      source: 'signup',
      now: when && !Number.isNaN(when.getTime()) ? when : undefined,
    });
    return 'ok';
  }
  return 'accept';
}
