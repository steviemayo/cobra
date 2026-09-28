import type { BundleLocation } from '@kestrel/model';
import type { Channel } from './gateway-updates';

// What is published on a gateway release channel, read from the (private) GitHub repo with a
// token that only the portal holds. The gateway never talks to GitHub: it asks the portal.

export const BUNDLE_ASSET = 'kestrel-gateway-win-x64.zip';
/** CI's signature over the bundle (see apps/gateway/src/release-signature.ts). */
export const SIGNATURE_ASSET = `${BUNDLE_ASSET}.sig`;
const CACHE_MS = 5 * 60_000;

export interface ReleaseAsset {
  name: string;
  /** The GitHub API URL of the asset (not the download link). */
  url: string;
  size?: number;
  /** "sha256:<hex>", as GitHub records it when the asset is uploaded. */
  digest?: string;
}

export interface ChannelRelease {
  channel: Channel;
  /** From the release's VERSION file. */
  version: string | null;
  assets: ReleaseAsset[];
}

type Fetch = typeof fetch;
export type ReleaseEnv = Record<string, string | undefined>;

export const githubHeaders = (env: ReleaseEnv = process.env): Record<string, string> => ({
  Accept: 'application/vnd.github+json',
  'User-Agent': 'kestrel-web',
  ...(env.GITHUB_RELEASE_TOKEN ? { Authorization: `Bearer ${env.GITHUB_RELEASE_TOKEN}` } : {}),
});

const repoOf = (env: ReleaseEnv) => env.GITHUB_GATEWAY_REPO ?? 'steviemayo/cobra';

const cache = new Map<Channel, { at: number; release: ChannelRelease }>();
export const clearReleaseCache = () => cache.clear();

/** The channel's release with its assets and version, or null if it cannot be read. Cached briefly. */
export async function channelRelease(
  channel: Channel,
  opts: { fetcher?: Fetch; env?: ReleaseEnv; now?: number } = {},
): Promise<ChannelRelease | null> {
  const fetcher = opts.fetcher ?? fetch;
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const hit = cache.get(channel);
  if (hit && now - hit.at < CACHE_MS) return hit.release;

  const res = await fetcher(
    `https://api.github.com/repos/${repoOf(env)}/releases/tags/gateway-${channel}`,
    { headers: githubHeaders(env), cache: 'no-store' },
  ).catch(() => null);
  if (!res?.ok) return null;
  const data = (await res.json()) as { assets?: ReleaseAsset[] };
  const assets = (data.assets ?? []).map((a) => ({
    name: a.name,
    url: a.url,
    ...(a.size ? { size: a.size } : {}),
    ...(a.digest ? { digest: a.digest } : {}),
  }));

  let version: string | null = null;
  const versionAsset = assets.find((a) => a.name === 'VERSION');
  if (versionAsset) {
    const v = await fetcher(versionAsset.url, {
      headers: { ...githubHeaders(env), Accept: 'application/octet-stream' },
      cache: 'no-store',
    }).catch(() => null);
    const text = v?.ok ? (await v.text()).trim() : '';
    version = /^\d+(\.\d+){0,2}/.test(text) ? text : null;
  }
  const release: ChannelRelease = { channel, version, assets };
  cache.set(channel, { at: now, release });
  return release;
}

/** The digest of the Windows bundle as bare hex, or undefined when the release does not carry one. */
export function bundleDigest(
  release: ChannelRelease,
): { sha256: string; size?: number } | undefined {
  const asset = release.assets.find((a) => a.name === BUNDLE_ASSET);
  const m = /^sha256:([0-9a-f]{64})$/i.exec(asset?.digest ?? '');
  return asset && m
    ? { sha256: m[1]!.toLowerCase(), ...(asset.size ? { size: asset.size } : {}) }
    : undefined;
}

/**
 * A short-lived link straight to the bundle, so the (large) file goes from GitHub to the gateway
 * without passing through the portal. GitHub answers an authenticated asset request with a redirect
 * to a signed storage URL; that URL is what the gateway is given.
 */
export async function bundleLocation(
  channel: Channel,
  opts: { fetcher?: Fetch; env?: ReleaseEnv } = {},
): Promise<BundleLocation | null> {
  const fetcher = opts.fetcher ?? fetch;
  const env = opts.env ?? process.env;
  const release = await channelRelease(channel, opts);
  const asset = release?.assets.find((a) => a.name === BUNDLE_ASSET);
  const digest = release ? bundleDigest(release) : undefined;
  if (!release?.version || !asset || !digest) return null;
  const res = await fetcher(asset.url, {
    headers: { ...githubHeaders(env), Accept: 'application/octet-stream' },
    redirect: 'manual',
    cache: 'no-store',
  }).catch(() => null);
  const location =
    res && res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
  if (!location) return null;
  // Passed on as it is: the gateway checks it against a key the portal does not hold.
  const signature = await releaseSignature(release, fetcher, env);
  return {
    url: location,
    sha256: digest.sha256,
    ...(digest.size ? { size: digest.size } : {}),
    version: release.version,
    ...(signature ? { signature } : {}),
  };
}

async function releaseSignature(
  release: ChannelRelease,
  fetcher: Fetch,
  env: ReleaseEnv,
): Promise<string | null> {
  const asset = release.assets.find((a) => a.name === SIGNATURE_ASSET);
  if (!asset) return null;
  const res = await fetcher(asset.url, {
    headers: { ...githubHeaders(env), Accept: 'application/octet-stream' },
    cache: 'no-store',
  }).catch(() => null);
  const text = res?.ok ? (await res.text()).trim() : '';
  return /^[A-Za-z0-9+/=]{60,300}$/.test(text) ? text : null;
}
