export const LAST_ORG_COOKIE = 'kestrel_org';

// Remember the org the user last opened so `/` can send them straight back to it.
export function rememberOrg(orgId: string) {
  document.cookie = `${LAST_ORG_COOKIE}=${orgId}; path=/; max-age=31536000; samesite=lax`;
}
