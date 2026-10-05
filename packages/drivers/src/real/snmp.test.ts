import { createSocket, type Socket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, bytesToHex, type Device } from '@kestrel/model';
import { createDriver } from './registry';
import {
  SnmpClient,
  encodeInt,
  encodeMessage,
  encodeOid,
  tlv,
} from './snmp';
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

// ---- A fake SNMP agent ---------------------------------------------------------------------------

const str = (s: string) => tlv(0x04, Buffer.from(s, 'latin1'));
const gauge = (n: number) => tlv(0x42, Buffer.from([n >> 24, n >> 16, n >> 8, n].map((b) => b & 0xff)));
const ticks = (n: number) => tlv(0x43, Buffer.from([n >> 24, n >> 16, n >> 8, n].map((b) => b & 0xff)));

const cmp = (a: string, b: string) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
};

interface Req {
  community: string;
  tag: number;
  id: number;
  maxRep: number;
  oids: { oid: string; value?: Buffer }[];
}

/** Reads a request the way an agent does: just enough BER to answer GET, GETBULK and SET. */
function parseRequest(buf: Buffer): Req {
  const at = (p: number) => {
    const tag = buf[p]!;
    let len = buf[p + 1]!;
    let header = 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + buf[p + 2 + i]!;
      header = 2 + n;
    }
    return { tag, start: p + header, end: p + header + len };
  };
  const uint = (t: { start: number; end: number }) =>
    t.end > t.start ? buf.subarray(t.start, t.end).readUIntBE(0, t.end - t.start) : 0;
  const outer = at(0);
  const version = at(outer.start);
  const comm = at(version.end);
  const pdu = at(comm.end);
  const idT = at(pdu.start);
  const first = at(idT.end);
  const second = at(first.end);
  const list = at(second.end);
  const oids: Req['oids'] = [];
  for (let p = list.start; p < list.end; ) {
    const vb = at(p);
    const o = at(vb.start);
    const val = at(o.end);
    const arcs: number[] = [Math.floor(buf[o.start]! / 40), buf[o.start]! % 40];
    let v = 0;
    for (let i = o.start + 1; i < o.end; i++) {
      v = v * 128 + (buf[i]! & 0x7f);
      if ((buf[i]! & 0x80) === 0) {
        arcs.push(v);
        v = 0;
      }
    }
    oids.push({ oid: arcs.join('.'), value: buf.subarray(o.end, val.end) });
    p = vb.end;
  }
  return {
    community: buf.subarray(comm.start, comm.end).toString('latin1'),
    tag: pdu.tag,
    id: uint(idT),
    maxRep: uint(second),
    oids,
  };
}

