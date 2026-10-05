import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer as createHttps } from 'node:https';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, bytesToHex, type Device } from '@kestrel/model';
import { createDriver } from './registry';
import type { DeviceDriver, DriverContext } from './types';

// The bundled displays and microphones, run against fake devices that answer the way each vendor's
// published protocol says. Byte examples that come straight from the vendors' documents are marked.

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

function start(category: Device['category'], driverId: string, settings: Record<string, unknown>) {
  const device: Device = {
    ...base.devices.find((d) => d.id === 'display1')!,
    category,
    control: { kind: 'driver', driverId },
    settings,
  };
  const driver = createDriver(device, ctx)!;
  drivers.push(driver);
  driver.start();
  return driver;
}

/**
 * A TCP device that records each frame it gets as hex pairs and answers with `reply(hex)`. Frames are
 * cut out of the stream by `size`, since a real device reads a stream, not packets.
 */
async function binaryDevice(
  size: (bytes: number[]) => number,
  reply: (hex: string) => string | null = () => null,
) {
  const received: string[] = [];
  const server: Server = createServer((socket: Socket) => {
    socket.on('error', () => undefined);
    let pending: number[] = [];
    socket.on('data', (chunk: Buffer) => {
      pending.push(...chunk);
      for (;;) {
        const n = size(pending);
        if (n <= 0 || pending.length < n) break;
        const hex = bytesToHex(pending.slice(0, n));
        pending = pending.slice(n);
        received.push(hex);
        const out = reply(hex);
        if (out) socket.write(Buffer.from(out.replace(/\s+/g, ''), 'hex'));
      }
    });
  });
  closers.push(() => server.close());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as { port: number }).port, received };
}
/** Samsung MDC: AA, command, id, length, data, check. */
const mdcSize = (b: number[]) => (b.length < 4 ? 0 : 5 + b[3]!);
/** Philips SICP: the first byte is the size of the whole frame. */
const sicpSize = (b: number[]) => (b.length < 1 ? 0 : b[0]!);

// ---- Samsung MDC ---------------------------------------------------------------------------------

describe('Samsung MDC display', () => {
  const status = (power: string, mute: string) => {
    // AA FF id 09 41 00 power volume mute input aspect timer1 timer2 checksum
    const body = `FF FE 09 41 00 ${power} 32 ${mute} 21 10 00 00`;
    const sum = body
      .split(' ')
      .reduce((a, b) => (a + parseInt(b, 16)) & 0xff, 0)
      .toString(16)
      .padStart(2, '0');
    return `AA ${body} ${sum}`;
  };

  it('sends the frames Samsung documents, with the sum-of-bytes check byte', async () => {
    const dev = await binaryDevice(mdcSize, (hex) => (hex.startsWith('AA 11') ? 'AA FF FE 03 41 11 01 54' : null));
    const d = start('display', 'lib:samsung-mdc', { host: '127.0.0.1', port: dev.port, displayId: '00' });
    await until(() => d.getState().online);
    await d.send({ type: 'power', on: true });
    await d.send({ type: 'select_input', portId: 'in1' });
    await d.send({ type: 'volume', level: 50 });
    await d.send({ type: 'mute', muted: true });
    await until(() => dev.received.length >= 5);
    // From Samsung's reference: power on "AA 11 00 01 01 13", HDMI 1 "AA 14 00 01 21 36".
    expect(dev.received).toContain('AA 11 00 01 01 13');
    expect(dev.received).toContain('AA 14 00 01 21 36');
    expect(dev.received).toContain('AA 12 00 01 32 45');
    expect(dev.received).toContain('AA 13 00 01 01 15');
    expect(d.getState().selectedInput).toBe('in1');
  });

  it('reads power and mute from the status reply', async () => {
    const dev = await binaryDevice(mdcSize, (hex) => (hex.startsWith('AA 00') ? status('01', '01') : null));
    const d = start('display', 'lib:samsung-mdc', { host: '127.0.0.1', port: dev.port });
    await until(() => d.getState().power === 'on');
    expect(d.getState().muted).toBe(true);
  });

  it('refuses an input it has no code for rather than sending a short frame', async () => {
    const dev = await binaryDevice(mdcSize);
    const d = start('display', 'lib:samsung-mdc', { host: '127.0.0.1', port: dev.port });
    await until(() => d.getState().online || dev.received.length > 0);
    await expect(d.send({ type: 'select_input', portId: 'in9' })).rejects.toThrow(/no code/);
    expect(dev.received.some((r) => r.startsWith('AA 14'))).toBe(false);
  });
});

// ---- Philips SICP --------------------------------------------------------------------------------

