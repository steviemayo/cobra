import { withGateway } from '@/server/gateway-http';
import { bundleLocation } from '@/server/gateway-release';
import { canSelfUpdate } from '@/server/gateway-updates';

export const dynamic = 'force-dynamic';

// Where a gateway that has been told to update downloads its bundle from: a short-lived link
// straight to the release asset, with the digest to check it against. Gateway credential only.
export async function GET(req: Request) {
  return withGateway(req, async (gw) => {
    if (!canSelfUpdate(gw.features))
      return { status: 403, body: { error: 'This gateway does not take portal updates' } };
    const location = await bundleLocation(gw.channel);
    if (!location)
      return { status: 502, body: { error: 'The release bundle is not available right now' } };
    return { status: 200, body: location };
  });
}
