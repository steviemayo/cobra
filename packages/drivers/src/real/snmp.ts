import { createSocket } from 'node:dgram';
import { randomInt } from 'node:crypto';
import { isIPv6 } from 'node:net';

// A small SNMP v2c client: GET, GETBULK, a walk built on it, and SET of an integer. It is written out
// here rather than pulled in as a package because that is all the switch driver needs, and a driver
// that talks to every switch on a customer's network is not a place for a large dependency.
//
// v2c only: a community string is sent in the clear. v3 (users, authentication, encryption) is not
// supported yet.

const T = {
  INTEGER: 0x02,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  SEQUENCE: 0x30,
  IP_ADDRESS: 0x40,
  COUNTER32: 0x41,
  GAUGE32: 0x42,
  TIMETICKS: 0x43,
  COUNTER64: 0x46,
  NO_SUCH_OBJECT: 0x80,
  NO_SUCH_INSTANCE: 0x81,
  END_OF_MIB_VIEW: 0x82,
  GET: 0xa0,
  GET_NEXT: 0xa1,
  RESPONSE: 0xa2,
  SET: 0xa3,
  GET_BULK: 0xa5,
} as const;

export type SnmpKind =
  | 'int'
  | 'str'
  | 'oid'
  | 'null'
  | 'ip'
  | 'counter'
  | 'gauge'
  | 'ticks'
  | 'missing';

export interface VarBind {
  oid: string;
  kind: SnmpKind;
  /** Numbers for integers, counters, gauges and time ticks. */
  num?: number;
  /** Text for strings, the OID for an object id, the dotted address for an IP. */
  text?: string;
  /** The raw bytes of a string (a MAC address is not text). */
  bytes?: Buffer;
}

export class SnmpError extends Error {}

const ERRORS = [
  'no error',
  'tooBig',
  'noSuchName',
  'badValue',
  'readOnly',
  'genErr',
  'noAccess',
  'wrongType',
  'wrongLength',
  'wrongEncoding',
  'wrongValue',
  'noCreation',
  'inconsistentValue',
  'resourceUnavailable',
  'commitFailed',
  'undoFailed',
  'authorizationError',
  'notWritable',
  'inconsistentName',
];

// ---- BER -----------------------------------------------------------------------------------------

function lengthBytes(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export const tlv = (tag: number, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), lengthBytes(body.length), body]);

export function encodeInt(n: number): Buffer {
  // Two's complement, as few bytes as it takes.
  const bytes: number[] = [];
  let v = n;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v !== 0 && v !== -1);
  if (n >= 0 && (bytes[0]! & 0x80) !== 0) bytes.unshift(0);
  if (n < 0 && (bytes[0]! & 0x80) === 0) bytes.unshift(0xff);
  return tlv(T.INTEGER, Buffer.from(bytes));
}

export function encodeOid(oid: string): Buffer {
  const arcs = oid.split('.').map(Number);
  if (arcs.length < 2 || arcs.some((a) => !Number.isInteger(a) || a < 0))
    throw new SnmpError(`"${oid}" is not an object id`);
  const out: number[] = [arcs[0]! * 40 + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const part: number[] = [arc & 0x7f];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128)) part.unshift((v & 0x7f) | 0x80);
    out.push(...part);
  }
  return tlv(T.OID, Buffer.from(out));
}

const encodeNull = () => tlv(T.NULL, Buffer.alloc(0));

export function encodeMessage(
  community: string,
  pduTag: number,
  requestId: number,
  a: number,
  b: number,
  varbinds: { oid: string; value?: Buffer }[],
): Buffer {
  const binds = tlv(
    T.SEQUENCE,
    Buffer.concat(
      varbinds.map((v) =>
        tlv(T.SEQUENCE, Buffer.concat([encodeOid(v.oid), v.value ?? encodeNull()])),
      ),
    ),
  );
  const pdu = tlv(pduTag, Buffer.concat([encodeInt(requestId), encodeInt(a), encodeInt(b), binds]));
  return tlv(
    T.SEQUENCE,
    Buffer.concat([encodeInt(1), tlv(T.OCTET_STRING, Buffer.from(community, 'latin1')), pdu]),
  );
}

