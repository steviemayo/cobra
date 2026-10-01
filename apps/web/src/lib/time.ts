// Times as people read them: in the site's own time zone, with the zone named ("1 Oct 2026, 12:53 pm
// AEST"), so a time is never a bare UTC string and never ambiguous. Shared by the server (text that
// is written into incidents and messages) and the browser.

/** The zone used when a site has none that this runtime knows. */
export const DEFAULT_ZONE = 'Australia/Sydney';

/** True when the zone name is one this runtime knows. */
export function knownZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export interface ZoneFormat {
  /** Leave the date out ("12:53 pm AEST"). */
  timeOnly?: boolean;
  /** Leave the time out ("1 Oct 2026"). */
  dateOnly?: boolean;
  /** Leave the year out when it is this year ("1 Oct, 12:53 pm AEST"). */
  shortYear?: boolean;
}

/**
 * "1 Oct 2026, 12:53 pm AEST" for an instant in a zone. With no zone (or one that is unknown) it uses
 * the viewer's own zone in a browser, and Sydney on the server, and the zone is always named.
 */
export function formatInZone(
  instant: Date | string | number,
  timeZone?: string | null,
  f: ZoneFormat = {},
  now = Date.now(),
): string {
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return '';
  // No known zone: the viewer's own in a browser; on the server there is no viewer, so Sydney.
  const zone = knownZone(timeZone)
    ? timeZone
    : typeof window === 'undefined'
      ? DEFAULT_ZONE
      : undefined;
  const year = d.getUTCFullYear() === new Date(now).getUTCFullYear();
  const parts: Intl.DateTimeFormatOptions = {
    ...(zone ? { timeZone: zone } : {}),
    ...(f.timeOnly
      ? {}
      : { day: 'numeric', month: 'short', ...(f.shortYear && year ? {} : { year: 'numeric' }) }),
    ...(f.dateOnly ? {} : { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }),
  };
  return new Intl.DateTimeFormat('en-AU', parts).format(d).replace(/\b(am|pm)\b/i, (m) => m.toLowerCase());
}
