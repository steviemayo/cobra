import http from 'node:http';
import { createServer as createTcp, type Server as TcpServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Device } from '@kestrel/model';
import { QsysDriver } from './qsys';
import { QsysRestError, fetchCoreInfo, parseCoreInfo } from './qsys-rest';
import type { DeviceDriver, DriverContext } from './types';

const ctx: DriverContext = { log: () => undefined };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await wait(15);
  }
}

// What a Core Nano on firmware 10.4.1 answers at /api/v0/cores/self (serial number changed).
const SELF = {
  naturalId: '3-AAAABBBBCCCCDDDDEEEEFFFF00001111',
  serial: '3-AAAABBBBCCCCDDDDEEEEFFFF00001111',
  name: 'core-test',
  model: 'Core Nano',
  hardwareId: '3-AAAABBBBCCCCDDDDEEEEFFFF00001111',
  hostname: 'core-test',
  modelName: 'Core Nano',
  modelCode: '1960',
  firmware: {
    name: '10.4.1',
    build: '2607.004',
    buildName: '10.4.1-2607.004',
    isRelease: true,
    version: '10.4',
  },
  access: 'protected',
  serialNo: 'N00000TEST',
};

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

/** A Core's web interface: logon answers 201 with a token, and the info needs that token. */
async function fakeWeb(opts: { user?: string; password?: string; open?: boolean } = {}) {
  const seen: { method?: string; url?: string; auth?: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/v0/logon' && req.method === 'POST') {
        const b = JSON.parse(body) as { username?: string; password?: string };
        if (b.username === opts.user && b.password === opts.password) {
          res.statusCode = 201;
          return res.end('{"token":"tok123"}');
        }
        res.statusCode = 401;
        return res.end('{"code":401,"message":"Unauthorized"}');
      }
      if (req.url === '/api/v0/cores/self') {
        if (!opts.open && req.headers.authorization !== 'Bearer tok123') {
          res.statusCode = 401;
          return res.end('{"code":401,"message":"Unauthorized"}');
        }
        return res.end(JSON.stringify(SELF));
      }
      res.statusCode = 404;
      res.end('{"code":404}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => server.close());
  return { seen, port: (server.address() as { port: number }).port };
}

describe('Q-SYS Core identity over the web interface', () => {
  it('reads the model, the unit serial number (not the Core identifier) and the firmware build', () => {
    expect(parseCoreInfo(SELF)).toEqual({
      model: 'Core Nano',
      serial: 'N00000TEST',
      firmware: '10.4.1-2607.004',
      hostname: 'core-test',
      hardwareId: '3-AAAABBBBCCCCDDDDEEEEFFFF00001111',
    });
    // /api/v0/cores answers a list.
    expect(parseCoreInfo([SELF])?.serial).toBe('N00000TEST');
    expect(parseCoreInfo({ firmware: { name: '9.9.0' } })?.firmware).toBe('9.9.0');
    expect(parseCoreInfo({})).toBeNull();
    expect(parseCoreInfo('nope')).toBeNull();
  });

  it('logs on, then asks for the Core with the token', async () => {
    const web = await fakeWeb({ user: 'admin', password: 'pw' });
    const info = await fetchCoreInfo({
      host: '127.0.0.1',
      port: web.port,
      https: false,
      username: 'admin',
      password: 'pw',
    });
    expect(info).toMatchObject({ model: 'Core Nano', serial: 'N00000TEST' });
    expect(web.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'POST /api/v0/logon',
      'GET /api/v0/cores/self',
    ]);
    expect(JSON.parse(web.seen[0]!.body)).toEqual({ username: 'admin', password: 'pw' });
    expect(web.seen[1]!.auth).toBe('Bearer tok123');
  });

  it('asks without a logon when none is given, and says so when the Core needs one', async () => {
    const open = await fakeWeb({ open: true });
    expect((await fetchCoreInfo({ host: '127.0.0.1', port: open.port, https: false })).model).toBe(
      'Core Nano',
    );
    expect(open.seen).toHaveLength(1);
    const closed = await fakeWeb({ user: 'admin', password: 'pw' });
    await expect(
      fetchCoreInfo({ host: '127.0.0.1', port: closed.port, https: false }),
    ).rejects.toThrow(/needs a logon name/);
  });

  it('says so when the logon is wrong, and when nothing is listening', async () => {
    const web = await fakeWeb({ user: 'admin', password: 'pw' });
    const wrong = fetchCoreInfo({
      host: '127.0.0.1',
      port: web.port,
      https: false,
      username: 'admin',
      password: 'bad',
    });
    await expect(wrong).rejects.toBeInstanceOf(QsysRestError);
    await expect(wrong).rejects.toThrow(/refused the logon/);
    await expect(
      fetchCoreInfo({ host: '127.0.0.1', port: 1, https: false, timeoutMs: 500 }),
    ).rejects.toThrow();
  });
});