interface Reader {
  buf: Buffer;
  pos: number;
}

function readTlv(r: Reader): { tag: number; body: Buffer } {
  if (r.pos + 2 > r.buf.length) throw new SnmpError('short reply');
  const tag = r.buf[r.pos++]!;
  let len = r.buf[r.pos++]!;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || r.pos + n > r.buf.length) throw new SnmpError('bad length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + r.buf[r.pos++]!;
  }
  if (r.pos + len > r.buf.length) throw new SnmpError('short reply');
  const body = r.buf.subarray(r.pos, r.pos + len);
  r.pos += len;
  return { tag, body };
}

function decodeInt(body: Buffer, signed: boolean): number {
  let v = 0;
  for (const b of body) v = v * 256 + b;
  if (signed && body.length > 0 && (body[0]! & 0x80) !== 0) v -= 2 ** (8 * body.length);
  return v;
}

function decodeOid(body: Buffer): string {
  if (body.length === 0) return '';
  const arcs: number[] = [Math.floor(body[0]! / 40), body[0]! % 40];
  let v = 0;
  for (const b of body.subarray(1)) {
    v = v * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      arcs.push(v);
      v = 0;
    }
  }
  return arcs.join('.');
}

function decodeValue(tag: number, body: Buffer): Omit<VarBind, 'oid'> {
  switch (tag) {
    case T.INTEGER:
      return { kind: 'int', num: decodeInt(body, true) };
    case T.OCTET_STRING:
      return { kind: 'str', text: body.toString('latin1'), bytes: Buffer.from(body) };
    case T.OID:
      return { kind: 'oid', text: decodeOid(body) };
    case T.NULL:
      return { kind: 'null' };
    case T.IP_ADDRESS:
      return { kind: 'ip', text: [...body].join('.') };
    case T.COUNTER32:
    case T.COUNTER64:
      return { kind: 'counter', num: decodeInt(body, false) };
    case T.GAUGE32:
      return { kind: 'gauge', num: decodeInt(body, false) };
    case T.TIMETICKS:
      return { kind: 'ticks', num: decodeInt(body, false) };
    default:
      // noSuchObject, noSuchInstance, endOfMibView, or something this client does not know.
      return { kind: 'missing' };
  }
}

export interface DecodedReply {
  requestId: number;
  errorStatus: number;
  errorIndex: number;
  varbinds: VarBind[];
  endOfMib: boolean;
}

export function decodeMessage(buf: Buffer): DecodedReply {
  const outer = readTlv({ buf, pos: 0 });
  if (outer.tag !== T.SEQUENCE) throw new SnmpError('not an SNMP message');
  const r: Reader = { buf: outer.body, pos: 0 };
  readTlv(r); // version
  readTlv(r); // community
  const pdu = readTlv(r);
  if (pdu.tag !== T.RESPONSE) throw new SnmpError('not an SNMP response');
  const p: Reader = { buf: pdu.body, pos: 0 };
  const requestId = decodeInt(readTlv(p).body, true);
  const errorStatus = decodeInt(readTlv(p).body, true);
  const errorIndex = decodeInt(readTlv(p).body, true);
  const list = readTlv(p);
  const l: Reader = { buf: list.body, pos: 0 };
  const varbinds: VarBind[] = [];
  let endOfMib = false;
  while (l.pos < l.buf.length) {
    const vb = readTlv(l);
    const v: Reader = { buf: vb.body, pos: 0 };
    const oid = decodeOid(readTlv(v).body);
    const val = readTlv(v);
    if (val.tag === T.END_OF_MIB_VIEW) endOfMib = true;
    varbinds.push({ oid, ...decodeValue(val.tag, val.body) });
  }
  return { requestId, errorStatus, errorIndex, varbinds, endOfMib };
}

// ---- Client --------------------------------------------------------------------------------------

