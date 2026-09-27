import { db } from '@kestrel/db';
import { pollCalendars } from '@/server/calendar';
import { refreshSchedules } from '@/server/room-schedule';
import { cronAuthorised } from '@/server/cron-auth';

export const dynamic = 'force-dynamic';

// About every minute: looks at rooms' calendars and starts the rooms whose meetings have begun, then
// refreshes the bookings the panels show.
export async function GET(req: Request) {
  if (!cronAuthorised(req)) return Response.json({ error: 'Unauthorised' }, { status: 401 });
  const triggers = await pollCalendars(db);
  const schedules = await refreshSchedules(db).catch((err: unknown) => ({
    checked: 0,
    fired: 0,
    errors: [err instanceof Error ? err.message : String(err)],
  }));
  return Response.json({ ...triggers, schedules });
}