describe('Philips SICP display', () => {
  it('sends the frames Philips documents, with the XOR check byte', async () => {
    const dev = await binaryDevice(sicpSize);
    const d = start('display', 'lib:philips-sicp', { host: '127.0.0.1', port: dev.port });
    await until(() => d.getState().online || dev.received.length > 0);
    await d.send({ type: 'power', on: true });
    await d.send({ type: 'power', on: false });
    await d.send({ type: 'select_input', portId: 'in1' });
    await d.send({ type: 'volume', level: 22 });
    await until(() => dev.received.length >= 5);
    // From the SICP specification: power off "06 01 00 18 01 1E", HDMI 1 "09 01 00 AC 0D 09 01 00 A1",
    // get power state "05 01 00 19 1D".
    expect(dev.received).toContain('06 01 00 18 02 1D');
    expect(dev.received).toContain('06 01 00 18 01 1E');
    expect(dev.received).toContain('09 01 00 AC 0D 09 01 00 A1');
    expect(dev.received).toContain('05 01 00 19 1D');
    // 22% is 0x16 on both outputs.
    expect(dev.received).toContain('07 01 00 44 16 16 42');
  });

  it('reads the power state report', async () => {
    const dev = await binaryDevice(sicpSize, (hex) => (hex.startsWith('05 01 00 19') ? '06 01 00 19 02 1C' : null));
    const d = start('display', 'lib:philips-sicp', { host: '127.0.0.1', port: dev.port });
    await until(() => d.getState().power === 'on');
  });
});

// ---- Sharp NEC -----------------------------------------------------------------------------------

describe('Sharp NEC display', () => {
  /** A display that takes one connection per message: a reply for power control and power status. */
  async function nec(power: '0001' | '0004') {
    const received: string[] = [];
    const server = createServer((socket) => {
      socket.on('error', () => undefined);
      socket.on('data', (chunk: Buffer) => {
        const text = chunk.toString('latin1');
        received.push(text);
        // SOH 0 0 <id> B <length> STX ... ETX <check> CR (the check byte is not read, so any will do).
        if (text.includes('C203D6'))
          socket.write(`00AB0E00C203D6${power} 
`);
        else if (text.includes('01D6'))
          socket.write(`00AB120200D600000 4${power} 
`.replace(' ', ''));
      });
    });
    closers.push(() => server.close());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { port: (server.address() as { port: number }).port, received };
  }

  it('builds the messages NEC documents, with the XOR check byte from after SOH to ETX', async () => {
    const dev = await nec('0001');
    const d = start('display', 'lib:sharp-nec', { host: '127.0.0.1', port: dev.port });
    await until(() => dev.received.length > 0);
    // Power status read: SOH 0 A 0 A 0 6 STX 01D6 ETX BCC CR, BCC = XOR of 30 41 30 41 30 36 02 30 31 44 36 03.
    const first = Buffer.from(dev.received[0]!, 'latin1');
    expect([...first].slice(0, 8)).toEqual([0x01, 0x30, 0x41, 0x30, 0x41, 0x30, 0x36, 0x02]);
    expect(first.subarray(8, 12).toString('latin1')).toBe('01D6');
    expect(first[12]).toBe(0x03);
    expect(first[14]).toBe(0x0d);
    const bcc = [...first.subarray(1, 13)].reduce((a, b) => a ^ b, 0);
    expect(first[13]).toBe(bcc);

    await d.send({ type: 'power', on: false });
    const off = Buffer.from(dev.received.find((r) => r.includes('C203D6'))!, 'latin1');
    expect(off.subarray(8, 18).toString('latin1')).toBe('C203D60004');
  });

  it('reads the power state from the status reply', async () => {
    const dev = await nec('0001');
    const d = start('display', 'lib:sharp-nec', { host: '127.0.0.1', port: dev.port });
    await until(() => d.getState().power === 'on');
  });

  it('sends volume as four ASCII hex digits', async () => {
    const dev = await nec('0001');
    const d = start('display', 'lib:sharp-nec', { host: '127.0.0.1', port: dev.port });
    await until(() => dev.received.length > 0);
    await d.send({ type: 'volume', level: 50 }).catch(() => undefined);
    const set = dev.received.find((r) => r.includes('0062') && r.includes('0032'));
    expect(set).toBeDefined();
    const buf = Buffer.from(set!, 'latin1');
    // Set parameter is type E with length 0A; value 50 is "0032".
    expect(buf.subarray(4, 7).toString('latin1')).toBe('E0A');
  });
});

// ---- Shure MXA -----------------------------------------------------------------------------------