async function agent(mib: [string, Buffer][], opts: { community?: string; silent?: boolean } = {}) {
  const table = new Map(mib);
  const sets: { oid: string; value: number }[] = [];
  const server: Socket = createSocket('udp4');
  server.on('message', (msg, rinfo) => {
    if (opts.silent) return;
    const req = parseRequest(msg);
    const need = req.tag === 0xa3 ? 'private' : (opts.community ?? 'public');
    if (req.community !== need) return;
    const sorted = [...table.keys()].sort(cmp);
    let out: { oid: string; value: Buffer }[] = [];
    if (req.tag === 0xa0)
      out = req.oids.map((o) => ({ oid: o.oid, value: table.get(o.oid) ?? tlv(0x81, Buffer.alloc(0)) }));
    else if (req.tag === 0xa5) {
      const after = sorted.filter((k) => cmp(k, req.oids[0]!.oid) > 0).slice(0, req.maxRep);
      out = after.map((k) => ({ oid: k, value: table.get(k)! }));
      if (out.length === 0) out = [{ oid: req.oids[0]!.oid, value: tlv(0x82, Buffer.alloc(0)) }];
    } else if (req.tag === 0xa3) {
      for (const o of req.oids) {
        const v = o.value!;
        const n = v.subarray(2).readIntBE(0, v.length - 2);
        sets.push({ oid: o.oid, value: n });
        table.set(o.oid, encodeInt(n));
      }
      out = req.oids.map((o) => ({ oid: o.oid, value: table.get(o.oid)! }));
    }
    const binds = tlv(
      0x30,
      Buffer.concat(out.map((v) => tlv(0x30, Buffer.concat([encodeOid(v.oid), v.value])))),
    );
    const pdu = tlv(0xa2, Buffer.concat([encodeInt(req.id), encodeInt(0), encodeInt(0), binds]));
    const reply = tlv(0x30, Buffer.concat([encodeInt(1), str(req.community), pdu]));
    server.send(reply, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => server.bind(0, '127.0.0.1', r));
  closers.push(() => server.close());
  return { port: server.address().port, sets, table };
}

const IF = '1.3.6.1.2.1.2.2.1';
const IFX = '1.3.6.1.2.1.31.1.1.1';
const PETH = '1.3.6.1.2.1.105.1';

const switchMib = (): [string, Buffer][] => [
  ['1.3.6.1.2.1.1.1.0', str('M4250-10G2F-PoE+ managed switch, 13.0.4.26')],
  ['1.3.6.1.2.1.1.3.0', ticks(8_640_000)],
  ['1.3.6.1.2.1.1.5.0', str('rack-1-switch')],
  ['1.3.6.1.2.1.1.6.0', str('Comms room 2')],
  // Four interfaces: three Ethernet ports (1 and 2 up) and a VLAN interface that is not a port.
  ...[1, 2, 3].flatMap((i): [string, Buffer][] => [
    [`${IF}.3.${i}`, encodeInt(6)],
    [`${IF}.2.${i}`, str(`Slot: 0 Port: ${i}`)],
    [`${IF}.8.${i}`, encodeInt(i <= 2 ? 1 : 2)],
    [`${IFX}.1.${i}`, str(`0/${i}`)],
    [`${IFX}.15.${i}`, gauge(1000)],
    [`${IFX}.18.${i}`, str(i === 1 ? 'Lectern camera' : '')],
  ]),
  [`${IF}.3.100`, encodeInt(53)],
  [`${IF}.2.100`, str('VLAN 1')],
  [`${IF}.8.100`, encodeInt(1)],
  ['1.3.6.1.2.1.47.1.1.1.1.10.1', str('13.0.4.26')],
  ['1.3.6.1.2.1.47.1.1.1.1.11.1', str('SN-M4250-77')],
  ['1.3.6.1.2.1.47.1.1.1.1.13.1', str('M4250-10G2F-PoE+')],
  [`${PETH}.1.1.3.1.1`, encodeInt(1)],
  [`${PETH}.1.1.3.1.2`, encodeInt(1)],
  [`${PETH}.1.1.6.1.1`, encodeInt(3)],
  [`${PETH}.1.1.6.1.2`, encodeInt(4)],
  [`${PETH}.3.1.1.2.1`, gauge(125)],
  [`${PETH}.3.1.1.3.1`, encodeInt(1)],
  [`${PETH}.3.1.1.4.1`, gauge(38)],
];

// ---- The client ----------------------------------------------------------------------------------

describe('SNMP client', () => {
  it('writes a v2c GET the way every SNMP tool does', () => {
    const packet = encodeMessage('public', 0xa0, 0x01020304, 0, 0, [{ oid: '1.3.6.1.2.1.1.1.0' }]);
    expect(bytesToHex(packet)).toBe(
      '30 29 02 01 01 04 06 70 75 62 6C 69 63 A0 1C 02 04 01 02 03 04 02 01 00 02 01 00 30 0E 30 0C 06 08 2B 06 01 02 01 01 01 00 05 00',
    );
  });

  it('writes object ids with arcs over 127, and integers in two’s complement', () => {
    expect(bytesToHex(encodeOid('1.3.6.1.4.1.4526.100.1'))).toBe('06 09 2B 06 01 04 01 A3 2E 64 01');
    expect(bytesToHex(encodeInt(0))).toBe('02 01 00');
    expect(bytesToHex(encodeInt(255))).toBe('02 02 00 FF');
    expect(bytesToHex(encodeInt(-1))).toBe('02 01 FF');
    expect(bytesToHex(encodeInt(128))).toBe('02 02 00 80');
  });

  it('gets values and walks a column', async () => {
    const a = await agent(switchMib());
    const c = new SnmpClient({ host: '127.0.0.1', port: a.port, community: 'public', timeoutMs: 500 });
    const [name, missing] = await c.get(['1.3.6.1.2.1.1.5.0', '1.3.6.1.2.1.1.99.0']);
    expect(name).toMatchObject({ kind: 'str', text: 'rack-1-switch' });
    expect(missing?.kind).toBe('missing');
    const oper = await c.walk(`${IF}.8`);
    expect(oper.map((v) => v.num)).toEqual([1, 1, 2, 1]);
    expect(oper[0]!.oid).toBe(`${IF}.8.1`);
  });

  it('says so when the device does not answer or the community is wrong', async () => {
    const quiet = await agent(switchMib(), { silent: true });
    const c = new SnmpClient({ host: '127.0.0.1', port: quiet.port, community: 'public', timeoutMs: 120, retries: 0 });
    await expect(c.get(['1.3.6.1.2.1.1.5.0'])).rejects.toThrow(/did not respond/);
    const strict = await agent(switchMib(), { community: 'secret' });
    const wrong = new SnmpClient({ host: '127.0.0.1', port: strict.port, community: 'public', timeoutMs: 120, retries: 0 });
    await expect(wrong.get(['1.3.6.1.2.1.1.5.0'])).rejects.toThrow(/did not respond/);
  });
});

// ---- The switch driver ---------------------------------------------------------------------------

function start(driverId: string, settings: Record<string, unknown>, points: Device['points'] = []) {
  const device: Device = {
    ...base.devices.find((d) => d.id === 'display1')!,
    category: 'network_switch' as never,
    control: { kind: 'driver', driverId },
    settings,
    points,
  };
  const driver = createDriver(device, ctx)!;
  drivers.push(driver);
  driver.start();
  return driver;
}

describe('Netgear AV switch (SNMP) driver', () => {
  it('reports identity, ports and PoE', async () => {
    const a = await agent(switchMib());
    const d = start('netgear-av', { host: '127.0.0.1', port: a.port, timeoutMs: 800 });
    await until(() => d.getState().online);
    await until(() => !!d.getState().details);
    expect(d.getState().firmware).toBe('13.0.4.26');
    const details = d.getState().details!;
    const identity = details.find((s) => s.title === 'Identity')!;
    expect(identity.rows).toEqual([
      { label: 'Model', value: 'M4250-10G2F-PoE+' },
      { label: 'Serial number', value: 'SN-M4250-77' },
    ]);
    const system = details.find((s) => s.title === 'System')!;
    expect(system.rows.find((r) => r.label === 'Uptime')?.value).toBe('1 d 0 h');
    expect(system.rows.find((r) => r.label === 'Ports up')?.value).toBe('2 of 3');
    // The VLAN interface is not a port.
    const ports = details.find((s) => s.title === 'Ports')!.table!.rows;
    expect(ports.map((r) => r.cells[0])).toEqual(['0/1 (Lectern camera)', '0/2', '0/3']);
    expect(ports.map((r) => r.cells[1])).toEqual(['Up', 'Up', 'Down']);
    const poe = details.find((s) => s.title === 'PoE')!;
    expect(poe.rows.map((r) => r.value)).toEqual(['125 W', '38 W', 'On']);
    expect(poe.table!.rows.map((r) => r.cells[2])).toEqual(['Delivering power', 'Fault']);
    expect(poe.table!.rows[1]!.status).toBe('bad');
  });

  it('reads watched points by OID and by port', async () => {
    const a = await agent(switchMib());
    const d = start(
      'snmp-generic',
      { host: '127.0.0.1', port: a.port, timeoutMs: 800 },
      [
        { id: 'p_name', name: 'Name', type: 'generic', address: { oid: '1.3.6.1.2.1.1.5.0' } },
        { id: 'p_link2', name: 'Port 2', type: 'generic', address: { port: '2', field: 'link' } },
        { id: 'p_link3', name: 'Port 3', type: 'generic', address: { port: '3', field: 'link' } },
        { id: 'p_poe', name: 'PoE 1.1', type: 'generic', address: { port: '1.1', field: 'poe' } },
      ] as never,
    );
    await until(() => !!d.getState().points && Object.keys(d.getState().points!).length === 4);
    expect(d.getState().points).toMatchObject({
      p_name: 'rack-1-switch',
      p_link2: true,
      p_link3: false,
      p_poe: true,
    });
  });

  it('power-cycles a PoE port: off, a pause, then on, with the write community', async () => {
    const a = await agent(switchMib());
    const d = start('netgear-av', {
      host: '127.0.0.1',
      port: a.port,
      timeoutMs: 800,
      writeCommunity: 'private',
      cycleMs: 60,
    });
    await until(() => d.getState().online);
    await d.send({ type: 'command', name: 'poe_cycle_1_2', args: {} });
    expect(a.sets).toEqual([
      { oid: `${PETH}.1.1.3.1.2`, value: 2 },
      { oid: `${PETH}.1.1.3.1.2`, value: 1 },
    ]);
  });

  it('will not switch PoE without a write community, or run an unknown command', async () => {
    const a = await agent(switchMib());
    const d = start('netgear-av', { host: '127.0.0.1', port: a.port, timeoutMs: 800 });
    await until(() => d.getState().online);
    await expect(d.send({ type: 'command', name: 'poe_off_1_1', args: {} })).rejects.toThrow(/write community/);
    await expect(d.send({ type: 'command', name: 'reboot', args: {} })).rejects.toThrow(/does not support/);
    expect(a.sets).toEqual([]);
  });

  it('is offline when the switch does not answer', async () => {
    const a = await agent(switchMib(), { silent: true });
    const d = start('netgear-av', { host: '127.0.0.1', port: a.port, timeoutMs: 100 });
    await wait(500);
    expect(d.getState().online).toBe(false);
  });
});
