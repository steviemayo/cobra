import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { generateKeyPair, signBindings, signManifest } from '@kestrel/crypto';
import {
  EnrollRequest,
  HeartbeatRequest,
  PROTOCOL_VERSION,
  TelemetryBatch,
  type DeviceValues,
  type GatewayCommand,
  type RoomModel,
  type SignedManifest,
  type TelemetryEvent,
} from '@kestrel/model';

export const ORG_ID = '11111111-1111-4111-8111-111111111111';
export const GATEWAY_ID = '99999999-9999-4999-8999-999999999999';
export const ENROLL_TOKEN = 'good-enrol-token-12345';
export const CREDENTIAL = 'gateway-credential-secret-abcdef';

interface Assignment {
  roomId: string;
  roomName: string;
  releaseId: string;
  releaseNumber: number;
  deploymentId: string;
  signed: unknown;
  bindingsVersion?: number;
}

/** A stand-in for the Kestrel cloud that speaks protocol v1 and signs releases with a real key. */
export class FakeCloud {
  readonly keys = generateKeyPair();
  readonly keyId = 'test-key';
  readonly enrols: unknown[] = [];
  readonly heartbeats: HeartbeatRequest[] = [];
  /** Commands handed to the gateway in its next heartbeat response. */
  readonly queuedCommands: GatewayCommand[] = [];
  /** Bookings handed to the gateway in each heartbeat response. */
  schedules: { roomId: string; meetings: unknown[] }[] = [];
  /** Rooms the fake portal is "controlling": the gateway is told to poll fast for them. */
  watching: string[] = [];
  /** Room groups the fake cloud reports in the gateway's config. */
  groups: unknown[] = [];
  readonly queuedIntents: { id: string; roomId: string; intent: unknown }[] = [];
  readonly polls: { panels: { roomId: string; vm: unknown }[] }[] = [];
  readonly telemetry: TelemetryEvent[] = [];
  readonly manifestFetches: string[] = [];
  readonly bindingsFetches: string[] = [];
  private bindings = new Map<
    string,
    {
      version: number;
      devices: DeviceValues;
      tamper?: boolean;
      shared?: Record<string, { siteDeviceId: string; exclusive: boolean }>;
    }
  >();
  private assignments = new Map<string, Assignment>();
  private version = 1;
  private server: Server | null = null;
  /** When false the cloud answers 503 to everything. */
  up = true;
  url = '';

  setGroups(list: unknown[]) {
    this.groups = list;
    this.version++;
  }

  async start(port = 0): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(port, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this;
  }

  async stop() {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server?.closeAllConnections?.();
  }

  get publicKeys() {
    return [{ keyId: this.keyId, publicKeyPem: this.keys.publicKeyPem }];
  }

  /** Assign a signed release of `model` to the gateway. Returns what was signed. */
  assign(
    roomId: string,
    model: RoomModel,
    opts: { number?: number; name?: string; tamper?: boolean; external?: boolean } = {},
  ): SignedManifest {
    const number = opts.number ?? (this.assignments.get(roomId)?.releaseNumber ?? 0) + 1;
    const releaseId = `4444444${number}-4444-4444-8444-444444444444`.slice(0, 36);
    const signed = signManifest(
      {
        manifestVersion: 1,
        orgId: ORG_ID,
        roomId,
        roomName: opts.name ?? 'Test room',
        releaseId,
        releaseNumber: number,
        createdAt: new Date().toISOString(),
        ...(opts.external ? { bindingsExternal: true } : {}),
        model,
      },
      { privateKeyPem: this.keys.privateKeyPem, keyId: this.keyId },
    );
    const wire = JSON.parse(JSON.stringify(signed)) as { manifest: { roomName: string } };
    if (opts.tamper) wire.manifest.roomName = 'Injected by an attacker';
    this.assignments.set(roomId, {
      roomId,
      roomName: signed.manifest.roomName,
      releaseId,
      releaseNumber: number,
      deploymentId: randomUUID(),
      signed: wire,
      ...this.bindingsOf(roomId),
    });
    this.version++;
    return signed;
  }

  private bindingsOf(roomId: string) {
    const b = this.bindings.get(roomId);
    return b ? { bindingsVersion: b.version } : {};
  }

  /** Set a room's addresses and logins. Each call is a new version, as in the cloud. */
  setBindings(
    roomId: string,
    devices: DeviceValues,
    opts: {
      tamper?: boolean;
      shared?: Record<string, { siteDeviceId: string; exclusive: boolean }>;
    } = {},
  ) {
    const version = (this.bindings.get(roomId)?.version ?? 0) + 1;
    this.bindings.set(roomId, { version, devices, ...opts });
    const a = this.assignments.get(roomId);
    if (a) a.bindingsVersion = version;
    this.version++;
  }

