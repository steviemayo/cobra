import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, type Device } from '@kestrel/model';
import { answerChallenge, eachElement, inner, securityHeader } from './onvif';
import { createDriver } from './registry';
import type { DeviceDriver, DriverContext } from './types';

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

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
const CLOCK_OFFSET = 3_600_000; // the camera's clock is an hour ahead of ours

/** A camera that checks the WS-Security digest and the HTTP digest the way the standards say. */
async function camera(opts: { password?: string; snapshot?: Buffer | string } = {}) {
  const password = opts.password ?? 'secret';
  const seen = { created: [] as string[], goto: [] as string[], moves: [] as string[], stops: 0, snapshotHost: [] as string[] };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/snapshot.jpg') {
        seen.snapshotHost.push(String(req.headers.host));
        const auth = req.headers.authorization;
        if (!auth) {
          res.statusCode = 401;
          res.setHeader('www-authenticate', 'Digest realm="cam", nonce="n0nce", qop="auth"');
          return res.end();
        }
        // The expected response, worked out independently of the driver's own code.
        const f = (n: string) => new RegExp(`${n}="?([^",]+)"?`).exec(auth)![1]!;
        const md5 = (s: string) => createHash('md5').update(s).digest('hex');
        const ha1 = md5(`admin:cam:${password}`);
        const ha2 = md5('GET:/snapshot.jpg');
        const want = md5(`${ha1}:n0nce:${f('nc')}:${f('cnonce')}:auth:${ha2}`);
        if (f('response') !== want) {
          res.statusCode = 401;
          return res.end();
        }
        res.setHeader('content-type', typeof opts.snapshot === 'string' ? 'text/html' : 'image/jpeg');
        return res.end(opts.snapshot ?? JPEG);
      }
      const reply = (inside: string, status = 200) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/soap+xml');
        res.end(
          `<?xml version="1.0"?><env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body>${inside}</env:Body></env:Envelope>`,
        );
      };
      const op = /<(?:\w+:)?(Get\w+|GotoPreset|ContinuousMove|Stop)\b/.exec(body.replace(/<\?xml[^>]*>/, ''))?.[1];
      if (op === 'GetSystemDateAndTime') {
        const d = new Date(Date.now() + CLOCK_OFFSET);
        return reply(
          `<tds:GetSystemDateAndTimeResponse xmlns:tds="x" xmlns:tt="y"><tds:SystemDateAndTime><tt:UTCDateTime><tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`,
        );
      }
      // Everything else needs the login.
      const created = /<Created[^>]*>([^<]+)</.exec(body)?.[1] ?? '';
      const nonce = /<Nonce[^>]*>([^<]+)</.exec(body)?.[1] ?? '';
      const digest = /<Password[^>]*>([^<]+)</.exec(body)?.[1] ?? '';
      const want = createHash('sha1')
        .update(Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created + password)]))
        .digest('base64');
      if (digest !== want)
        return reply('<env:Fault><env:Code><env:Value>env:Sender</env:Value><env:Subcode><env:Value>ter:NotAuthorized</env:Value></env:Subcode></env:Code><env:Reason><env:Text>Sender not authorized</env:Text></env:Reason></env:Fault>', 400);
      seen.created.push(created);
      if (op === 'GetDeviceInformation')
        return reply(
          '<tds:GetDeviceInformationResponse xmlns:tds="x"><tds:Manufacturer>ACME</tds:Manufacturer><tds:Model>PTZ-100</tds:Model><tds:FirmwareVersion>2.1.0</tds:FirmwareVersion><tds:SerialNumber>SN9</tds:SerialNumber><tds:HardwareId>1</tds:HardwareId></tds:GetDeviceInformationResponse>',
        );
      if (op === 'GetCapabilities')
        return reply(
          '<tds:GetCapabilitiesResponse xmlns:tds="x" xmlns:tt="y"><tds:Capabilities><tt:Device><tt:XAddr>http://10.9.9.9/onvif/device_service</tt:XAddr></tt:Device><tt:Media><tt:XAddr>http://10.9.9.9/onvif/media_service</tt:XAddr></tt:Media><tt:PTZ><tt:XAddr>http://10.9.9.9/onvif/ptz_service</tt:XAddr></tt:PTZ></tds:Capabilities></tds:GetCapabilitiesResponse>',
        );
      if (op === 'GetProfiles')
        return reply(
          '<trt:GetProfilesResponse xmlns:trt="m" xmlns:tt="y"><trt:Profiles token="prof1" fixed="true"><tt:Name>main</tt:Name></trt:Profiles><trt:Profiles token="prof2"><tt:Name>sub</tt:Name></trt:Profiles></trt:GetProfilesResponse>',
        );
      if (op === 'GetPresets')
        return reply(
          '<tptz:GetPresetsResponse xmlns:tptz="p" xmlns:tt="y"><tptz:Preset token="1"><tt:Name>Wide</tt:Name></tptz:Preset><tptz:Preset token="2"><tt:Name>Podium</tt:Name></tptz:Preset></tptz:GetPresetsResponse>',
        );
      if (op === 'GotoPreset') {
        seen.goto.push(/<PresetToken>([^<]+)</.exec(body)?.[1] ?? '');
        return reply('<tptz:GotoPresetResponse xmlns:tptz="p"/>');
      }
      if (op === 'ContinuousMove') {
        seen.moves.push(`${/PanTilt x="([^"]+)" y="([^"]+)"/.exec(body)!.slice(1).join(',')}|${/Zoom x="([^"]+)"/.exec(body)![1]}`);
        return reply('<tptz:ContinuousMoveResponse xmlns:tptz="p"/>');
      }
      if (op === 'Stop') {
        seen.stops++;
        return reply('<tptz:StopResponse xmlns:tptz="p"/>');
      }
      if (op === 'GetSnapshotUri')
        return reply('<trt:GetSnapshotUriResponse xmlns:trt="m" xmlns:tt="y"><trt:MediaUri><tt:Uri>http://10.9.9.9/snapshot.jpg</tt:Uri></trt:MediaUri></trt:GetSnapshotUriResponse>');
      reply('<env:Fault><env:Reason><env:Text>unsupported</env:Text></env:Reason></env:Fault>', 400);
    });
  });
  closers.push(() => server.close());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as { port: number }).port, seen };
}

