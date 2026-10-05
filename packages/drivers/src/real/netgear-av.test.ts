import { createServer as createHttps, type Server } from 'node:https';
import { afterEach, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, type Device } from '@kestrel/model';
import { createDriver } from './registry';
import type { DeviceDriver, DriverContext } from './types';

// The Netgear AV switch driver against a fake switch that answers the way an M4250-26G4F-PoE+ on
// firmware 13.0.5.14 did when its web API was read: the same paths, the same shapes, the same codes
// (HTTP 403 for a stale session, respCode 12001 for a wrong password). Serial number and MAC are made up.

const ctx: DriverContext = { log: () => undefined };
const base = STARTER_TEMPLATES[0]!.model;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await wait(10);
  }
}

const closers: (() => void)[] = [];
const drivers: DeviceDriver[] = [];
afterEach(() => {
  drivers.splice(0).forEach((d) => d.close());
  closers.splice(0).forEach((c) => c());
});

const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD3lGvhfWBLkG1/
BM8PmF0uDHthC7dTGD0m+Ostv++dApSRP05kc9ETmH5IL/LIHXGbVY92eSTbuLV2
nqV7Z3AUAuEeXyrJ1FlEv51UhhRYQ92gUxIaeE8/pO4n6wdfif3kegwTguIuZhw1
fnmeA1wjcZHpBC/zOKe8g2IzioDuyfaQN3skeH6uKLhXHgdERRZGjT9fIJFvmIJ0
YzJ3Yg/68HtkQiRDj9vupjuhdRGH7gT/ICqdGp/Z8feXQ1Tu5ORkPMPTRi6K4rhn
oBl5Bu2bz+YhM/nlMJqMoHZ/TqNdCNqBE//kZ/eZZpG9zdynfBqhOFO85/EMmK8O
3knUWO5RAgMBAAECgf8cxWLEEY3fOil/WU+2wD4T2996p6HmRirVHJg3+NYfqO0a
9ABoLA1f+ZizSt8r4kARjR/e5LUj05NC9azFan/b03nVzblrOwIkux/NcsdqeniG
6SBxcwnCm6gRe36f26llo8lDezJNshAVJ116v2k1tTz/lzz7Rto3Tg1bb/0LwrIf
qa2rZxDhDsUJcwWKR9S8TjBWse6lsgCuCdCf1eZ5DOWaAq/QVr4W5BHsvxQ1PANI
uNkuGM/etP0Hg+9a2+jlVLk7dbw7cncPS4K20e3WU1oJYNn3Fxb69NGf9PJDuhbn
IutYJH57KLnPy0L1/3pu4ydHzxhjJLPCuoG8H7ECgYEA/1bjfUlD1ew6VhVF5Mfx
FUDDnAfkNrlg1kafnH6PFNNwEGCiCcs+rfXZwVAAiamXFn3cTETSijNUnEAaze2f
Lv7w2Q6YvA2VSk/pyfqe6qwInpVKBeEA5CLc1gZYmUXWDela0jv9Zd5RuZatEXqg
4wnI2QrXMx9jeFtUsUmPdhkCgYEA+DhkwOmRSdQ6jHfkidY7TC181+HqbUdn3JSr
94ep5SOfqBfIpamTYjgwNxBYiELnUU3DzfoY0z8w3Iia2d55Nm37SwfwamHq7PU0
oSnQMOlI4Xi5b/wVbKnnxn8xqYe5bvi83BNyafGyQdDoOv+ZDSi6BzwRz5loEvSr
3bKJkPkCgYEAiizx9FWWcQhh1T2z0gdk7hRbBm+6zuZogew76YsPULzO0v4IEfa7
l5YIXbU2ZUix60j20wsXSBRZACksmC2zy9HIch2VB4buOAWgxV1rbCDmlTLCmQXW
3p4DFYrfnSoOmP6j2EsAaITzgtQIGgJbWCFuYA2ewRqGUJZT8ZCWItkCgYEAlQ5w
WnQn/hjG6/FXOPp/81fhf1Y3y1W05f4VYniCKoqA5pUZtXmmerXZJkfXkkPy2p0D
Nx63Z6ursNMLgkeZrHjRDZZ/5bJVO+RnrVwJnEWKsXMokDnlt7Iz77wT24UYcq5F
4zZ+X2Z3sBQ+UKeKhh9tzshgvbSWjcOFrYT4HSkCgYEA9rah0LI4NeU3pR4/lq47
Kb2JaisfR/QzUwNyS1XaslW+p7RUaaDXxZCpnT4KeGr9bY/5cTRDMi92Lczel1fW
7A1UNhhXvcCDqeZqRnZ7g6q/c2PMoocuvxuEP1fu/ncHHZySc2RvR7d1n/Rc+vzq
js9tlRPWAI5MJo4zba+xEAc=
-----END PRIVATE KEY-----`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIDCzCCAfOgAwIBAgIUFgBtEopUKBbtXnJRvTgdE1EoFV4wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAwNTExNDA1NFoYDzIxMjYw
OTExMTE0MDU0WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQD3lGvhfWBLkG1/BM8PmF0uDHthC7dTGD0m+Ostv++d
ApSRP05kc9ETmH5IL/LIHXGbVY92eSTbuLV2nqV7Z3AUAuEeXyrJ1FlEv51UhhRY
Q92gUxIaeE8/pO4n6wdfif3kegwTguIuZhw1fnmeA1wjcZHpBC/zOKe8g2IzioDu
yfaQN3skeH6uKLhXHgdERRZGjT9fIJFvmIJ0YzJ3Yg/68HtkQiRDj9vupjuhdRGH
7gT/ICqdGp/Z8feXQ1Tu5ORkPMPTRi6K4rhnoBl5Bu2bz+YhM/nlMJqMoHZ/TqNd
CNqBE//kZ/eZZpG9zdynfBqhOFO85/EMmK8O3knUWO5RAgMBAAGjUzBRMB0GA1Ud
DgQWBBS/WDCfLAVEhK+RiOf4AWzXAlOscjAfBgNVHSMEGDAWgBS/WDCfLAVEhK+R
iOf4AWzXAlOscjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAO
px2qP6EU2FETh/g32xc1RkYSGcIUeEoV8PdZp/l7QFaGDlQwVtruCF9cEe/l0CWF
opyiMoAheS5IrLVFSaqXDBHx8SmatymojeE0g2OdgodfwiNJREs8zpps+oIbLdFS
thx31GX8aKXCMj1+8lm5f4+S96xBl5iKQP9eu2qXMNLME81zyuDEck0GZ2rCG5hc
TsrJBUgDcAy1K7FryVTA1QULr01wCDapi2IsbXJEcSA487uSfvZP4W5/Okz3kSAF
QC1RyBfZgGRqi2E287zXsgItssQO6nsWc/4CRunhC4TUKAiPZHWBFWj8veZgzOTe
un5r+n/88vEc+pUrYBt9
-----END CERTIFICATE-----`;

