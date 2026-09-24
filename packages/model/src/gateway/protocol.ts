import { z } from 'zod';
import { RoomModel } from '../room/room-model';
import { PanelIntent, PanelViewModel, RoomStatus } from '../runtime/panel';

// Gateway <-> cloud protocol, version 1. The gateway only ever makes outbound HTTPS requests.
export const PROTOCOL_VERSION = 1;

// ---- Manifest: the deployable room program -----------------------------------------------------

export const PanelAccess = z.object({
  /** open: anyone on the LAN. pin: panels must present the PIN. */
  mode: z.enum(['open', 'pin']).default('open'),
  /** Salted scrypt hash "salt:hash" (hex), never the PIN itself. */
  pinHash: z.string().optional(),
  /** Client IPs that skip the PIN. Exact match; IPv4 or IPv6. */
  trustedIps: z.array(z.string()).default([]),
});
export type PanelAccess = z.infer<typeof PanelAccess>;

export const PanelBranding = z.object({
  mode: z.enum(['dark', 'light']).default('dark'),
  accent: z.string().optional(),
  accentText: z.string().optional(),
  logoUrl: z.string().url().optional(),
  language: z.string().default('en'),
});
export type PanelBranding = z.infer<typeof PanelBranding>;

export const RoomManifest = z.object({
  manifestVersion: z.literal(1),
  orgId: z.string().uuid(),
  roomId: z.string().uuid(),
  roomName: z.string().min(1),
  releaseId: z.string().uuid(),
  releaseNumber: z.number().int().min(1),
  createdAt: z.string().datetime(),
  model: RoomModel,
  panel: z
    .object({ access: PanelAccess.default(() => PanelAccess.parse({})), branding: PanelBranding.default(() => PanelBranding.parse({})) })
    .default(() => ({ access: PanelAccess.parse({}), branding: PanelBranding.parse({}) })),
});
export type RoomManifest = z.infer<typeof RoomManifest>;

/** A manifest plus proof it came from Kestrel: sha256 of its canonical JSON, signed with Ed25519. */
export const SignedManifest = z.object({
  manifest: RoomManifest,
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().min(1),
  keyId: z.string().min(1),
});
export type SignedManifest = z.infer<typeof SignedManifest>;

export const PublicKey = z.object({ keyId: z.string().min(1), publicKeyPem: z.string().min(1) });
export type PublicKey = z.infer<typeof PublicKey>;

// ---- Enrolment ---------------------------------------------------------------------------------

export const EnrollRequest = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  /** One-time enrolment token shown when the gateway was created in the portal. */
  token: z.string().min(10),
  hostname: z.string().max(200),
  gatewayVersion: z.string().max(50),
  os: z.string().max(100),
});
export type EnrollRequest = z.infer<typeof EnrollRequest>;

export const EnrollResponse = z.object({
  gatewayId: z.string().uuid(),
  name: z.string(),
  orgId: z.string().uuid(),
  /** Long-lived secret for every later request. Only returned once. */
  credential: z.string().min(20),
  heartbeatSeconds: z.number().int().min(5).default(30),
  publicKeys: z.array(PublicKey).min(1),
});
export type EnrollResponse = z.infer<typeof EnrollResponse>;

// ---- Heartbeat and config ----------------------------------------------------------------------

// The stages a gateway moves a release through. `rolled_back` means the new release was refused
// and the previous one is still running; `failed` means there was nothing to fall back to.
export const DeploymentStage = z.enum([
  'downloading',
  'verifying',
  'staging',
  'health_check',
  'active',
  'failed',
  'rolled_back',
]);
export type DeploymentStage = z.infer<typeof DeploymentStage>;

export const DeploymentReport = z.object({
  deploymentId: z.string().uuid(),
  /** Where the attempt got to (its latest stage). */
  stage: DeploymentStage,
  /** Every stage reached, with the gateway's own timestamps. */
  history: z.array(z.object({ stage: DeploymentStage, at: z.string().datetime() })).max(20),
  error: z.string().max(500).optional(),
});
export type DeploymentReport = z.infer<typeof DeploymentReport>;

export const RoomReport = z.object({
  roomId: z.string().uuid(),
  /** Release currently running, or null if none loaded. */
  releaseId: z.string().uuid().nullable(),
  /** Hash of the manifest actually running, so drift can be told from a mislabelled release. */
  manifestHash: z.string().optional(),
  status: RoomStatus.or(z.literal('unloaded')),
  /** Non-fatal problem, e.g. a manifest that failed verification. */
  error: z.string().max(500).optional(),
  /** The most recent deployment attempt for this room, until the cloud assigns another. */
  deployment: DeploymentReport.optional(),
});
export type RoomReport = z.infer<typeof RoomReport>;

export const HeartbeatRequest = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  gatewayVersion: z.string().max(50),
  uptimeSeconds: z.number().int().min(0),
  configVersion: z.string().nullable(),
  rooms: z.array(RoomReport),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

export const HeartbeatResponse = z.object({
  /** If this differs from the gateway's configVersion it should fetch /config. */
  configVersion: z.string(),
  serverTime: z.string().datetime(),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

export const AssignedRoom = z.object({
  roomId: z.string().uuid(),
  roomName: z.string(),
  releaseId: z.string().uuid(),
  releaseNumber: z.number().int(),
  manifestHash: z.string(),
  /** Which deployment asked for this release. A new id lets a gateway retry a release that failed. */
  deploymentId: z.string().uuid(),
});
export type AssignedRoom = z.infer<typeof AssignedRoom>;

export const ConfigResponse = z.object({
  gatewayId: z.string().uuid(),
  configVersion: z.string(),
  rooms: z.array(AssignedRoom),
  publicKeys: z.array(PublicKey),
});
export type ConfigResponse = z.infer<typeof ConfigResponse>;

// ---- Telemetry ---------------------------------------------------------------------------------

export const TelemetryEvent = z.object({
  /** ISO time the event happened on the gateway (buffered events keep their original time). */
  at: z.string().datetime(),
  type: z.enum(['room.status', 'activity.started', 'activity.stopped', 'device.fault', 'gateway.started', 'manifest.rejected']),
  roomId: z.string().uuid().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type TelemetryEvent = z.infer<typeof TelemetryEvent>;

export const TelemetryBatch = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  events: z.array(TelemetryEvent).max(500),
});
export type TelemetryBatch = z.infer<typeof TelemetryBatch>;

// ---- Panel link (gateway <-> browser panel over WebSocket) -------------------------------------

export const PanelServerMessage = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    roomId: z.string().uuid(),
    pinRequired: z.boolean(),
    branding: PanelBranding,
  }),
  z.object({ t: z.literal('snapshot'), vm: PanelViewModel }),
  z.object({ t: z.literal('error'), message: z.string() }),
]);
export type PanelServerMessage = z.infer<typeof PanelServerMessage>;

export const PanelClientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('auth'), pin: z.string().max(32) }),
  z.object({ t: z.literal('intent'), intent: PanelIntent }),
]);
export type PanelClientMessage = z.infer<typeof PanelClientMessage>;
