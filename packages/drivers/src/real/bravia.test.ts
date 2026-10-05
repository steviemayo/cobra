import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, type Device } from '@kestrel/model';
import { createDriver } from './registry';
import type { DeviceDriver, DriverContext } from './types';

const ctx: DriverContext = { log: () => undefined };
const base = STARTER_TEMPLATES[0]!.model;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await wait(15);
  }
}

interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const servers: http.Server[] = [];
const drivers: DeviceDriver[] = [];
afterEach(() => {
  drivers.splice(0).forEach((d) => d.close());
  servers.splice(0).forEach((s) => s.close());
});

// What a BRAVIA answers to getSystemInformation (serial and MAC changed).
const SYSTEM_INFO = JSON.stringify({
  result: [
    {
      generation: '5.6.0',
      product: 'TV',
      serial: '1234567',
      name: 'BRAVIA',
      language: 'eng',
      model: 'FW-43BZ35J',
      macAddr: 'aa:bb:cc:dd:ee:ff',
      fwVersion: 'PKG0.6.0.81.00.1.00.0951BBA',
      androidOs: '12',
      mode: 'Normal',
    },
  ],
  id: 33,
});

/** A display that answers like a BRAVIA: JSON for REST calls, an empty envelope for IRCC. */
async function fakeBravia(power: 'active' | 'standby' = 'standby') {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      res.end(
        body.includes('getPowerStatus')
          ? `{"result":[{"status":"${power}"}],"id":2}`
          : body.includes('getSystemInformation')
            ? SYSTEM_INFO
            : '{"result":[],"id":1}',
      );
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { seen, port: (server.address() as { port: number }).port };
}

function bravia(
  port: number,
  apps: unknown = [{ id: 'com.example.app', name: 'Example' }],
): DeviceDriver {
  const device: Device = {
    ...base.devices.find((d) => d.category === 'video_destination')!,
    control: { kind: 'driver', driverId: 'lib:sony-bravia' },
    settings: { host: '127.0.0.1', port, psk: 'secret-psk', apps },
  };
  const driver = createDriver(device, ctx)!;
  drivers.push(driver);
  return driver;
}

describe('Sony BRAVIA driver', () => {
  it('declares the display features', () => {
    const d = bravia(1);
    expect(d.features?.()).toEqual(['remote_keys', 'media_keys', 'apps', 'builtin_audio']);
  });

  it('turns on with a REST call carrying the pre-shared key, and reads power back', async () => {
    const { seen, port } = await fakeBravia('standby');
    const d = bravia(port);
    d.start();
    await until(() => seen.some((s) => s.body.includes('getPowerStatus')));
    await until(() => d.getState().power === 'off');
    await d.send({ type: 'power', on: true });
    const call = seen.find((s) => s.body.includes('setPowerStatus'))!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/sony/system');
    expect(call.headers['x-auth-psk']).toBe('secret-psk');
    expect(call.headers['content-type']).toBe('application/json');
    expect(JSON.parse(call.body)).toMatchObject({
      method: 'setPowerStatus',
      params: [{ status: true }],
    });
  });

  it('reads its model, serial number, MAC and firmware for the register', async () => {
    const { seen, port } = await fakeBravia();
    const d = bravia(port);
    d.start();
    await until(() => d.getState().firmware === 'PKG0.6.0.81.00.1.00.0951BBA');
    expect(seen.some((s) => s.body.includes('getSystemInformation'))).toBe(true);
    expect(d.getState().details).toEqual([
      {
        title: 'Identity',
        rows: [
          { label: 'Model', value: 'FW-43BZ35J' },
          { label: 'Serial number', value: '1234567' },
          { label: 'MAC address', value: 'aa:bb:cc:dd:ee:ff' },
        ],
      },
    ]);
    // The power poll is not confused by it.
    await until(() => d.getState().power === 'off');
  });

  it('reads an active display as on', async () => {
    const { port } = await fakeBravia('active');
    const d = bravia(port);
    d.start();
    await until(() => d.getState().power === 'on');
  });

  it('selects an HDMI input and scales volume', async () => {
    const { seen, port } = await fakeBravia();
    const d = bravia(port);
    await d.send({ type: 'select_input', portId: 'in2' });
    await d.send({ type: 'volume', level: 40 });
    const input = JSON.parse(seen.find((s) => s.url === '/sony/avContent')!.body);
    expect(input.params[0].uri).toBe('extInput:hdmi?port=2');
    const volume = JSON.parse(seen.find((s) => s.url === '/sony/audio')!.body);
    expect(volume.params[0]).toEqual({ target: 'speaker', volume: '40' });
  });

  it('presses a remote key as an IRCC SOAP call with its own headers', async () => {
    const { seen, port } = await fakeBravia();
    const d = bravia(port);
    await d.send({ type: 'key', key: 'home' });
    const call = seen.find((s) => s.url === '/sony/ircc')!;
    expect(call.headers['content-type']).toBe('text/xml; charset=UTF-8');
    expect(call.headers.soapaction).toBe('"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"');
    expect(call.headers['x-auth-psk']).toBe('secret-psk');
    expect(call.body).toContain('<IRCCCode>AAAAAQAAAAEAAABgAw==</IRCCCode>');
  });

  it('has a code for every key', async () => {
    const { seen, port } = await fakeBravia();
    const d = bravia(port);
    const keys = [
      'up',
      'down',
      'left',
      'right',
      'ok',
      'back',
      'home',
      'menu',
      'play',
      'pause',
      'stop',
      'forward',
      'rewind',
    ] as const;
    for (const key of keys) await d.send({ type: 'key', key });
    const codes = seen
      .filter((s) => s.url === '/sony/ircc')
      .map((s) => /<IRCCCode>(.*)<\/IRCCCode>/.exec(s.body)![1]);
    expect(new Set(codes).size).toBe(keys.length);
  });

  it('launches an app by its id, escaped inside the JSON', async () => {
    const { seen, port } = await fakeBravia();
    const d = bravia(port);
    await d.send({ type: 'launch_app', appId: 'localapp://webappruntime?url=http%3A%2F%2Fx%2F"q' });
    const body = JSON.parse(seen.find((s) => s.url === '/sony/appControl')!.body);
    expect(body).toMatchObject({
      method: 'setActiveApp',
      params: [{ uri: 'localapp://webappruntime?url=http%3A%2F%2Fx%2F"q' }],
    });
    expect(d.getState().activeApp).toBe('localapp://webappruntime?url=http%3A%2F%2Fx%2F"q');
  });
});