export interface SnmpOptions {
  host: string;
  port?: number;
  community: string;
  timeoutMs?: number;
  retries?: number;
}

const under = (oid: string, prefix: string) => oid === prefix || oid.startsWith(`${prefix}.`);

export class SnmpClient {
  constructor(private readonly o: SnmpOptions) {}

  /** One request and its answer, retried when the datagram is lost. */
  private async exchange(
    pduTag: number,
    a: number,
    b: number,
    varbinds: { oid: string; value?: Buffer }[],
    community = this.o.community,
  ): Promise<DecodedReply> {
    const attempts = (this.o.retries ?? 1) + 1;
    let last: Error = new SnmpError('did not respond');
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.once(pduTag, a, b, varbinds, community);
      } catch (e) {
        last = e instanceof Error ? e : new SnmpError(String(e));
        // An answer that says no is final; only silence is worth asking again.
        if (!/did not respond/.test(last.message)) throw last;
      }
    }
    throw last;
  }

  private once(
    pduTag: number,
    a: number,
    b: number,
    varbinds: { oid: string; value?: Buffer }[],
    community: string,
  ): Promise<DecodedReply> {
    const id = randomInt(1, 0x7ffffff0);
    const packet = encodeMessage(community, pduTag, id, a, b, varbinds);
    return new Promise((resolve, reject) => {
      const socket = createSocket(isIPv6(this.o.host) ? 'udp6' : 'udp4');
      let done = false;
      const finish = (err?: Error, reply?: DecodedReply) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        if (err) reject(err);
        else resolve(reply!);
      };
      const timer = setTimeout(
        () => finish(new SnmpError('did not respond')),
        this.o.timeoutMs ?? 3000,
      );
      socket.on('error', (e) => finish(e));
      socket.on('message', (msg) => {
        try {
          const reply = decodeMessage(msg);
          if (reply.requestId !== id) return;
          if (reply.errorStatus !== 0)
            return finish(
              new SnmpError(`the device said ${ERRORS[reply.errorStatus] ?? `error ${reply.errorStatus}`}`),
            );
          finish(undefined, reply);
        } catch (e) {
          finish(e instanceof Error ? e : new SnmpError(String(e)));
        }
      });
      socket.send(packet, this.o.port ?? 161, this.o.host, (e) => {
        if (e) finish(e);
      });
    });
  }

  async get(oids: string[]): Promise<VarBind[]> {
    return (await this.exchange(T.GET, 0, 0, oids.map((oid) => ({ oid })))).varbinds;
  }

  /** One GETBULK: up to `max` rows after `oid`. */
  async bulk(oid: string, max = 20): Promise<DecodedReply> {
    return this.exchange(T.GET_BULK, 0, max, [{ oid }]);
  }

  /** Every value under `prefix`, in order. Bounded, so a device with a vast table cannot hold a poll. */
  async walk(prefix: string, limit = 400): Promise<VarBind[]> {
    const out: VarBind[] = [];
    let cursor = prefix;
    for (let guard = 0; guard < 40 && out.length < limit; guard++) {
      const reply = await this.bulk(cursor, 20);
      let advanced = false;
      for (const vb of reply.varbinds) {
        if (!under(vb.oid, prefix) || vb.kind === 'missing') return out;
        out.push(vb);
        cursor = vb.oid;
        advanced = true;
        if (out.length >= limit) return out;
      }
      if (!advanced || reply.endOfMib) break;
    }
    return out;
  }

  /** Sets one integer. Needs the write community. */
  async setInt(oid: string, value: number, community: string): Promise<void> {
    await this.exchange(T.SET, 0, 0, [{ oid, value: encodeInt(value) }], community);
  }
}

/** The numeric last arcs of an OID after `prefix` ("1.3.6.1.2.1.2.2.1.8.12" under "...1.8" is "12"). */
export const indexOf = (oid: string, prefix: string): string => oid.slice(prefix.length + 1);

/** A MAC address from the raw bytes an SNMP string carries. */
export const macOf = (bytes: Buffer): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
