import { createServer, type Server, type Socket } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_FOUND, discoverDevices, isPrivateV4, ownSubnets, pjlinkInfo, tcpOpen, type KnownPort } from './discovery';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

const listen = (onConnect: (s: Socket) => void) =>
  new Promise<number>((resolve) => {
    const server = createServer((s) => {
      s.on('error', () => undefined);
      onConnect(s);
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });

/** A projector that speaks PJLink with no password. */
const projector = (reply: Record<string, string>) =>
  listen((s) => {
    s.write('PJLINK 0\r');
    s.on('data', (d) => {
      for (const line of d.toString().split('\r').filter(Boolean)) {
        const key = /^%1([A-Z0-9]+) \?$/.exec(line)?.[1] ?? '';
        s.write(`%1${key}=${reply[key] ?? 'ERR1'}\r`);
      }
    });
  });

const closedPort = async () => {
  const port = await listen(() => undefined);
  servers.pop()!.close();
  return port;
};

const pj = (port: number): KnownPort => ({ port, label: 'Projector or display (PJLink)', pjlink: true });
const plain = (port: number): KnownPort => ({ port, label: 'Telnet control' });

describe('finding equipment', () => {
  it('asks a PJLink projector for its name, maker and model', async () => {
    const port = await projector({ NAME: 'Boardroom projector', INF1: 'Epson', INF2: 'EB-L200' });
    const r = await discoverDevices({ hosts: ['127.0.0.1'], ports: [pj(port)], timeoutMs: 500 });
    expect(r.found).toEqual([
      { host: '127.0.0.1', ports: [port], kind: 'Projector or display (PJLink)', name: 'Boardroom projector', manufacturer: 'Epson', model: 'EB-L200' },
    ]);
    expect(r.truncated).toBe(false);
    expect(r.hostsScanned).toBe(1);
  });

  it('says so when a projector wants its password, and asks it nothing', async () => {
    const asked: string[] = [];
    const port = await listen((s) => {
      s.write('PJLINK 1 498e4a67\r');
      s.on('data', (d) => asked.push(d.toString()));
    });
    const r = await discoverDevices({ hosts: ['127.0.0.1'], ports: [pj(port)], timeoutMs: 500 });
    expect(r.found[0]).toMatchObject({ host: '127.0.0.1', note: expect.stringContaining('password') });
    expect(r.found[0]!.name).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it('lists something that only accepts a connection, by what its port usually means', async () => {
    const port = await listen(() => undefined);
    const r = await discoverDevices({ hosts: ['127.0.0.1'], ports: [plain(port)], timeoutMs: 500 });
    expect(r.found).toEqual([{ host: '127.0.0.1', ports: [port], kind: 'Telnet control' }]);
  });

  it('ignores ports nothing answers on', async () => {
    const r = await discoverDevices({ hosts: ['127.0.0.1'], ports: [plain(await closedPort())], timeoutMs: 300 });
    expect(r.found).toEqual([]);
  });

  it('joins every port a device answers on into one entry', async () => {
    const a = await listen(() => undefined);
    const b = await listen(() => undefined);
    const r = await discoverDevices({ hosts: ['127.0.0.1'], ports: [plain(a), { port: b, label: 'Q-SYS Core' }], timeoutMs: 500 });
    expect(r.found).toHaveLength(1);
    expect(r.found[0]!.ports).toEqual([a, b].sort((x, y) => x - y));
  });

  it('copes with a device that stops answering halfway', async () => {
    const port = await listen((s) => {
      s.write('PJLINK 0\r');
      s.once('data', () => s.destroy());
    });
    const r = await discoverDevices({ hosts: ['127.0.0.1'], ports: [pj(port)], timeoutMs: 400 });
    expect(r.found).toHaveLength(1);
    expect(r.found[0]!.name).toBeUndefined();
  });

  it('tells open ports from closed ones', async () => {
    const port = await listen(() => undefined);
    expect(await tcpOpen('127.0.0.1', port, 500)).toBe(true);
    expect(await tcpOpen('127.0.0.1', await closedPort(), 500)).toBe(false);
    expect((await pjlinkInfo('127.0.0.1', await closedPort(), 300)).name).toBeUndefined();
  });
});

describe('which networks are looked at', () => {
  const nic = (address: string, over: Partial<NetworkInterfaceInfo> = {}) =>
    ({ address, family: 'IPv4', internal: false, netmask: '255.255.255.0', cidr: null, mac: '', ...over }) as NetworkInterfaceInfo;

  it('knows private addresses', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.9']) expect(isPrivateV4(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '100.64.0.1', 'nonsense', '10.1.2']) expect(isPrivateV4(ip)).toBe(false);
  });

  it('takes the /24 of each private address the gateway has, and nothing else', () => {
    const nets = {
      lo: [nic('127.0.0.1', { internal: true })],
      eth0: [nic('192.168.1.20'), nic('192.168.1.21'), nic('fe80::1', { family: 'IPv6' } as never)],
      eth1: [nic('10.5.6.7')],
      wan: [nic('203.0.113.9')],
      newer: [nic('172.20.1.5', { family: 4 as never })],
    };
    expect(ownSubnets(nets).map((s) => s.prefix)).toEqual(['192.168.1', '10.5.6', '172.20.1']);
    expect([...ownSubnets(nets)[0]!.own]).toEqual(['192.168.1.20', '192.168.1.21']);
  });

  it('never looks at more than three networks', () => {
    const nets = { a: ['10.0.1.1', '10.0.2.1', '10.0.3.1', '10.0.4.1'].map((a) => nic(a)) };
    expect(ownSubnets(nets)).toHaveLength(3);
  });

  it('scans every other address on those networks and only those', async () => {
    const tried = new Set<string>();
    const nets = { eth0: [nic('192.168.1.20')], wan: [nic('203.0.113.9')] };
    const r = await discoverDevices({
      nets,
      ports: [plain(4352)],
      open: async (host) => {
        tried.add(host);
        return false;
      },
    });
    expect(r.subnets).toEqual(['192.168.1']);
    expect(r.hostsScanned).toBe(253);
    expect(tried.size).toBe(253);
    expect(tried.has('192.168.1.20')).toBe(false);
    expect([...tried].every((h) => h.startsWith('192.168.1.'))).toBe(true);
  });

  it('can be limited to one of its networks, and refuses one it is not on', async () => {
    const nets = { eth0: [nic('192.168.1.20')], eth1: [nic('10.5.6.7')] };
    const open = async () => false;
    expect((await discoverDevices({ nets, subnets: ['10.5.6'], ports: [plain(1)], open })).subnets).toEqual(['10.5.6']);
    const none = await discoverDevices({ nets, subnets: ['192.168.9'], ports: [plain(1)], open });
    expect(none.subnets).toEqual([]);
    expect(none.hostsScanned).toBe(0);
  });
});

describe('limits', () => {
  it('stops after the deadline and says so, keeping what it found', async () => {
    let t = 0;
    const r = await discoverDevices({
      hosts: Array.from({ length: 50 }, (_, i) => `10.0.0.${i + 1}`),
      ports: [plain(1)],
      concurrency: 1,
      deadlineMs: 10,
      now: () => t,
      open: async (host) => {
        t += 4;
        return host === '10.0.0.1';
      },
    });
    expect(r.truncated).toBe(true);
    expect(r.found.map((d) => d.host)).toEqual(['10.0.0.1']);
  });

  it('lists no more than the cap, in address order', async () => {
    const hosts = Array.from({ length: MAX_FOUND + 20 }, (_, i) => `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}`).reverse();
    const r = await discoverDevices({ hosts, ports: [plain(1)], open: async () => true });
    expect(r.found).toHaveLength(MAX_FOUND);
    expect(r.truncated).toBe(true);
    expect(r.found[0]!.host).toBe('10.0.0.1');
  });
});
