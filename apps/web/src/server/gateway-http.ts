import { after } from 'next/server';
import { db } from '@kestrel/db';
import { authenticateGateway, type Result } from './gateway-service';
import type { Db } from './gateway-service';

type Gateway = NonNullable<Awaited<ReturnType<typeof authenticateGateway>>>;

export function respond(r: Result) {
  if (r.after) after(r.after);
  return Response.json(r.body, { status: r.status });
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

/** Authenticates the calling gateway by its bearer credential, then runs the handler. */
export async function withGateway(
  req: Request,
  handler: (gateway: Gateway, database: Db) => Promise<Result>,
): Promise<Response> {
  const gateway = await authenticateGateway(db, req.headers.get('authorization'));
  if (!gateway) return Response.json({ error: 'Unauthorised' }, { status: 401 });
  return respond(await handler(gateway, db));
}
