import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { DRIVER_CLASSES, STARTER_TEMPLATES, type Device } from '@kestrel/model';
import { BluesoundDriver, attrs, tag, xmlText } from './bluesound';
import { BUILT_IN_DRIVER_IDS, createDriver } from './registry';
import { WiimDriver, decodeHex } from './wiim';
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

const servers: http.Server[] = [];
const drivers: DeviceDriver[] = [];
afterEach(() => {
  drivers.splice(0).forEach((d) => d.close());
  servers.splice(0).forEach((s) => s.close());
});

/** A fake player: `answer` returns the body for a URL, or a status code for an error. */
async function fakePlayer(answer: (url: string) => string | number) {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? '');
    const a = answer(req.url ?? '');
    if (typeof a === 'number') {
      res.statusCode = a;
      res.end();
    } else res.end(a);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { seen, port: (server.address() as { port: number }).port };
}

const device = (driverId: string, settings: Record<string, unknown>): Device => ({
  ...base.devices[0]!,
  category: 'music_player',
  ports: [],
  control: { kind: 'driver', driverId },
  settings: { host: '127.0.0.1', pollMs: 50, timeoutMs: 500, ...settings },
});

const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex');

describe('music player class', () => {
  it('is registered: both drivers are built in and the class covers the category', () => {
    expect(BUILT_IN_DRIVER_IDS).toEqual(expect.arrayContaining(['wiim', 'bluesound']));
    expect(DRIVER_CLASSES.music_player.categories).toEqual(['music_player']);
    expect(createDriver(device('wiim', {}), ctx)).toBeInstanceOf(WiimDriver);
    expect(createDriver(device('bluesound', {}), ctx)).toBeInstanceOf(BluesoundDriver);
  });
});

describe('WiiM driver', () => {
  const player = (playing = true) =>
    fakePlayer((url) => {
      if (url.includes('getPlayerStatus'))
        return JSON.stringify({
          status: playing ? 'play' : 'stop',
          mode: '31',
          vol: '45',
          mute: '0',
          Title: hex('Café del Mar'),
          Artist: hex('Energy 52'),
          Album: hex('Singles'),
        });
      if (url.includes('getMetaInfo'))
        return JSON.stringify({ metaData: { sampleRate: '44100', bitDepth: '16' } });
      if (url.includes('getStatusEx'))
        return JSON.stringify({
          DeviceName: 'Lobby WiiM',
          project: 'WiiM_Pro_with_gc4a',
          firmware: 'Linkplay.4.8.1',
          MAC: 'AA:BB:CC:DD:EE:FF',
          RSSI: '-52',
          ssid: 'secret-network',
          uuid: 'abc',
        });
      return 404;
    });

  it('reads status, source, volume and the track, and the player’s identity', async () => {
    const p = await player();
    const d = new WiimDriver(device('wiim', { protocol: 'http', port: p.port }), ctx);
    drivers.push(d);
    d.start();
    await until(() => d.getState().online && !!d.getState().details?.length);
    const s = d.getState();
    expect(s).toMatchObject({
      playback: 'playing',
      playSource: 'Spotify Connect',
      volume: 45,
      muted: false,
      firmware: 'Linkplay.4.8.1',
    });
    const [now, info] = s.details!;
    expect(now).toMatchObject({ title: 'Now playing' });
    expect(now!.rows).toEqual(
      expect.arrayContaining([
        { label: 'Title', value: 'Café del Mar' },
        { label: 'Artist', value: 'Energy 52' },
        { label: 'Album', value: 'Singles' },
        { label: 'Quality', value: '44.1 kHz / 16 bit' },
      ]),
    );
    expect(info!.rows).toEqual(
      expect.arrayContaining([
        { label: 'Name', value: 'Lobby WiiM' },
        { label: 'Model', value: 'WiiM_Pro_with_gc4a' },
      ]),
    );
    // Only named fields are shown: the Wi-Fi network name never is.
    expect(JSON.stringify(s.details)).not.toContain('secret-network');
  });

  it('shows no track while stopped', async () => {
    const p = await player(false);
    const d = new WiimDriver(device('wiim', { protocol: 'http', port: p.port }), ctx);
    drivers.push(d);
    d.start();
    await until(() => d.getState().playback === 'stopped');
    const rows = d.getState().details![0]!.rows.map((r) => r.label);
    expect(rows).not.toContain('Title');
  });

  it('goes offline when the player stops answering, and never sends anything', async () => {
    const p = await fakePlayer(() => 500);
    const d = new WiimDriver(device('wiim', { protocol: 'http', port: p.port }), ctx);
    drivers.push(d);
    d.start();
    await until(() => p.seen.length > 0);
    expect(d.getState().online).toBe(false);
    await expect(d.send({ type: 'power', on: true })).rejects.toThrow('monitoring only');
  });

  it('decodes hex text and leaves anything else as written', () => {
    expect(decodeHex(hex('Björk'))).toBe('Björk');
    expect(decodeHex('Not hex!')).toBe('Not hex!');
    expect(decodeHex('')).toBeUndefined();
  });
});

