import { after } from 'next/server';
import { db } from '@kestrel/db';
import { authenticateGateway, type Result } from './gateway-service';
import type { Db } from './gateway-service';

type Gateway = NonNullable<Awaited<ReturnType<typeof authenticateGateway>>>;

export function respond(r: Result) {
  if (r.after) after(r.after);
  return Response.json(r.body, { status: r.status });
}

// A gateway can send up to 50 rooms' worth of state and device details in one heartbeat, so this
// is generous; it exists to bound memory on a request that claims to be one size and sends
// another, not to constrain a real gateway.
const MAX_GATEWAY_BODY = 4 * 1024 * 1024;

/**
 * Reads a request body up to `maxBytes` of what is actually sent, not what a `content-length`
 * header claims (a client can send whatever it likes there). Returns `undefined` — the same as a
 * body that fails to parse — for anything too large, unreadable, or not valid JSON.
 */
export async function readJson(req: Request, maxBytes = MAX_GATEWAY_BODY): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
