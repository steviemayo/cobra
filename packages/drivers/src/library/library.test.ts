import http from 'node:http';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILT_IN_DRIVERS, STARTER_TEMPLATES, checkDriverSpec, type Device } from '@kestrel/model';
import { AVOIP_SWITCHER_IDS } from '../real/avoip';
import { DeclarativeDriver } from '../real/declarative';
import { BUILT_IN_DRIVER_IDS, createDriver } from '../real/registry';
import type { DeviceDriver } from '../real/types';
import { LIBRARY } from './index';

const ctx = { log: () => undefined };
const base = STARTER_TEMPLATES[0]!.model;
const dev = (driverId: string, settings: Record<string, unknown>): Device => ({
  ...base.devices.find((d) => d.id === 'dsp')!,
  control: { kind: 'driver', driverId },
  settings,
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await wait(15);
  }
}
const closers: (() => void)[] = [];
const drivers: DeviceDriver[] = [];
afterEach(() => {
  drivers.splice(0).forEach((d) => d.close());
  closers.splice(0).forEach((c) => c());
});

const httpServer = async (handler: http.RequestListener) => {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return (server.address() as { port: number }).port;
};

describe('bundled drivers', () => {
  it('are all valid driver specs', () => {
    expect(Object.keys(LIBRARY).sort()).toEqual(['lib:cisco-roomos', 'lib:extron-sis', 'lib:kramer-p3000', 'lib:lg-signage', 'lib:lutron-lip', 'lib:shelly-relay', 'lib:sony-bravia']);
    for (const spec of Object.values(LIBRARY)) expect(checkDriverSpec(spec).ok, spec.id).toBe(true);
  });

  it('are each offered in the device editor with example settings that get a driver, and the other way round', () => {
    for (const id of Object.keys(LIBRARY)) expect(BUILT_IN_DRIVERS[id], id).toBeDefined();
    for (const [id, info] of Object.entries(BUILT_IN_DRIVERS)) {
      expect(BUILT_IN_DRIVER_IDS, id).toContain(id);
      // A virtual switcher has no address: the room builds it from the other devices (see avoip.ts).
      if (AVOIP_SWITCHER_IDS.has(id)) continue;
      expect(createDriver(dev(id, info.example), ctx), id).not.toBeNull();
    }
  });

  it('Extron routes with its own syntax and waits for its own reply', async () => {
    const seen: string[] = [];
    const server = createServer((s) => {
      s.on('error', () => undefined);
      s.on('data', (c) => {
        for (const line of c.toString().split('\r\n').filter(Boolean)) {
          seen.push(line);
          const m = /^(\d+)\*(\d+)!$/.exec(line);
          if (m) s.write(`Out${m[2]} In${m[1]} All\r\n`);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => server.close());
    const port = (server.address() as { port: number }).port;
    const d = createDriver(dev('lib:extron-sis', { host: '127.0.0.1', port }), ctx)!;
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    await d.send({ type: 'route', inputPortId: 'in3', outputPortId: 'out2' });
    expect(seen).toContain('3*2!');
    expect(d.getState().routes.out2).toBe('in3');
  });

  it('Shelly runs a screen down and up for the configured time', async () => {
    const urls: string[] = [];
    const port = await httpServer((req, res) => {
      urls.push(req.url!);
      res.writeHead(200);
      res.end('{"ison":false}');
    });
    const d = createDriver(dev('lib:shelly-relay', { host: '127.0.0.1', port, seconds: 25 }), ctx)!;
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    await d.send({ type: 'command', name: 'down', args: {} });
    await d.send({ type: 'command', name: 'up', args: {} });
    expect(urls).toContain('/relay/0?turn=on&timer=25');
    expect(urls).toContain('/relay/1?turn=on&timer=25');
  });

  it('Cisco sends its XML with the credentials from its settings', async () => {
    const seen: { body: string; auth?: string; type?: string }[] = [];
    const port = await httpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ body: Buffer.concat(chunks).toString(), auth: req.headers.authorization, type: req.headers['content-type'] });
        res.writeHead(200);
        res.end('<Status><Standby><State>Off</State></Standby></Status>');
      });
    });
    // The library driver says https; this test device speaks plain HTTP, so run the same spec over http.
    const lib = LIBRARY['lib:cisco-roomos']!;
    const spec = { ...lib, transport: { ...lib.transport, https: false } } as typeof lib;
    const d = new DeclarativeDriver(dev('lib:cisco-roomos', { host: '127.0.0.1', port, credentials: 'dXNlcjpwdw==' }), ctx, spec);
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    await until(() => d.getState().power === 'on');
    await d.send({ type: 'volume', level: 60 });
    const post = seen.find((s) => s.body.includes('<Level>'))!;
    expect(post.body).toContain('<Level>60</Level>');
    expect(post.auth).toBe('Basic dXNlcjpwdw==');
    expect(post.type).toBe('text/xml');
  });
});