describe('Q-SYS driver identity', () => {
  /** A Core that answers QRC just enough to be online. */
  async function fakeQrc() {
    const server: TcpServer = createTcp((socket) => {
      socket.setEncoding('utf8');
      let buf = '';
      socket.on('error', () => undefined);
      socket.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\0')) >= 0) {
          const msg = JSON.parse(buf.slice(0, i)) as { id: number; method: string };
          buf = buf.slice(i + 1);
          const result =
            msg.method === 'StatusGet'
              ? {
                  Platform: 'Core Nano',
                  State: 'Active',
                  DesignName: 'Test',
                  Status: { Code: 0, String: 'OK' },
                }
              : true;
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\0');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => server.close());
    return (server.address() as { port: number }).port;
  }

  const device = (settings: Record<string, unknown>): Device =>
    ({
      id: 'dev-1',
      name: 'Core',
      category: 'audio_matrix',
      kind: 'active',
      control: { kind: 'driver', driverId: 'qsys-core' },
      settings,
    }) as unknown as Device;

  it('fills the firmware and an Identity section (model, serial number) alongside the engine status', async () => {
    const qrc = await fakeQrc();
    const web = await fakeWeb({ user: 'admin', password: 'pw' });
    const d: DeviceDriver = new QsysDriver(
      device({
        host: '127.0.0.1',
        port: qrc,
        username: 'admin',
        password: 'pw',
        restPort: web.port,
        restProtocol: 'http',
        timeoutMs: 400,
        pollMs: 100,
      }),
      ctx,
    );
    closers.push(() => d.close());
    d.start();
    await until(() => d.getState().firmware === '10.4.1-2607.004');
    await until(() => (d.getState().details ?? []).length === 2);
    const details = d.getState().details!;
    expect(details[0]).toMatchObject({ title: 'Identity' });
    expect(details[0]!.rows).toEqual(
      expect.arrayContaining([
        { label: 'Model', value: 'Core Nano' },
        { label: 'Serial number', value: 'N00000TEST' },
        { label: 'Firmware', value: '10.4.1-2607.004' },
      ]),
    );
    expect(details[1]).toMatchObject({ title: 'Q-SYS Core' });
    // Once is enough: it does not ask again every poll.
    await wait(350);
    expect(web.seen.filter((s) => s.url === '/api/v0/cores/self')).toHaveLength(1);
  });

  it('stays online and monitored when the web interface does not answer', async () => {
    const qrc = await fakeQrc();
    const d: DeviceDriver = new QsysDriver(
      device({
        host: '127.0.0.1',
        port: qrc,
        restPort: 1,
        restProtocol: 'http',
        timeoutMs: 400,
        pollMs: 100,
      }),
      ctx,
    );
    closers.push(() => d.close());
    d.start();
    await until(() => d.getState().online);
    await wait(200);
    expect(d.getState().online).toBe(true);
    expect(d.getState().firmware).toBeUndefined();
    expect(d.getState().details?.map((x) => x.title)).toEqual(['Q-SYS Core']);
  });
});
