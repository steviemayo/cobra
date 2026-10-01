import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, type Device } from '@kestrel/model';
import { BlustreamPwrDriver, parsePwrStatus, pwrPointValue } from './blustream-pwr';
import { BUILT_IN_DRIVER_IDS, createDriver } from './registry';
import type { DriverContext } from './types';

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

// What a real PWR4IEC (V1.1.0) printed for STATUS, trimmed of the IPv6 blocks.
const STATUS = `Please Input Your Command : =====================================================================================
              PWR4IEC 4 Port IEC Power Controller
              FW Version: V1.1.0

Power    Key      Relay      TCP/IP      Baud      Current_Threshold
ON       ON       ON         2           57600     10.9

Outlet   Status   Mode            PowerOnTime    PowerOffTime   EleReset
1        ON       Connected       1s             1s             10s
2        OFF      Idle            2s             2s             10s
3        ON       Connected       3s             3s             10s
4        ON       Connected       4s             4s             10s
SYS      ON       Normal

============== TCP/IP1(IPv4)
DHCP        IP                   Gateway            SubnetMask
ON          192.168.001.243      192.168.001.001    255.255.255.000
mDNS        mDNS Name            MAC
ON          PWR4IEC              34:D0:B8:23:2D:2C

============== ELECTRIC
Outlet   Voltage     Current     ElectricWork   Consumed         PowerFactor   Frequency
1        239.526V    0.100A      10.809W        31.298854kWh     0.44         50.68Hz
2        239.526V    0.000A      0.000W         0.000000kWh      0.00          50.68Hz
3        239.526V    0.454A      65.689W        185.765952kWh    0.60        50.68Hz
4        239.526V    0.152A      27.649W        47.903696kWh     0.75         50.68Hz
SYS      239.526V    0.708A      104.128W       264.958960kWh    0.61        50.68Hz
=====================================================================================
`;

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function fakePwr(reply = STATUS) {
  const sent: string[] = [];
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    let buf = '';
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        sent.push(line);
        if (line === 'STATUS') socket.write(reply);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { sent, port: (server.address() as { port: number }).port };
}

const device = (port: number): Device => ({
  ...base.devices[0]!,
  category: 'power_outlet',
  ports: [],
  control: { kind: 'driver', driverId: 'blustream-pwr' },
  settings: { host: '127.0.0.1', port, pollMs: 60_000, timeoutMs: 800 },
});

describe('Blustream PWR driver', () => {
  it('reads the unit, outlets and electrical figures out of STATUS', () => {
    const r = parsePwrStatus(STATUS);
    expect(r).toMatchObject({
      model: 'PWR4IEC',
      firmware: 'V1.1.0',
      mac: '34:D0:B8:23:2D:2C',
      ip: '192.168.1.243',
      system: 'Normal',
    });
    expect(r.outlets).toEqual([
      { n: 1, on: true, mode: 'Connected' },
      { n: 2, on: false, mode: 'Idle' },
      { n: 3, on: true, mode: 'Connected' },
      { n: 4, on: true, mode: 'Connected' },
    ]);
    expect(r.electric['3']).toMatchObject({ amps: '0.454', watts: '65.689' });
    expect(r.electric.SYS).toMatchObject({ watts: '104.128' });
  });

  it('is what a device asks for by driver id, and reports state and details', async () => {
    expect(BUILT_IN_DRIVER_IDS).toContain('blustream-pwr');
    const p = await fakePwr();
    const d = createDriver(device(p.port), ctx)!;
    expect(d).toBeInstanceOf(BlustreamPwrDriver);
    d.start();
    await until(() => d.getState().online);
    const s = d.getState();
    expect(s).toMatchObject({ power: 'on', firmware: 'V1.1.0' });
    const outlets = s.details!.find((x) => x.title === 'Outlets')!;
    expect(outlets.table!.rows).toHaveLength(4);
    expect(outlets.table!.rows[2]!.cells).toEqual(['3', 'On', 'Connected', '0.454 A', '65.689 W', '185.765952 kWh']);
    d.close();
  });

  it('switches everything or one outlet, and refuses anything else', async () => {
    const p = await fakePwr();
    const d = new BlustreamPwrDriver(device(p.port), ctx);
    await d.send({ type: 'power', on: false });
    await d.send({ type: 'command', name: 'outlet2_on', args: {} });
    await until(() => p.sent.includes('OUTLET 2 ON'));
    expect(p.sent).toEqual(expect.arrayContaining(['ALLOUT OFF', 'OUTLET 2 ON']));
    await expect(d.send({ type: 'command', name: 'format', args: {} })).rejects.toThrow('does not support');
    await expect(d.send({ type: 'volume', level: 5 })).rejects.toThrow('does not support');
    d.close();
  });

  it('is offline when the reply is not a PWR status', async () => {
    const p = await fakePwr('Please Input Your Command : ');
    const d = new BlustreamPwrDriver(device(p.port), ctx);
    d.start();
    await until(() => p.sent.length > 0);
    await wait(300);
    expect(d.getState().online).toBe(false);
    d.close();
  });
});

describe('outlet control points', () => {
  const r = parsePwrStatus(STATUS);
  it('read an outlet’s state, load and electrical figures', () => {
    expect(pwrPointValue({ outlet: '1', field: 'state' }, r)).toBe(true);
    expect(pwrPointValue({ outlet: '2', field: 'state' }, r)).toBe(false);
    expect(pwrPointValue({ outlet: '2', field: 'load' }, r)).toBe(false);
    expect(pwrPointValue({ outlet: '3', field: 'load' }, r)).toBe(true);
    expect(pwrPointValue({ outlet: 3, field: 'watts' }, r)).toBe(65.689);
    expect(pwrPointValue({ outlet: '4', field: 'amps' }, r)).toBe(0.152);
    expect(pwrPointValue({ outlet: '3' }, r)).toBe(true);
  });
  it('are undefined for an outlet or reading that is not there', () => {
    expect(pwrPointValue({ outlet: '9', field: 'state' }, r)).toBeUndefined();
    expect(pwrPointValue({ outlet: '1', field: 'bogus' }, r)).toBeUndefined();
  });

  it('are reported by the driver, one value per point, and can be read to check them', async () => {
    const p = await fakePwr();
    const dev = {
      ...device(p.port),
      points: [
        { id: 'hall-power', name: 'Hall projector', type: 'generic', address: { outlet: '3', field: 'state' } },
        { id: 'hall-watts', name: 'Hall draw', type: 'generic', address: { outlet: '3', field: 'watts' } },
      ],
    } as Device;
    const d = new BlustreamPwrDriver(dev, ctx);
    d.start();
    await until(() => d.getState().online);
    expect(d.getState().points).toEqual({ 'hall-power': true, 'hall-watts': 65.689 });
    expect(await d.readPoint({ type: 'generic', address: { outlet: '4', field: 'watts' } })).toEqual({ value: 27.649 });
    await expect(d.readPoint({ type: 'generic', address: { outlet: '9' } })).rejects.toThrow('not found');
    d.close();
  });
});