const ok = { respCode: 0, respMsg: 'Success', status: 'success' };

/** Ports 0/2, 0/3, 0/4, 0/10, 0/13, 0/18 and the uplink 0/26 are up; PoE is delivering on 10 (3.3 W) and 18 (5.5 W). */
const UP = new Set([2, 3, 4, 10, 13, 26]);
const POWERED: Record<number, [number, number]> = { 10: [3300, 1], 18: [5500, 4] };
UP.add(18);

const portsStatus = () => ({
  switchPortStatus: {
    total: 32,
    rows: [
      ...Array.from({ length: 30 }, (_, i) => {
        const n = i + 1;
        return {
          port: String(n),
          portNum: n,
          portStr: `0/${n}`,
          unit: 1,
          adminState: 1,
          description: n === 26 ? 'UPLINK' : '',
          // 0 is up and 1 is down on this switch.
          linkState: UP.has(n) ? 0 : 1,
          physicalStatus: UP.has(n) ? (n === 3 || n === 10 || n === 13 ? '100 Full' : '1000 Full') : '',
        };
      }),
      { port: 'lag 1', portNum: 0, portStr: 'lag 1', unit: 1, adminState: 1, description: '', linkState: 1, physicalStatus: '' },
    ],
  },
  resp: ok,
});
const poePorts = () => ({
  poePortConfig: Array.from({ length: 24 }, (_, i) => {
    const n = i + 1;
    const p = POWERED[n];
    return {
      unit: 1,
      portNum: n,
      port: String(n),
      enable: true,
      classification: p ? p[1] : 0,
      currentPower: p ? p[0] : 0,
      powerLimit: 32000,
      status: p ? 2 : 1,
    };
  }),
  resp: ok,
});
const deviceInfo = () => ({
  deviceInfo: {
    name: '',
    mac: '00:11:22:33:44:55',
    poe: true,
    units: 1,
    details: [
      {
        unit: 1,
        model: 'M4250-26G4F-PoE+',
        fwVer: '13.0.5.14',
        bootVer: '1.0.0.12',
        sn: 'TESTSERIAL0001',
        upTime: '172 days, 14 hrs, 9 mins, 32 secs',
      },
    ],
    fan: [{ unit: 1, details: [{ id: 1, desc: 'FAN-1', speed: 2500, state: 0 }] }],
    sensor: [
      {
        unit: 1,
        details: [
          { id: 1, desc: 'sensor-1', temp: 27, maxTemp: 62, state: 2 },
          { id: 2, desc: 'sensor-2', temp: 58, maxTemp: 62, state: 2 },
        ],
      },
    ],
    cpu: [{ unit: 1, usage: '1.92%' }],
    memory: [{ unit: 1, usage: '51.05%' }],
  },
  resp: ok,
});

