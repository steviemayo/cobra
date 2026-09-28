import { describe, expect, it, vi } from 'vitest';
import type { RequestOptions } from 'node:https';
import { assertPublicUrl, isPrivateAddress, makePinnedFetch, postJson } from './outbound';

const publicDns = async () => ['93.184.216.34'];

describe('which addresses count as private', () => {
  it('recognises private and special IPv4 addresses', () => {
    for (const ip of [
      '10.0.0.1',
      '127.0.0.1',
      '127.255.255.254',
      '169.254.169.254',
      '172.16.5.5',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
      '100.127.255.255',
      '0.0.0.0',
      '192.0.0.1',
      '192.0.2.5',
      '198.18.0.1',
      '198.19.255.255',
      '198.51.100.9',
      '203.0.113.9',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of [
      '93.184.216.34',
      '8.8.8.8',
      '172.32.0.1',
      '172.15.255.255',
      '100.128.0.1',
      '198.20.0.1',
      '192.1.1.1',
    ])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('sees through every IPv6 spelling of an IPv4 address', () => {
    for (const ip of [
      '::ffff:10.1.1.1',
      '::ffff:a00:1', // what the URL parser turns 10.0.0.1 into
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      '0:0:0:0:0:ffff:a00:1',
      '::a00:1', // IPv4-compatible
      '::10.0.0.1',
      '64:ff9b::a00:1', // NAT64
      '64:ff9b::10.0.0.1',
      '64:ff9b:1::1',
      '2002:a00:1::', // 6to4
      '2002:7f00:1::1',
      '2001::1', // Teredo
      '2001:db8::1',
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['::ffff:5db8:d822', '64:ff9b::5db8:d822', '2002:5db8:d822::1'])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('treats the rest of IPv6 as default deny outside global unicast', () => {
    for (const ip of ['::', '::1', 'fd00::1', 'fc00::1', 'fe80::1', 'fec0::1', 'ff02::1', '100::1'])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['2606:4700::1111', '2a00:1450:4001::200e', '2001:4860:4860::8888'])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('counts anything it cannot parse as private', () => {
    for (const ip of ['', 'not-an-ip', '1.2.3', '::g', '1:2:3:4:5:6:7:8:9'])
      expect(isPrivateAddress(ip), ip).toBe(true);
  });
});

describe('assertPublicUrl', () => {
  it('only accepts https URLs that resolve to public addresses', async () => {
    await expect(assertPublicUrl('https://hooks.example.com/x', publicDns)).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('http://hooks.example.com/x', publicDns)).rejects.toThrow('https');
    await expect(assertPublicUrl('https://user:pw@hooks.example.com/x', publicDns)).rejects.toThrow('username');
    await expect(assertPublicUrl('https://sneaky.example.com/x', async () => ['10.0.0.5'])).rejects.toThrow('public');
    await expect(
      assertPublicUrl('https://mixed.example.com/x', async () => ['93.184.216.34', '10.0.0.5']),
    ).rejects.toThrow('public');
    await expect(assertPublicUrl('https://gone.example.com/x', async () => [])).rejects.toThrow('found');
    await expect(assertPublicUrl('not a url', publicDns)).rejects.toThrow('valid');
  });

  it('refuses names that only make sense inside a network', async () => {
    for (const host of [
      'localhost',
      'LOCALHOST.',
      'app.localhost',
      'printer.local',
      'meta.internal',
      'nas.lan',
      'router.home.arpa',
      'intranet', // no dot: resolved through a search domain
    ])
      await expect(assertPublicUrl(`https://${host}/x`, publicDns), host).rejects.toThrow('public');
  });

  it('refuses every way of writing a private address in a URL', async () => {
    for (const host of [
      '127.0.0.1',
      '127.1',
      '2130706433',
      '0x7f000001',
      '0177.0.0.1',
      '169.254.169.254',
      '[::1]',
      '[::ffff:7f00:1]',
      '[::ffff:127.0.0.1]',
      '[::ffff:a9fe:a9fe]',
      '[::a00:1]',
      '[64:ff9b::a00:1]',
      '[2002:a00:1::]',
      '192.0.0.1',
      '198.18.0.1',
    ])
      await expect(assertPublicUrl(`https://${host}/x`, publicDns), host).rejects.toThrow('public');
  });
});

describe('pinned fetch', () => {
  it('connects to the address that passed the check, not to whatever the name says later', async () => {
    let options: RequestOptions | undefined;
    const resolve = vi.fn(async () => ['93.184.216.34']);
    const f = makePinnedFetch(resolve, async (o) => {
      options = o;
      return 204;
    });
    const res = await f(new URL('https://hooks.example.com/a/b?c=1'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kestrel-signature': 'sha256=abc' },
      body: '{}',
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(204);
    expect(resolve).toHaveBeenCalledTimes(1);
    // The TLS name stays the host name (so the certificate is checked against it)...
    expect(options?.hostname).toBe('hooks.example.com');
    expect(options?.path).toBe('/a/b?c=1');
    expect(options?.headers).toMatchObject({ 'x-kestrel-signature': 'sha256=abc' });
    // ...but the socket is opened to the checked address, however the runtime asks for it.
    const answer = vi.fn();
    (options!.lookup as (h: string, o: object, cb: typeof answer) => void)('hooks.example.com', { all: true }, answer);
    expect(answer).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
    const single = vi.fn();
    (options!.lookup as (h: string, o: object, cb: typeof single) => void)('hooks.example.com', {}, single);
    expect(single).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });

  it('refuses a name that resolves to a private address, and never connects', async () => {
    const transport = vi.fn(async () => 200);
    const f = makePinnedFetch(async () => ['93.184.216.34', '::ffff:7f00:1'], transport);
    await expect(f('https://hooks.example.com/x')).rejects.toThrow('public');
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses http and credentials in the address', async () => {
    const transport = vi.fn(async () => 200);
    const f = makePinnedFetch(publicDns, transport);
    await expect(f('http://hooks.example.com/x')).rejects.toThrow('https');
    await expect(f('https://a:b@hooks.example.com/x')).rejects.toThrow('username');
    expect(transport).not.toHaveBeenCalled();
  });

  it('uses an IPv6 address the same way', async () => {
    let options: RequestOptions | undefined;
    const f = makePinnedFetch(async () => ['2606:4700::1111'], async (o) => {
      options = o;
      return 200;
    });
    await f('https://hooks.example.com/x');
    const answer = vi.fn();
    (options!.lookup as (h: string, o: object, cb: typeof answer) => void)('hooks.example.com', {}, answer);
    expect(answer).toHaveBeenCalledWith(null, '2606:4700::1111', 6);
  });
});

describe('postJson', () => {
  it('posts JSON without following redirects, and fails on a bad answer', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = {
      fetch: (async (url: string | URL, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
      resolve: publicDns,
    };
    await postJson(ok, 'https://hooks.example.com/x', '{"a":1}', { 'x-extra': '1' });
    expect(calls[0]!.init).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      body: '{"a":1}',
      headers: { 'content-type': 'application/json', 'x-extra': '1' },
    });
    const bad = { ...ok, fetch: (async () => new Response('no', { status: 500 })) as typeof fetch };
    await expect(postJson(bad, 'https://hooks.example.com/x', '{}')).rejects.toThrow('HTTP 500');
  });

  it('checks the destination before sending anything', async () => {
    const f = vi.fn();
    await expect(
      postJson({ fetch: f as unknown as typeof fetch, resolve: publicDns }, 'https://[::ffff:7f00:1]/x', '{}'),
    ).rejects.toThrow('public');
    expect(f).not.toHaveBeenCalled();
  });
});