describe('Shure MXA microphone', () => {
  async function shure() {
    let muted = false;
    const received: string[] = [];
    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('error', () => undefined);
      let buf = '';
      socket.on('data', (chunk: string) => {
        buf += chunk;
        let m: RegExpExecArray | null;
        while ((m = /<([^>]*)>/.exec(buf))) {
          buf = buf.slice(m.index + m[0].length);
          const msg = m[1]!.trim();
          received.push(msg);
          if (msg === 'GET DEVICE_AUDIO_MUTE') socket.write(`< REP DEVICE_AUDIO_MUTE ${muted ? 'ON' : 'OFF'} >`);
          else if (msg.startsWith('SET DEVICE_AUDIO_MUTE')) {
            muted = msg.endsWith('ON');
            socket.write(`< REP DEVICE_AUDIO_MUTE ${muted ? 'ON' : 'OFF'} >`);
          } else if (msg === 'GET MODEL') socket.write(`< REP MODEL {${'MXA920'.padEnd(32)}} >`);
          else if (msg === 'GET SERIAL_NUM') socket.write(`< REP SERIAL_NUM {${'ABC123'.padEnd(32)}} >`);
          else if (msg === 'GET FW_VER') socket.write('< REP FW_VER 4.3.12.0 >');
        }
      });
    });
    closers.push(() => server.close());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { port: (server.address() as { port: number }).port, received };
  }

  it('mutes with a command string and reads the mute state, model, serial number and firmware', async () => {
    const dev = await shure();
    const d = start('voice_capture_mic', 'lib:shure-mxa', { host: '127.0.0.1', port: dev.port });
    await until(() => d.getState().muted === false);
    await d.send({ type: 'mute', muted: true });
    expect(dev.received).toContain('SET DEVICE_AUDIO_MUTE ON');
    expect(d.getState().muted).toBe(true);
    await until(() => !!d.getState().firmware);
    expect(d.getState().firmware).toBe('4.3.12.0');
    const rows = JSON.stringify(d.getState().details);
    expect(rows).toContain('MXA920');
    expect(rows).toContain('ABC123');
  });
});

// ---- Sennheiser ----------------------------------------------------------------------------------

describe('Sennheiser TeamConnect Ceiling 2', () => {
  it('speaks SSC JSON over UDP: asks with null, sets with a value, reads identity', async () => {
    let muted = false;
    const received: string[] = [];
    const server: UdpSocket = createSocket('udp4');
    server.on('message', (m, r) => {
      const text = m.toString('utf8');
      received.push(text);
      const msg = JSON.parse(text) as Record<string, Record<string, unknown>>;
      let out: unknown = null;
      if (msg.audio && 'mute' in msg.audio) {
        if (typeof msg.audio.mute === 'boolean') muted = msg.audio.mute;
        out = { audio: { mute: muted } };
      } else if (msg.device)
        out = {
          device: {
            identity: { product: 'TeamConnect Ceiling 2', version: '1.8.0', serial: 'SN0001' },
          },
        };
      if (out) server.send(JSON.stringify(out), r.port, r.address);
    });
    await new Promise<void>((r) => server.bind(0, '127.0.0.1', r));
    closers.push(() => server.close());
    const port = server.address().port;

    const d = start('voice_capture_mic', 'lib:sennheiser-tcc2', { host: '127.0.0.1', port });
    await until(() => d.getState().online && d.getState().muted === false);
    await d.send({ type: 'mute', muted: true });
    expect(received).toContain('{"audio":{"mute":true}}');
    expect(d.getState().muted).toBe(true);
    await until(() => d.getState().firmware === '1.8.0');
    expect(JSON.stringify(d.getState().details)).toContain('SN0001');
  });
});

describe('Sennheiser TeamConnect Ceiling Medium and Bar (SSCv2)', () => {
  it('reads identity over HTTPS with the device’s own certificate and basic auth', async () => {
    const auth: (string | undefined)[] = [];
    const server = createHttps({ key: KEY, cert: CERT }, (req, res) => {
      auth.push(req.headers.authorization);
      if (req.url === '/api/device/identity') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({ product: 'TeamConnect Ceiling Medium', serial: 'TCM77', vendor: 'Sennheiser' }),
        );
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    closers.push(() => server.close());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    const credentials = Buffer.from('api:secret').toString('base64');
    const d = start('voice_capture_mic', 'lib:sennheiser-tcc-medium', {
      host: '127.0.0.1',
      port,
      credentials,
    });
    await until(() => d.getState().online);
    await until(() => JSON.stringify(d.getState().details ?? '').includes('TCM77'));
    expect(auth[0]).toBe(`Basic ${credentials}`);
  });

  it('is offline when the device rejects the password', async () => {
    const server = createHttps({ key: KEY, cert: CERT }, (_req, res) => {
      res.statusCode = 401;
      res.end('{}');
    });
    closers.push(() => server.close());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const d = start('conference_system', 'lib:sennheiser-tc-bar', {
      host: '127.0.0.1',
      port,
      credentials: 'wrong',
    });
    await wait(300);
    expect(d.getState().online).toBe(false);
  });
});
