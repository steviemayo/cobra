// Helpers for telling whether two organisations, or two sign-ups, are really the same company.
// Pure, so the portal, the API and the tests all agree. Names are labels, not identities: these
// only ever produce a warning or a "one trial each" decision, never a hard block on a name.

/** Words that say what kind of company something is, not which one, so they are ignored in a match. */
const NAME_NOISE = new Set([
  'pty',
  'ltd',
  'limited',
  'llc',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'gmbh',
  'plc',
  'the',
  'and',
]);

/** A name reduced to what matters for spotting a duplicate: lower case, no punctuation or company suffixes. */
export function normaliseOrgName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !NAME_NOISE.has(w))
    .join(' ');
}

/** The one word to search on when looking for similar names: the first that is not noise. */
export function nameSearchTerm(name: string): string | null {
  return normaliseOrgName(name).split(' ')[0] || null;
}

/** Whether two organisation names are close enough to warn about (same after normalising). */
export function sameOrgName(a: string, b: string): boolean {
  const x = normaliseOrgName(a);
  return x.length > 0 && x === normaliseOrgName(b);
}

/**
 * Free mail providers. Sharing one of these says nothing about working for the same company, so
 * they are never used to match colleagues or to share a trial between accounts.
 */
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'outlook.com.au',
  'hotmail.com',
  'hotmail.com.au',
  'hotmail.co.uk',
  'live.com',
  'live.com.au',
  'msn.com',
  'yahoo.com',
  'yahoo.com.au',
  'yahoo.co.uk',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.net',
  'zoho.com',
  'fastmail.com',
  'hey.com',
  'bigpond.com',
  'bigpond.net.au',
  'optusnet.com.au',
  'tpg.com.au',
  'iinet.net.au',
  'internode.on.net',
  'westnet.com.au',
]);

const clean = (email: string) => email.trim().toLowerCase();

/** The part after the @, lower case. Null when it is not an address. */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = clean(email).lastIndexOf('@');
  const domain = at > 0 ? clean(email).slice(at + 1) : '';
  return domain.includes('.') ? domain : null;
}

export const isPublicEmailDomain = (domain: string) => PUBLIC_EMAIL_DOMAINS.has(domain);

/** The company domain of an address, or null for a free mail address or a malformed one. */
export function companyDomain(email: string | null | undefined): string | null {
  const d = emailDomain(email);
  return d && !isPublicEmailDomain(d) ? d : null;
}

/**
 * An address with the tricks that make one mailbox look like many removed: lower case, no
 * "+label", and no dots in a Gmail name.
 */
export function emailKey(email: string): string | null {
  const domain = emailDomain(email);
  if (!domain) return null;
  let local = clean(email).slice(0, clean(email).lastIndexOf('@'));
  local = local.split('+')[0]!;
  const d = domain === 'googlemail.com' ? 'gmail.com' : domain;
  if (d === 'gmail.com') local = local.replace(/\./g, '');
  return local ? `${local}@${d}` : null;
}

/** What a sign-up is counted against for "one trial each": the person, their mailbox and their company. */
export function trialKeys(userId: string, email: string) {
  return { userId, emailKey: emailKey(email), domainKey: companyDomain(email) };
}

/** Most join requests a person may send in a day, and how long a declined request blocks another to the same organisation. */
export const JOIN_REQUESTS_PER_DAY = 5;
export const JOIN_DECLINE_COOLDOWN_DAYS = 30;
