import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Device, DeviceCommand, DeviceDetailSection } from '@kestrel/model';
import { consoleAddressBlocked } from './ascii-console';
import { BaseDriver } from './base';
import type { DeviceDriver, DriverContext, Snapshot } from './types';

// An IP camera over ONVIF (Profile S): who it is, whether it answers, its presets, pointing it, and a
// JPEG snapshot on request. ONVIF is SOAP over HTTP with a WS-Security UsernameToken (a password
// digest worked out from a one-off nonce and the camera's own clock), so it cannot be written in the
// declarative driver format. Most IP cameras speak it: Axis, Panasonic, Sony, Hikvision, Dahua, Bosch,
// Hanwha and others.
//
//   Device service  http://<host>:<port>/onvif/device_service
//     GetSystemDateAndTime (no login: the camera's clock, so the digest is accepted)
//     GetDeviceInformation (manufacturer, model, firmware, serial number)
//     GetCapabilities      (where the Media and PTZ services are)
//   Media service   GetProfiles (a profile token), GetSnapshotUri
//   PTZ service     GetPresets, GotoPreset, ContinuousMove, Stop
//
// The addresses a camera hands back (its Media, PTZ and snapshot URLs) are used with the host and port
// the device was added with, never the address the camera claims: a camera behind NAT or one that has
// been set up wrongly must not be able to point the gateway at somewhere else on the network.
//
// A snapshot is fetched when asked and handed back; nothing is kept. The snapshot address usually wants
// HTTP digest or basic authentication with the same login, and both are handled.
//
// Settings: host, port (80), https (false; on, the camera's own certificate is accepted, as most are
// self-signed), username, password, pollMs (30000), timeoutMs (4000), speed (0.5, for pan and tilt).
//
// Not yet checked against a real camera.

const NS = {
  device: 'http://www.onvif.org/ver10/device/wsdl',
  media: 'http://www.onvif.org/ver10/media/wsdl',
  ptz: 'http://www.onvif.org/ver20/ptz/wsdl',
  schema: 'http://www.onvif.org/ver10/schema',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  password: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest',
  base64: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary',
};

const MAX_BODY = 512 * 1024;
const MAX_SNAPSHOT = 3 * 1024 * 1024;

const xmlEscape = (v: string) =>
  v.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

/** The text inside the first `<…:name>` element, whatever namespace prefix the camera used. */
export function inner(xml: string, name: string): string | undefined {
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`).exec(xml);
  return m ? decodeXml(m[1]!.trim()) : undefined;
}

/** Every `<…:name …>` start tag's attributes and the text inside, for a list (profiles, presets). */
export function eachElement(xml: string, name: string): { attrs: string; body: string }[] {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}((?:\\s[^>]*)?)>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, 'g');
  return [...xml.matchAll(re)].map((m) => ({ attrs: m[1]!, body: m[2]! }));
}

const attr = (attrs: string, name: string) =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? undefined;

const decodeXml = (v: string) =>
  v
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

interface Target {
  host: string;
  port: number;
  https: boolean;
}

function send(
  t: Target,
  path: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  limit: number,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = (t.https ? httpsRequest : httpRequest)(
      {
        host: t.host,
        port: t.port,
        path,
        method,
        headers: {
          ...headers,
          ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
        },
        timeout: timeoutMs,
        ...(t.https ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > limit) return req.destroy(new Error('the reply was too large'));
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('did not respond')));
    req.on('error', reject);
    req.end(body);
  });
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/** The Authorization header answering a Digest or Basic challenge, or undefined for a challenge it does not know. */
export function answerChallenge(
  challenge: string,
  user: string,
  password: string,
  method: string,
  uri: string,
  cnonce = randomBytes(8).toString('hex'),
): string | undefined {
  if (/^\s*basic/i.test(challenge))
    return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  if (!/^\s*digest/i.test(challenge)) return undefined;
  const field = (n: string) =>
    new RegExp(`${n}="([^"]*)"`, 'i').exec(challenge)?.[1] ?? new RegExp(`${n}=([^,\\s]+)`, 'i').exec(challenge)?.[1];
  const realm = field('realm') ?? '';
  const nonce = field('nonce') ?? '';
  const opaque = field('opaque');
  const qop = (field('qop') ?? '').split(',').map((q) => q.trim()).includes('auth') ? 'auth' : undefined;
  const nc = '00000001';
  const ha1 = md5(`${user}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  return (
    `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"` +
    (qop ? `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"` : '') +
    (opaque ? `, opaque="${opaque}"` : '')
  );
}