  /** Ask for the current release again as a new deployment, so a refused one gets another go. */
  redeploy(roomId: string) {
    const a = this.assignments.get(roomId);
    if (a) a.deploymentId = randomUUID();
    this.version++;
  }

  unassign(roomId: string) {
    this.assignments.delete(roomId);
    this.version++;
  }

  rotateKeys(keys: { keyId: string; publicKeyPem: string }[]) {
    this.extraKeys = keys;
    this.version++;
  }
  private extraKeys: { keyId: string; publicKeyPem: string }[] | null = null;

  private json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private body(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(data ? (JSON.parse(data) as unknown) : undefined));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    if (!this.up) return this.json(res, 503, { error: 'down for maintenance' });
    const url = new URL(req.url ?? '/', this.url);
    const path = url.pathname.replace('/api/gateway/v1', '');
    const authed = req.headers.authorization === `Bearer ${CREDENTIAL}`;

    if (req.method === 'POST' && path === '/enroll') {
      const parsed = EnrollRequest.safeParse(await this.body(req));
      if (!parsed.success) return this.json(res, 400, { error: 'bad request' });
      if (parsed.data.token !== ENROLL_TOKEN)
        return this.json(res, 401, { error: 'Invalid or used token' });
      this.enrols.push(parsed.data);
      return this.json(res, 200, {
        gatewayId: GATEWAY_ID,
        name: 'Test gateway',
        orgId: ORG_ID,
        credential: CREDENTIAL,
        heartbeatSeconds: 5,
        publicKeys: this.publicKeys,
      });
    }
    if (!authed) return this.json(res, 401, { error: 'Unauthorised' });

    if (req.method === 'POST' && path === '/heartbeat') {
      const parsed = HeartbeatRequest.safeParse(await this.body(req));
      if (!parsed.success) return this.json(res, 400, { error: 'bad request' });
      this.heartbeats.push(parsed.data);
      return this.json(res, 200, {
        configVersion: String(this.version),
        serverTime: new Date().toISOString(),
        commands: this.queuedCommands.splice(0),
        watch: this.watching,
        pollNow: this.queuedIntents.length > 0,
        schedules: this.schedules,
      });
    }
    if (req.method === 'POST' && path === '/poll') {
      this.polls.push((await this.body(req)) as { panels: { roomId: string; vm: unknown }[] });
      return this.json(res, 200, { watch: this.watching, intents: this.queuedIntents.splice(0) });
    }
    if (req.method === 'GET' && path === '/config') {
      return this.json(res, 200, {
        gatewayId: GATEWAY_ID,
        configVersion: String(this.version),
        rooms: [...this.assignments.values()].map((a) => ({
          roomId: a.roomId,
          roomName: a.roomName,
          releaseId: a.releaseId,
          releaseNumber: a.releaseNumber,
          deploymentId: a.deploymentId,
          manifestHash: (a.signed as { hash: string }).hash,
          ...(a.bindingsVersion ? { bindingsVersion: a.bindingsVersion } : {}),
        })),
        publicKeys: this.extraKeys ?? this.publicKeys,
        groups: this.groups,
      });
    }
    const m = /^\/rooms\/([^/]+)\/manifest$/.exec(path);
    if (req.method === 'GET' && m) {
      const a = this.assignments.get(m[1]!);
      if (!a || a.releaseId !== url.searchParams.get('release'))
        return this.json(res, 404, { error: 'No such release' });
      this.manifestFetches.push(a.releaseId);
      return this.json(res, 200, a.signed);
    }
    const b = /^\/rooms\/([^/]+)\/bindings$/.exec(path);
    if (req.method === 'GET' && b) {
      const found = this.bindings.get(b[1]!);
      if (!found) return this.json(res, 404, { error: 'This room has no bindings' });
      this.bindingsFetches.push(b[1]!);
      const signed = signBindings(
        {
          orgId: ORG_ID,
          roomId: b[1]!,
          version: found.version,
          devices: found.devices,
          ...(found.shared ? { sharedDevices: found.shared } : {}),
        },
        { privateKeyPem: this.keys.privateKeyPem, keyId: this.keyId },
      );
      const wire = JSON.parse(JSON.stringify(signed)) as { payload: { devices: DeviceValues } };
      if (found.tamper) wire.payload.devices = { injected: { host: '6.6.6.6' } };
      return this.json(res, 200, wire);
    }
    if (req.method === 'POST' && path === '/telemetry') {
      const parsed = TelemetryBatch.safeParse(await this.body(req));
      if (!parsed.success) return this.json(res, 400, { error: 'bad request' });
      this.telemetry.push(...parsed.data.events);
      return this.json(res, 200, {
        accepted: parsed.data.events.length,
        protocol: PROTOCOL_VERSION,
      });
    }
    return this.json(res, 404, { error: 'Not found' });
  }
}