async function fakeSwitch(opts: { password?: string } = {}) {
  const password = opts.password ?? 'secret';
  const seen = {
    logins: 0,
    logouts: 0,
    resets: [] as unknown[],
    sessions: [] as (string | undefined)[],
  };
  let current = 'tok-1';
  const server: Server = createHttps({ key: KEY, cert: CERT }, (req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const json = (data: unknown, status = 200) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(data));
      };
      const url = req.url ?? '';
      if (req.method === 'POST' && url === '/api/v1/login') {
        seen.logins++;
        const u = (JSON.parse(body) as { user?: { name?: string; password?: string } }).user;
        if (u?.name !== 'admin' || u?.password !== password)
          return json({ resp: { respCode: 12001, respMsg: 'User name or password is incorrect', status: 'fail' } });
        return json({ user: { session: current }, resp: ok });
      }
      seen.sessions.push(req.headers.session as string | undefined);
      if (req.headers.session !== current) return json({}, 403);
      if (url === '/api/v1/logout') {
        seen.logouts++;
        return json({ resp: ok });
      }
      if (url === '/api/v1/device_info') return json(deviceInfo());
      if (url === '/api/v1/swcfg_poe_info')
        return json({ poeInfo: [{ unit: 1, consumedPower: 17400, totalPowerAvailable: 300000, thresholdPower: 270000 }], resp: ok });
      if (url.startsWith('/api/v1/swcfg_ports_status')) return json(portsStatus());
      if (url.startsWith('/api/v1/swcfg_poe?')) return json(poePorts());
      if (req.method === 'POST' && url === '/api/v1/swcfg_poe_reset') {
        seen.resets.push(JSON.parse(body));
        return json({ resp: ok });
      }
      // Paths the switch has no handler for answer a bare 500.
      res.statusCode = 500;
      res.end('<h1>500 Internal Server Error</h1>');
    });
  });
  closers.push(() => server.close());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    seen,
    expireSession: () => (current = 'tok-2'),
  };
}

function start(settings: Record<string, unknown>, points: Device['points'] = []) {
  const device: Device = {
    ...base.devices.find((d) => d.id === 'display1')!,
    category: 'control_processor',
    control: { kind: 'driver', driverId: 'netgear-av' },
    settings,
    points,
  };
  const driver = createDriver(device, ctx)!;
  drivers.push(driver);
  driver.start();
  return driver;
}

const settings = (port: number, extra: Record<string, unknown> = {}) => ({
  host: '127.0.0.1',
  port,
  username: 'admin',
  password: 'secret',
  timeoutMs: 1500,
  ...extra,
});