/** The WS-Security header: Base64(SHA-1(nonce + created + password)), with the camera's own clock. */
export function securityHeader(
  user: string,
  password: string,
  created: string,
  nonce: Buffer = randomBytes(16),
): string {
  const digest = createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created + password)])).digest('base64');
  return (
    `<s:Header><Security s:mustUnderstand="1" xmlns="${NS.wsse}"><UsernameToken>` +
    `<Username>${xmlEscape(user)}</Username>` +
    `<Password Type="${NS.password}">${digest}</Password>` +
    `<Nonce EncodingType="${NS.base64}">${nonce.toString('base64')}</Nonce>` +
    `<Created xmlns="${NS.wsu}">${created}</Created>` +
    `</UsernameToken></Security></s:Header>`
  );
}

const envelope = (header: string, body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">${header}<s:Body>${body}</s:Body></s:Envelope>`;

const utc = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

export class OnvifDriver extends BaseDriver implements DeviceDriver {
  private poller: ReturnType<typeof setInterval> | null = null;
  /** The camera's clock minus ours, in ms, so the digest carries a time the camera will accept. */
  private skew = 0;
  private media: string | null = null;
  private ptz: string | null = null;
  private profile: string | null = null;
  private presets = new Map<string, string>();
  private polling = false;

  constructor(device: Device, ctx: DriverContext) {
    super(device, ctx);
    this.state.online = false;
  }

  override features(): string[] {
    return ['preset', 'ptz', 'snapshot'];
  }

  private target(): Target {
    const host = this.setting<string>('host', '');
    if (!host) this.fail('no host configured');
    if (consoleAddressBlocked(host, this.device.settings))
      this.fail(`${host} is a cloud metadata address, not a device (add "allowLocalAddress": true to allow it)`);
    const https = this.setting<boolean>('https', false);
    return { host, port: this.setting<number>('port', https ? 443 : 80), https };
  }

  private get timeout() {
    return this.setting<number>('timeoutMs', 4000);
  }

  /** The path of a service address the camera gave, kept on the host and port the device was added with. */
  private servicePath(xaddr: string | undefined, fallback: string): string {
    if (!xaddr) return fallback;
    try {
      const u = new URL(xaddr);
      return u.pathname + u.search;
    } catch {
      return fallback;
    }
  }

  private async soap(path: string, action: string, body: string, authed = true): Promise<string> {
    const user = this.setting<string>('username', '');
    const password = this.setting<string>('password', '');
    const header =
      authed && user ? securityHeader(user, password, utc(new Date(Date.now() + this.skew))) : '';
    const res = await send(
      this.target(),
      path,
      'POST',
      { 'content-type': `application/soap+xml; charset=utf-8; action="${action}"` },
      envelope(header, body),
      this.timeout,
      MAX_BODY,
    );
    const text = res.body.toString('utf8');
    if (res.status === 401) throw new Error('rejected the login');
    if (res.status >= 400 && !text.includes('Fault')) throw new Error(`answered HTTP ${res.status}`);
    const fault = /<(?:[\w.-]+:)?Fault\b/.test(text);
    if (fault) {
      const reason = inner(text, 'Text') ?? 'a SOAP fault';
      throw new Error(/NotAuthorized|Sender not authorized/i.test(text) ? 'rejected the login' : reason);
    }
    return text;
  }

  override start() {
    if (!this.setting<string>('host', '')) return;
    void this.poll();
    this.poller = setInterval(() => void this.poll(), this.setting<number>('pollMs', 30000));
    this.poller.unref?.();
  }

  override close() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  /** Reads the camera's clock, then who it is; learns the services and presets the first time. */
  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      try {
        const t = await this.soap('/onvif/device_service', `${NS.device}/GetSystemDateAndTime`,
          `<GetSystemDateAndTime xmlns="${NS.device}"/>`, false);
        const utcDate = /UTCDateTime/.test(t) ? t.slice(t.indexOf('UTCDateTime')) : '';
        const n = (name: string) => Number(inner(utcDate, name));
        const cam = Date.UTC(n('Year'), n('Month') - 1, n('Day'), n('Hour'), n('Minute'), n('Second'));
        if (Number.isFinite(cam)) this.skew = cam - Date.now();
      } catch {
        // A camera that will not tell the time is tried with ours.
      }
      const info = await this.soap(
        '/onvif/device_service',
        `${NS.device}/GetDeviceInformation`,
        `<GetDeviceInformation xmlns="${NS.device}"/>`,
      );
      const model = inner(info, 'Model');
      const make = inner(info, 'Manufacturer');
      const firmware = inner(info, 'FirmwareVersion');
      const serial = inner(info, 'SerialNumber');
      if (!this.media) await this.learn();
      const rows: DeviceDetailSection['rows'] = [];
      if (model) rows.push({ label: 'Model', value: model.slice(0, 100) });
      if (serial) rows.push({ label: 'Serial number', value: serial.slice(0, 100) });
      if (make) rows.push({ label: 'Manufacturer', value: make.slice(0, 100) });
      this.update((s) => {
        s.online = true;
        if (firmware) s.firmware = firmware.slice(0, 100);
        s.details = [
          { title: 'Identity', rows },
          ...(this.presets.size
            ? [{ title: 'Presets', rows: [...this.presets.keys()].slice(0, 40).map((name) => ({ label: name, value: 'Saved' })) }]
            : []),
        ];
      });
    } catch (e) {
      this.ctx.log('warn', `${this.device.name}: ${e instanceof Error ? e.message : String(e)}`);
      this.update((s) => {
        s.online = false;
      });
    } finally {
      this.polling = false;
    }
  }

  /** Where the Media and PTZ services are, which profile to use, and what presets there are. */
  private async learn() {
    const caps = await this.soap(
      '/onvif/device_service',
      `${NS.device}/GetCapabilities`,
      `<GetCapabilities xmlns="${NS.device}"><Category>All</Category></GetCapabilities>`,
    );
    const mediaBlock = inner(caps, 'Media') ?? '';
    const ptzBlock = inner(caps, 'PTZ') ?? '';
    this.media = this.servicePath(inner(mediaBlock, 'XAddr'), '/onvif/media_service');
    this.ptz = ptzBlock ? this.servicePath(inner(ptzBlock, 'XAddr'), '/onvif/ptz_service') : null;
    const profiles = await this.soap(
      this.media,
      `${NS.media}/GetProfiles`,
      `<GetProfiles xmlns="${NS.media}"/>`,
    );
    const wanted = this.setting<string>('profile', '');
    const tokens = eachElement(profiles, 'Profiles').map((p) => attr(p.attrs, 'token')).filter((t): t is string => !!t);
    this.profile = (wanted && tokens.includes(wanted) ? wanted : tokens[0]) ?? null;
    if (this.ptz && this.profile) {
      try {
        const list = await this.soap(
          this.ptz,
          `${NS.ptz}/GetPresets`,
          `<GetPresets xmlns="${NS.ptz}"><ProfileToken>${xmlEscape(this.profile)}</ProfileToken></GetPresets>`,
        );
        this.presets = new Map(
          eachElement(list, 'Preset').flatMap((p) => {
            const token = attr(p.attrs, 'token');
            const name = inner(p.body, 'Name') ?? token;
            return token && name ? [[name, token] as [string, string]] : [];
          }),
        );
      } catch {
        // A camera with no PTZ service simply has no presets.
        this.presets = new Map();
      }
    }
  }

  async send(command: DeviceCommand): Promise<void> {
    if (command.type !== 'camera_preset' && command.type !== 'camera_move')
      this.fail(`does not support "${command.type}"`);
    if (!this.ptz || !this.profile) {
      await this.learn().catch(() => undefined);
      if (!this.ptz || !this.profile) this.fail('has no PTZ service');
    }
    const token = xmlEscape(this.profile!);
    try {
      if (command.type === 'camera_preset') {
        const wanted = command.name.toLowerCase();
        const preset =
          [...this.presets].find(([n, t]) => n.toLowerCase() === wanted || t === command.name)?.[1];
        if (!preset) this.fail(`has no preset called “${command.name}”`);
        await this.soap(
          this.ptz!,
          `${NS.ptz}/GotoPreset`,
          `<GotoPreset xmlns="${NS.ptz}"><ProfileToken>${token}</ProfileToken><PresetToken>${xmlEscape(preset)}</PresetToken></GotoPreset>`,
        );
      } else if (command.pan === 0 && command.tilt === 0 && command.zoom === 0) {
        await this.soap(
          this.ptz!,
          `${NS.ptz}/Stop`,
          `<Stop xmlns="${NS.ptz}"><ProfileToken>${token}</ProfileToken><PanTilt>true</PanTilt><Zoom>true</Zoom></Stop>`,
        );
      } else {
        const v = Math.max(0.1, Math.min(1, this.setting<number>('speed', 0.5)));
        await this.soap(
          this.ptz!,
          `${NS.ptz}/ContinuousMove`,
          `<ContinuousMove xmlns="${NS.ptz}"><ProfileToken>${token}</ProfileToken><Velocity>` +
            `<PanTilt x="${command.pan * v}" y="${command.tilt * v}" xmlns="${NS.schema}"/>` +
            `<Zoom x="${command.zoom * v}" xmlns="${NS.schema}"/></Velocity></ContinuousMove>`,
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith(this.device.name)) throw e;
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  /** One JPEG from the camera, fetched now and handed back. Nothing is kept. */
  async snapshot(): Promise<Snapshot> {
    try {
      if (!this.media || !this.profile) await this.learn();
      if (!this.media || !this.profile) this.fail('has no media profile');
      const reply = await this.soap(
        this.media,
        `${NS.media}/GetSnapshotUri`,
        `<GetSnapshotUri xmlns="${NS.media}"><ProfileToken>${xmlEscape(this.profile)}</ProfileToken></GetSnapshotUri>`,
      );
      const uri = inner(reply, 'Uri');
      if (!uri) this.fail('did not give a snapshot address');
      const path = this.servicePath(uri, '');
      if (!path) this.fail('gave a snapshot address that cannot be used');
      const t = this.target();
      const user = this.setting<string>('username', '');
      const password = this.setting<string>('password', '');
      let res = await send(t, path, 'GET', {}, undefined, this.timeout, MAX_SNAPSHOT);
      if (res.status === 401 && user) {
        const challenge = [res.headers['www-authenticate']].flat().find((c) => c && /^(digest|basic)/i.test(c.trim()));
        const auth = challenge ? answerChallenge(challenge, user, password, 'GET', path) : undefined;
        if (auth) res = await send(t, path, 'GET', { authorization: auth }, undefined, this.timeout, MAX_SNAPSHOT);
      }
      if (res.status !== 200) this.fail(`answered HTTP ${res.status} for the snapshot`);
      const contentType = String(res.headers['content-type'] ?? 'image/jpeg').split(';')[0]!.trim();
      // A JPEG starts FF D8. Anything else (an HTML login page) is not a picture.
      if (!/^image\//i.test(contentType) || res.body[0] !== 0xff || res.body[1] !== 0xd8)
        this.fail('did not send a JPEG');
      return { contentType: 'image/jpeg', bytes: res.body };
    } catch (e) {
      if (e instanceof Error && e.message.startsWith(this.device.name)) throw e;
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }
}
