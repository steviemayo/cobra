import { db } from '@kestrel/db';
import { pollCalendars } from '@/server/calendar';
import { cronAuthorised } from '@/server/cron-auth';

export const dynamic = 'force-dynamic';

// About every minute: looks at rooms' calendars and starts the rooms whose meetings have begun.
export async function GET(req: Request) {
  if (!cronAuthorised(req)) return Response.json({ error: 'Unauthorised' }, { status: 401 });
  return Response.json(await pollCalendars(db));
}