describe('Netgear AV switch driver', () => {
  it('signs in once, reads the switch with the session header, and reports identity, ports and PoE', async () => {
    const sw = await fakeSwitch();
    const d = start(settings(sw.port));
    await until(() => !!d.getState().details);
    expect(sw.seen.logins).toBe(1);
    expect(sw.seen.sessions.every((s) => s === 'tok-1')).toBe(true);
    expect(d.getState().online).toBe(true);
    expect(d.getState().firmware).toBe('13.0.5.14');

    const details = d.getState().details!;
    expect(details.find((s) => s.title === 'Identity')!.rows).toEqual([
      { label: 'Model', value: 'M4250-26G4F-PoE+' },
      { label: 'Serial number', value: 'TESTSERIAL0001' },
      { label: 'MAC address', value: '00:11:22:33:44:55' },
    ]);
    const system = details.find((s) => s.title === 'System')!.rows;
    expect(system.find((r) => r.label === 'Ports up')?.value).toBe('7 of 30');
    expect(system.find((r) => r.label === 'Temperature 1')).toMatchObject({ value: '27 °C (limit 62)', status: 'ok' });
    // 58 of 62 is within 10% of the limit.
    expect(system.find((r) => r.label === 'Temperature 2')?.status).toBe('warning');

    // The LAG row is not a port; the uplink keeps its name; PoE draw sits beside its port.
    const ports = details.find((s) => s.title === 'Ports')!.table!.rows;
    expect(ports).toHaveLength(30);
    expect(ports[25]!.cells).toEqual(['0/26', 'UPLINK', 'Up', '1000 Full', '']);
    expect(ports[9]!.cells).toEqual(['0/10', '', 'Up', '100 Full', '3.3 W']);
    expect(ports[0]!.cells).toEqual(['0/1', '', 'Down', '', '']);

    const poe = details.find((s) => s.title === 'PoE')!;
    expect(poe.rows).toEqual([
      { label: 'PoE budget', value: '300 W' },
      { label: 'PoE in use', value: '17.4 W', status: 'ok' },
    ]);
    expect(poe.table!.rows[9]!.cells).toEqual(['10', 'Yes', 'Delivering power', '3.3 W', 'Class 1']);
    expect(poe.table!.rows[0]!.cells).toEqual(['1', 'Yes', 'Nothing powered', '', '']);
  });

  it('reads watched points: a port’s link, a port’s PoE draw, and whole-switch readings', async () => {
    const sw = await fakeSwitch();
    const d = start(settings(sw.port), [
      { id: 'up', name: 'Uplink', type: 'generic', address: { port: '26', field: 'link' } },
      { id: 'down', name: 'Port 5', type: 'generic', address: { port: '5', field: 'link' } },
      { id: 'w', name: 'PoE 18', type: 'generic', address: { port: '18', field: 'poeWatts' } },
      { id: 'p', name: 'PoE 10', type: 'generic', address: { port: '10', field: 'poe' } },
      { id: 't', name: 'Hottest', type: 'generic', address: { field: 'temp' } },
      { id: 'u', name: 'PoE used', type: 'generic', address: { field: 'poeUsedWatts' } },
      { id: 'c', name: 'CPU', type: 'generic', address: { field: 'cpu' } },
      { id: 'x', name: 'Nonsense', type: 'generic', address: { port: '99', field: 'link' } },
    ] as never);
    await until(() => Object.keys(d.getState().points ?? {}).length >= 7);
    expect(d.getState().points).toEqual({ up: true, down: false, w: 5.5, p: true, t: 58, u: 17.4, c: 1.92 });
    await expect(d.readPoint!({ type: 'generic', address: { port: '26', field: 'link' } })).resolves.toEqual({ value: true });
    await expect(d.readPoint!({ type: 'generic', address: { port: '99', field: 'link' } })).rejects.toThrow();
  });

  it('signs in again when the switch says the session is stale', async () => {
    const sw = await fakeSwitch();
    const d = start(settings(sw.port, { pollMs: 200 }));
    await until(() => d.getState().online);
    sw.expireSession();
    await until(() => sw.seen.logins === 2);
    await until(() => sw.seen.sessions.includes('tok-2'));
    expect(d.getState().online).toBe(true);
  });

  it('power-cycles a PoE port with the list of port numbers the switch’s own page sends', async () => {
    const sw = await fakeSwitch();
    const d = start(settings(sw.port));
    await until(() => d.getState().online);
    await d.send({ type: 'command', name: 'poe_cycle_18', args: {} });
    expect(sw.seen.resets).toEqual([{ poePortConfig: { portId: [18] } }]);
    await expect(d.send({ type: 'command', name: 'reboot', args: {} })).rejects.toThrow(/does not support/);
    await expect(d.send({ type: 'power', on: false })).rejects.toThrow(/does not support/);
    expect(sw.seen.resets).toHaveLength(1);
  });

  it('is offline with the wrong password, and does not keep trying one that was refused', async () => {
    const sw = await fakeSwitch();
    const d = start(settings(sw.port, { password: 'wrong', pollMs: 100 }));
    await wait(700);
    expect(d.getState().online).toBe(false);
    // Several polls have come and gone: one login attempt only, so the account is not locked out.
    expect(sw.seen.logins).toBe(1);
  });

  it('signs out when it stops, so no session is left on the switch', async () => {
    const sw = await fakeSwitch();
    const d = start(settings(sw.port));
    await until(() => d.getState().online);
    d.close();
    await until(() => sw.seen.logouts === 1);
  });

  it('is offline when nothing answers', async () => {
    const d = start(settings(1, { timeoutMs: 300 }));
    await wait(500);
    expect(d.getState().online).toBe(false);
  });
});