describe('Bluesound driver', () => {
  const STATUS = `<?xml version="1.0"?><status etag="x"><album>Kind of Blue</album><artist>Miles Davis</artist>
    <name>So What</name><state>stream</state><service>Tidal</service><serviceName>TIDAL</serviceName>
    <streamFormat>FLAC 44100/16/2</streamFormat><volume>30</volume><mute>1</mute><title1>So What</title1>
    <title2>Miles Davis &amp; Co</title2><title3>Kind of Blue</title3></status>`;
  const SYNC = `<SyncStatus name="Bar B400S" brand="Bluesound" modelName="B400S" model="B400S" mac="90:56:82:AA:BB:CC" version="4.16.22" schemaVersion="34" id="10.0.0.5:11000"><slave id="10.0.0.6"/></SyncStatus>`;

  it('reads state, service, volume, mute, the track and the player’s identity', async () => {
    const p = await fakePlayer((url) => (url === '/Status' ? STATUS : url === '/SyncStatus' ? SYNC : 404));
    const d = new BluesoundDriver(device('bluesound', { port: p.port }), ctx);
    drivers.push(d);
    d.start();
    await until(() => d.getState().online && (d.getState().details?.length ?? 0) > 1);
    const s = d.getState();
    expect(s).toMatchObject({ playback: 'playing', playSource: 'TIDAL', volume: 30, muted: true, firmware: '4.16.22' });
    const [now, info] = s.details!;
    expect(now!.rows).toEqual(
      expect.arrayContaining([
        { label: 'Title', value: 'So What' },
        { label: 'Artist', value: 'Miles Davis & Co' },
        { label: 'Album', value: 'Kind of Blue' },
        { label: 'Quality', value: 'FLAC 44100/16/2' },
      ]),
    );
    expect(info!.rows).toEqual(
      expect.arrayContaining([
        { label: 'Name', value: 'Bar B400S' },
        { label: 'Model', value: 'B400S' },
        { label: 'Group', value: 'Leads 1 other player' },
      ]),
    );
  });

  it('still reports when /SyncStatus is not answered', async () => {
    const p = await fakePlayer((url) => (url === '/Status' ? STATUS : 404));
    const d = new BluesoundDriver(device('bluesound', { port: p.port }), ctx);
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    expect(d.getState().playback).toBe('playing');
    expect(d.getState().details).toHaveLength(1);
  });

  it('treats a reply that is not a BluOS status as offline', async () => {
    const p = await fakePlayer(() => '<html>hello</html>');
    const d = new BluesoundDriver(device('bluesound', { port: p.port }), ctx);
    drivers.push(d);
    d.start();
    await until(() => p.seen.length > 0);
    expect(d.getState().online).toBe(false);
  });

  it('parses XML text and attributes', () => {
    expect(xmlText('<![CDATA[A &amp; B]]>')).toBe('A &amp; B'.replace('&amp;', '&'));
    expect(xmlText('Caf&#233; &lt;3')).toBe('Café <3');
    expect(tag('<a><title1>x</title1></a>', 'title1')).toBe('x');
    expect(tag('<a><title1></title1></a>', 'title1')).toBeUndefined();
    expect(attrs('<SyncStatus name="A &amp; B" mac="1"/>', 'SyncStatus')).toEqual({ name: 'A & B', mac: '1' });
  });
});
