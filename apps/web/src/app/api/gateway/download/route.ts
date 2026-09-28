// Proxies gateway release assets from GitHub. The repo is private, so a direct link to a release
// asset 404s for anyone who isn't signed into GitHub with repo access; this fetches it server-side
// with a token instead, so the Gateways page's download links work for anyone.
import { channelRelease, githubHeaders } from '@/server/gateway-release';

export const dynamic = 'force-dynamic';

const ASSET_BY_PLATFORM: Record<string, string> = {
  windows: 'KestrelGatewaySetup.exe',
  'windows-zip': 'kestrel-gateway-win-x64.zip',
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const platform = url.searchParams.get('platform') ?? 'windows';
  const channel = url.searchParams.get('channel') === 'beta' ? 'beta' : 'stable';
  const asset = ASSET_BY_PLATFORM[platform];
  if (!asset) return new Response('Unknown platform', { status: 400 });

  const release = await channelRelease(channel);
  if (!release) {
    return new Response(
      'Could not reach the release (set GITHUB_RELEASE_TOKEN if the repo is private)',
      { status: 502 },
    );
  }
  const found = release.assets.find((a) => a.name === asset);
  if (!found) return new Response(`${asset} is not on the ${channel} release yet`, { status: 404 });

  const download = await fetch(found.url, {
    headers: { ...githubHeaders(), Accept: 'application/octet-stream' },
    cache: 'no-store',
  });
  if (!download.ok || !download.body) return new Response('Download failed', { status: 502 });

  const responseHeaders: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${asset}"`,
  };
  const length = download.headers.get('content-length');
  if (length) responseHeaders['Content-Length'] = length;

  return new Response(download.body, { headers: responseHeaders });
}