function start(settings: Record<string, unknown>) {
  const device: Device = {
    ...base.devices.find((d) => d.id === 'display1')!,
    category: 'ptz_camera',
    control: { kind: 'driver', driverId: 'onvif' },
    settings,
  };
  const driver = createDriver(device, ctx)!;
  drivers.push(driver);
  driver.start();
  return driver;
}

describe('ONVIF helpers', () => {
  it('reads elements whatever namespace prefix the camera uses', () => {
    const xml = '<a:Env><x:Model>ACME &amp; Co</x:Model><Preset token="1"><N>One</N></Preset><q:Preset token="2"><N>Two</N></q:Preset></a:Env>';
    expect(inner(xml, 'Model')).toBe('ACME & Co');
    expect(eachElement(xml, 'Preset').map((p) => p.attrs.trim())).toEqual(['token="1"', 'token="2"']);
  });

  it('builds the WS-Security password digest: Base64(SHA-1(nonce + created + password))', () => {
    // The worked example from the WS-Security UsernameToken profile.
    const nonce = Buffer.from('LKqI6G/AikKCQrN0zqZFlg==', 'base64');
    const header = securityHeader('user', 'userpassword', '2010-09-16T07:50:45Z', nonce);
    expect(header).toContain('<Username>user</Username>');
    expect(header).toContain('>tuOSpGlFlIXsozq4HFNeeGeFLEI=<');
  });

  it('answers a Digest challenge with the RFC 2617 response', () => {
    // The worked example from RFC 2617 section 3.5.
    const h = answerChallenge(
      'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
      'Mufasa',
      'Circle Of Life',
      'GET',
      '/dir/index.html',
      '0a4f113b',
    )!;
    expect(h).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(answerChallenge('Basic realm="x"', 'a', 'b', 'GET', '/')).toBe('Basic YTpi');
    expect(answerChallenge('Bearer x', 'a', 'b', 'GET', '/')).toBeUndefined();
  });
});

describe('ONVIF camera driver', () => {
  const settings = (port: number, extra: Record<string, unknown> = {}) => ({
    host: '127.0.0.1',
    port,
    username: 'admin',
    password: 'secret',
    timeoutMs: 1500,
    ...extra,
  });

  it('reports identity and presets, signing with the camera’s own clock', async () => {
    const cam = await camera();
    const d = start(settings(cam.port));
    await until(() => d.getState().online);
    await until(() => !!d.getState().details?.find((s) => s.title === 'Presets'));
    expect(d.getState().firmware).toBe('2.1.0');
    const details = d.getState().details!;
    expect(details[0]!.rows).toEqual([
      { label: 'Model', value: 'PTZ-100' },
      { label: 'Serial number', value: 'SN9' },
      { label: 'Manufacturer', value: 'ACME' },
    ]);
    expect(details.find((s) => s.title === 'Presets')!.rows.map((r) => r.label)).toEqual(['Wide', 'Podium']);
    // The camera's clock is an hour ahead: the digest must carry its time, not ours.
    const t = Date.parse(cam.seen.created[0]!);
    expect(Math.abs(t - (Date.now() + CLOCK_OFFSET))).toBeLessThan(5000);
  });

  it('recalls a preset by name and moves the camera, then stops', async () => {
    const cam = await camera();
    const d = start(settings(cam.port));
    await until(() => d.getState().online);
    await d.send({ type: 'camera_preset', name: 'podium' });
    expect(cam.seen.goto).toEqual(['2']);
    await expect(d.send({ type: 'camera_preset', name: 'Nowhere' })).rejects.toThrow(/no preset/);
    await d.send({ type: 'camera_move', pan: 1, tilt: -1, zoom: 0 });
    expect(cam.seen.moves).toEqual(['0.5,-0.5|0']);
    await d.send({ type: 'camera_move', pan: 0, tilt: 0, zoom: 0 });
    expect(cam.seen.stops).toBe(1);
  });

  it('fetches a JPEG snapshot through HTTP digest, on the address the device was added with', async () => {
    const cam = await camera();
    const d = start(settings(cam.port));
    await until(() => d.getState().online);
    const shot = await d.snapshot!();
    expect(shot.contentType).toBe('image/jpeg');
    expect([...shot.bytes]).toEqual([...JPEG]);
    // The camera claimed 10.9.9.9; the request went to the configured host.
    expect(cam.seen.snapshotHost.every((h) => h.startsWith('127.0.0.1'))).toBe(true);
  });

  it('refuses something that is not a picture', async () => {
    const cam = await camera({ snapshot: '<html>log in</html>' });
    const d = start(settings(cam.port));
    await until(() => d.getState().online);
    await expect(d.snapshot!()).rejects.toThrow(/JPEG/);
  });

  it('is offline with the wrong password', async () => {
    const cam = await camera();
    const d = start(settings(cam.port, { password: 'wrong' }));
    await wait(400);
    expect(d.getState().online).toBe(false);
    await expect(d.snapshot!()).rejects.toThrow();
  });
});
