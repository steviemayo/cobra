// The legal documents people accept (LR-5). The text on /terms and /privacy is a DRAFT outline until
// a lawyer has reviewed it (LR-1 to LR-4). Change a version when the meaning of a document changes, and
// everyone is asked to accept it again (when LEGAL_ACCEPTANCE=required, see server/legal.ts).

export const LEGAL_DOCUMENTS = ['terms', 'privacy'] as const;
export type LegalDocument = (typeof LEGAL_DOCUMENTS)[number];

export const LEGAL_VERSION: Record<LegalDocument, string> = {
  terms: '2026-10-04-draft',
  privacy: '2026-10-04-draft',
};

export const LEGAL_TITLE: Record<LegalDocument, string> = {
  terms: 'Terms of Service',
  privacy: 'Privacy Policy',
};

export const LEGAL_PATH: Record<LegalDocument, string> = {
  terms: '/terms',
  privacy: '/privacy',
};

/** Where each part of Kestrel's data goes, for the Privacy Policy's subprocessor list (LR-4). */
export const SUBPROCESSORS: { name: string; does: string; where: string }[] = [
  { name: 'Supabase', does: 'Database and sign-in', where: 'Sydney, Australia' },
  { name: 'Vercel', does: 'Hosts the web portal and its API', where: 'To be confirmed' },
  {
    name: 'Stripe',
    does: 'Card payments, invoices and subscriptions',
    where: 'United States and others',
  },
  {
    name: 'GitHub',
    does: 'Gateway software releases and the container registry',
    where: 'United States',
  },
  {
    name: 'Email provider',
    does: 'Sends account, alert and ticket emails',
    where: 'To be confirmed',
  },
];

/** What the sign-up form stores on the account, since there is no session yet to write a row with. */
export function signupAcceptanceMetadata(now = new Date()) {
  return {
    accepted_terms: LEGAL_VERSION.terms,
    accepted_privacy: LEGAL_VERSION.privacy,
    accepted_at: now.toISOString(),
  };
}
