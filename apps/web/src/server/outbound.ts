import { request as httpsRequest, type RequestOptions } from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Everything Kestrel sends to an address a customer typed in (alert webhooks, Teams, service desk,
// ticket hooks) goes through here, so the rules live in one place: https only, public addresses
// only, and the connection goes to the address that was checked.

export type Lookup = (host: string) => Promise<string[]>;
export const resolveAll: Lookup = async (host) =>
  (await dnsLookup(host, { all: true })).map((a) => a.address);

// ---- Which addresses are public ---------------------------------------------------------------

/** [network, prefix length] pairs for IPv4 space that is not reachable from the public internet. */
const PRIVATE_V4: [number, number][] = [
  [0x00000000, 8], // "this" network
  [0x0a000000, 8], // 10/8
  [0x64400000, 10], // 100.64/10 shared address space
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // link-local, cloud metadata
  [0xac100000, 12], // 172.16/12
  [0xc0000000, 24], // 192.0.0/24 protocol assignments
  [0xc0000200, 24], // 192.0.2/24 documentation
  [0xc0586300, 24], // 192.88.99/24 6to4 relay
  [0xc0a80000, 16], // 192.168/16
  [0xc6120000, 15], // 198.18/15 benchmarking
  [0xc6336400, 24], // 198.51.100/24 documentation
  [0xcb007100, 24], // 203.0.113/24 documentation
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved, broadcast
];

function v4Number(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

function privateV4(n: number): boolean {
  return PRIVATE_V4.some(([net, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(net / 2 ** (32 - bits)));
}

/** The 16 bytes of an IPv6 address in any spelling (compressed, with an embedded dotted quad). */
function v6Bytes(ip: string): number[] | null {
  let s = ip.split('%')[0]!.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const n = v4Number(dotted[1]!);
    if (n === null) return null;
    s = `${s.slice(0, -dotted[1]!.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push(v >> 8, v & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

/**
 * True for anything that is not a public unicast address. IPv6 is default deny: only 2000::/3 is
 * public, and the spellings that carry an IPv4 address (mapped, NAT64, 6to4) are judged by the
 * IPv4 address inside. Anything that does not parse counts as private.
 */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = v4Number(ip);
    return n === null || privateV4(n);
  }
  if (kind !== 6) return true;
  const b = v6Bytes(ip);
  if (!b) return true;
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  const embedded = (at: number) => privateV4(((b[at]! * 256 + b[at + 1]!) * 256 + b[at + 2]!) * 256 + b[at + 3]!);
  // ::ffff:a.b.c.d (mapped)
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return embedded(12);
  // ::, ::1 and the old IPv4-compatible ::a.b.c.d
  if (zeros(0, 12)) return true;
  // 64:ff9b::/96 NAT64 (judged by the IPv4 inside) and 64:ff9b:1::/48 local use
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (zeros(4, 12)) return embedded(12);
    return true;
  }
  // 2002::/16 6to4
  if (b[0] === 0x20 && b[1] === 0x02) return embedded(2);
  // 2001::/32 Teredo, 2001:db8::/32 documentation
  if (b[0] === 0x20 && b[1] === 0x01 && ((b[2] === 0 && b[3] === 0) || (b[2] === 0x0d && b[3] === 0xb8)))
    return true;
  // Only global unicast (2000::/3) is public.
  return (b[0]! & 0xe0) !== 0x20;
}

/** Looks the host up and refuses it unless every address it gives is public. */
export async function resolvePublic(host: string, resolve: Lookup = resolveAll): Promise<string[]> {
  const name = host.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const lower = name.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.lan') ||
    lower.endsWith('.home.arpa') ||
    (!isIP(name) && !name.includes('.'))
  )
    throw new Error('The URL must point at a public address');
  const addresses = isIP(name) ? [name] : await resolve(name).catch(() => []);
  if (addresses.length === 0) throw new Error('That address could not be found');
  if (addresses.some(isPrivateAddress)) throw new Error('The URL must point at a public address');
  return addresses;
}

/**
 * Alert destinations are typed in by users, so they must not be able to point Kestrel at its own
 * network. Only https, only public addresses.
 */
export async function assertPublicUrl(raw: string, resolve: Lookup = resolveAll): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new Error('The URL must start with https://');
  if (url.username || url.password)
    throw new Error('The URL must not contain a username or password');
  await resolvePublic(url.hostname, resolve);
  return url;
}

// ---- Connecting to the address that was checked ------------------------------------------------

type Transport = (options: RequestOptions, body: string | undefined) => Promise<number>;

const httpsTransport: Transport = (options, body) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(options, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body);
  });

/**
 * A `fetch` for user-supplied addresses. The name is resolved once, every address must be public,
 * and the connection is made to that address, so a name that answers differently the second time
 * (DNS rebinding) cannot lead somewhere private. TLS still verifies the certificate against the
 * name. Redirects are never followed, and only the status comes back.
 */
export function makePinnedFetch(resolve: Lookup = resolveAll, transport: Transport = httpsTransport): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    if (url.protocol !== 'https:') throw new Error('The URL must start with https://');
    if (url.username || url.password)
      throw new Error('The URL must not contain a username or password');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const [address] = await resolvePublic(host, resolve);
    const family = isIP(address!) === 6 ? 6 : 4;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const status = await transport(
      {
        protocol: 'https:',
        hostname: host,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers,
        ...(init.signal ? { signal: init.signal } : {}),
        // Connect to the address that passed the check, not to whatever the name says now.
        lookup: (_name, options, callback) => {
          if ((options as { all?: boolean }).all)
            (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: address!, family }]);
          else (callback as (e: null, a: string, f: number) => void)(null, address!, family);
        },
      },
      typeof init.body === 'string' ? init.body : undefined,
    );
    return new Response(null, { status: status >= 200 && status <= 599 ? status : 502 });
  }) as typeof fetch;
}

export const pinnedFetch = makePinnedFetch();

// ---- Posting JSON ------------------------------------------------------------------------------

export interface PostDeps {
  fetch: typeof fetch;
  resolve?: Lookup;
}

/** POSTs a JSON body to a user-supplied address. Throws unless the destination answers with success. */
export async function postJson(
  d: PostDeps,
  rawUrl: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<void> {
  const url = await assertPublicUrl(rawUrl, d.resolve);
  const res = await d.fetch(url, {
    method: 'POST',
    // Redirects could lead somewhere the check above never saw.
    redirect: 'manual',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`The destination answered HTTP ${res.status}`);
}
