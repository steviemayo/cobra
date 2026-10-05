import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

// What a Q-SYS Core says about itself over its web interface. QRC (port 1710) has the engine status
// but not the unit's model, serial number or firmware; the Core's own REST API does:
//   POST /api/v0/logon { username, password }  ->  201 { token }
//   GET  /api/v0/cores/self  (Authorization: Bearer <token>)  ->  { modelName, serialNo, firmware: { buildName }, ... }
// A Core with no logon set up answers the GET without a token. Verified against a Core Nano on
// firmware 10.4.1. The Core's certificate is its own (self-signed), so that is accepted by default.

export interface QsysCoreInfo {
  model?: string;
  /** The unit's serial number (the label on the box). */
  serial?: string;
  /** Firmware with its build, for example "10.4.1-2607.004". */
  firmware?: string;
  hostname?: string;
  /** The Core's identifier in Q-SYS Reflect and Core Manager, not the same as the serial number. */
  hardwareId?: string;
}

const text = (v: unknown, max = 100): string | undefined =>
  typeof v === 'string' && v.trim()
    ? v
        .replace(/[^\x20-\x7e]/g, '')
        .trim()
        .slice(0, max) || undefined
    : undefined;

/** Reads the answer of `GET /api/v0/cores/self` (or the first entry of `/api/v0/cores`). */
export function parseCoreInfo(json: unknown): QsysCoreInfo | null {
  const first = Array.isArray(json) ? json[0] : json;
  if (!first || typeof first !== 'object') return null;
  const c = first as Record<string, unknown>;
  const fw =
    c.firmware && typeof c.firmware === 'object' ? (c.firmware as Record<string, unknown>) : {};
  const info: QsysCoreInfo = {
    model: text(c.modelName) ?? text(c.model),
    // serialNo is the unit's serial; "serial" is the Core's identifier (the same as hardwareId).
    serial: text(c.serialNo),
    firmware:
      text(fw.buildName) ??
      text(fw.name) ??
      text(typeof c.firmware === 'string' ? c.firmware : undefined),
    hostname: text(c.hostname),
    hardwareId: text(c.hardwareId) ?? text(c.serial) ?? text(c.naturalId),
  };
  return Object.values(info).some(Boolean) ? info : null;
}

export class QsysRestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function call(
  o: { host: string; port: number; https: boolean; allowSelfSigned: boolean; timeoutMs: number },
  method: 'GET' | 'POST',
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const send = o.https ? httpsRequest : httpRequest;
    const req = send(
      {
        host: o.host,
        port: o.port,
        path,
        method,
        headers: {
          ...headers,
          ...(body
            ? {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(body)),
              }
            : {}),
        },
        timeout: o.timeoutMs,
        ...(o.https ? { rejectUnauthorized: !o.allowSelfSigned } : {}),
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => {
          // Core Manager answers are small; refuse anything that is not.
          if (data.length < 200_000) data += d;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('did not respond')));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Asks a Core who it is. Logs on first when a logon name is given; otherwise asks without one. A
 * wrong logon or a Core that needs one is a QsysRestError with the status, so the caller can say so.
 */
export async function fetchCoreInfo(o: {
  host: string;
  port?: number;
  https?: boolean;
  allowSelfSigned?: boolean;
  username?: string;
  password?: string;
  timeoutMs?: number;
}): Promise<QsysCoreInfo> {
  const opts = {
    host: o.host,
    port: o.port ?? (o.https === false ? 80 : 443),
    https: o.https !== false,
    allowSelfSigned: o.allowSelfSigned !== false,
    timeoutMs: o.timeoutMs ?? 5000,
  };
  const headers: Record<string, string> = {};
  if (o.username) {
    const r = await call(
      opts,
      'POST',
      '/api/v0/logon',
      {},
      JSON.stringify({ username: o.username, password: o.password ?? '' }),
    );
    if (r.status === 401 || r.status === 403)
      throw new QsysRestError('the Core refused the logon name or password', r.status);
    if (r.status < 200 || r.status > 299)
      throw new QsysRestError(`logon answered ${r.status}`, r.status);
    let token: unknown;
    try {
      token = (JSON.parse(r.body) as { token?: unknown }).token;
    } catch {
      // handled below
    }
    if (typeof token !== 'string' || !token)
      throw new QsysRestError('the Core gave no logon token');
    headers.authorization = `Bearer ${token}`;
  }
  const r = await call(opts, 'GET', '/api/v0/cores/self', headers);
  if (r.status === 401 || r.status === 403)
    throw new QsysRestError(
      'the Core needs a logon name and password for its web interface',
      r.status,
    );
  if (r.status < 200 || r.status > 299)
    throw new QsysRestError(`the Core answered ${r.status}`, r.status);
  let json: unknown;
  try {
    json = JSON.parse(r.body);
  } catch {
    throw new QsysRestError('the Core gave an answer that is not JSON');
  }
  const info = parseCoreInfo(json);
  if (!info) throw new QsysRestError('the Core did not say who it is');
  return info;
}
