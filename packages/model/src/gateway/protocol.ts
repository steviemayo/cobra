import { z } from 'zod';
import { PinnedDriver } from '../driver-spec';
import { LocalId } from '../room/common';
import { TransitionAction } from '../room/groups';
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
  /**
   * True when addresses and logins were left out of the model and travel as the room's bindings
   * instead. A gateway that cannot fetch bindings must not run such a release.
   */
  bindingsExternal: z.boolean().optional(),
  model: RoomModel,
  /** Custom drivers this release uses, pinned at the version it was built with. */
  drivers: z.record(z.string(), PinnedDriver).default({}),
  panel: z
    .object({
      access: PanelAccess.default(() => PanelAccess.parse({})),
      branding: PanelBranding.default(() => PanelBranding.parse({})),
    })
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

// ---- Remote commands ---------------------------------------------------------------------------

/** The only things support can ask a gateway to do. Anything else is refused on both ends. */
export const COMMAND_TYPES = [
  'diagnostics',
  'test_device',
  'restart_room',
  'room_off',
  'verify_point',
  'discover_devices',
] as const;
export const CommandType = z.enum(COMMAND_TYPES);
export type CommandType = z.infer<typeof CommandType>;

export const COMMAND_INFO: Record<
  CommandType,
  { label: string; description: string; needsDevice: boolean }
> = {
  diagnostics: {
    label: 'Run diagnostics',
    description: 'Check every device and report the room state. Changes nothing.',
    needsDevice: false,
  },
  test_device: {
    label: 'Test a device',
    description: 'Check one device and report what it says. Changes nothing.',
    needsDevice: true,
  },
  restart_room: {
    label: 'Restart room',
    description: 'Reload the running release and reconnect every device. The room resets to off.',
    needsDevice: false,
  },
  verify_point: {
    label: 'Check a control point',
    description: 'Read one control point of a DSP and report its value and range. Changes nothing.',
    needsDevice: true,
  },
  discover_devices: {
    label: 'Find devices on the network',
    description:
      'Look for projectors, DSPs and other equipment on the gateway’s own network and report what answers. Only reads; changes nothing.',
    needsDevice: false,
  },
  room_off: {
    label: 'Turn room off',
    description: 'Run the Room Off activity, as if someone pressed it on the panel.',
    needsDevice: false,
  },
};

export const GatewayCommand = z.object({
  id: z.string().uuid(),
  type: CommandType,
  roomId: z.string().uuid(),
  args: z.record(z.string(), z.string().max(200)).default({}),
});
export type GatewayCommand = z.infer<typeof GatewayCommand>;

export const CommandResult = z.object({
  id: z.string().uuid(),
  ok: z.boolean(),
  output: z.record(z.string(), z.unknown()).default({}),
  error: z.string().max(500).optional(),
});
export type CommandResult = z.infer<typeof CommandResult>;

export const DeviceReport = z.object({
  deviceId: z.string().min(1).max(100),
  name: z.string().max(200),
  online: z.boolean(),
});
export type DeviceReport = z.infer<typeof DeviceReport>;

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
  /** Whether each device in the running release is reachable. */
  devices: z.array(DeviceReport).max(300).default([]),
  /** Version of the bindings (addresses and logins) the room is running with. Absent when it has none. */
  bindingsVersion: z.number().int().min(1).optional(),
});
export type RoomReport = z.infer<typeof RoomReport>;

/**
 * A room group as one gateway sees it: the rooms that can be joined, the movable walls between
 * them, and the combined rooms that exist for each joined set. Combined rooms are ordinary rooms
 * with their own release; `memberRoomIds` says which rooms one stands in for while it is live.
 */
export const GroupConfig = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** The ordinary rooms of the group. */
  roomIds: z.array(z.string().uuid()).min(2),
  dividers: z
    .array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        roomIds: z.array(z.string().uuid()).min(2),
        onOpen: TransitionAction,
        onClose: TransitionAction,
      }),
    )
    .max(100),
  combined: z
    .array(
      z.object({ roomId: z.string().uuid(), memberRoomIds: z.array(z.string().uuid()).min(2) }),
    )
    .max(200),
});
export type GroupConfig = z.infer<typeof GroupConfig>;

/** Whether a movable wall is open right now, as the gateway sees it. */
export const DividerReport = z.object({ id: z.string().uuid(), open: z.boolean() });
export type DividerReport = z.infer<typeof DividerReport>;

export const HeartbeatRequest = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  gatewayVersion: z.string().max(50),
  uptimeSeconds: z.number().int().min(0),
  configVersion: z.string().nullable(),
  rooms: z.array(RoomReport),
  /** Outcomes of commands received in earlier heartbeat responses. */
  commandResults: z.array(CommandResult).max(50).default([]),
  /** Which movable walls are open, for the groups this gateway runs. The gateway owns this state. */
  dividers: z.array(DividerReport).max(500).default([]),
  /** What this gateway can do beyond the basics (see GATEWAY_FEATURES). Older gateways send none. */
  features: z.array(z.string().max(40)).max(20).default([]),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

export const HeartbeatResponse = z.object({
  /** If this differs from the gateway's configVersion it should fetch /config. */
  configVersion: z.string(),
  serverTime: z.string().datetime(),
  /** Allowlisted commands to run now. */
  commands: z.array(GatewayCommand).default([]),
  /** Rooms someone is controlling from the portal right now. Non-empty means: start polling fast. */
  watch: z.array(z.string().uuid()).default([]),
  /** Something is waiting for this gateway (a webhook): poll once now to collect it. */
  pollNow: z.boolean().default(false),
  /** The release channel this gateway follows, and the newest version on it, when the cloud knows. */
  update: z
    .object({ channel: z.enum(['stable', 'beta']), latest: z.string().max(50).nullable() })
    .optional(),
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
  /** Version of the room's bindings (addresses and logins) to run with. Absent when it has none. */
  bindingsVersion: z.number().int().min(1).optional(),
  /** Lets this gateway sign the short-lived links on the panel's QR code. Absent when the server has no secrets key. */
  phoneSecret: z.string().min(20).optional(),
});
export type AssignedRoom = z.infer<typeof AssignedRoom>;

export const ConfigResponse = z.object({
  gatewayId: z.string().uuid(),
  configVersion: z.string(),
  rooms: z.array(AssignedRoom),
  publicKeys: z.array(PublicKey),
  /** Room groups whose rooms run on this gateway. */
  groups: z.array(GroupConfig).default([]),
});
export type ConfigResponse = z.infer<typeof ConfigResponse>;

// ---- Control from the portal ---------------------------------------------------------------------

// While someone has a room's control page open, the gateway polls every second: it sends the
// room's panel state up and takes panel intents down. It is still only outbound requests.
/** An external call (webhook) for a room's webhook trigger. */
export const HookIntent = z.object({ type: z.literal('hook'), hookName: LocalId });
export type HookIntent = z.infer<typeof HookIntent>;

/** Run one of the room's own triggers, for example when a calendar meeting begins. */
export const TriggerIntent = z.object({ type: z.literal('trigger'), triggerId: LocalId });
export type TriggerIntent = z.infer<typeof TriggerIntent>;

/** Anything the cloud can ask a room to do on someone's behalf. */
export const GatewayIntent = z.union([PanelIntent, HookIntent, TriggerIntent]);
export type GatewayIntent = z.infer<typeof GatewayIntent>;

export const ControlIntentMessage = z.object({
  id: z.string().uuid(),
  roomId: z.string().uuid(),
  intent: GatewayIntent,
});
export type ControlIntentMessage = z.infer<typeof ControlIntentMessage>;

export const PollRequest = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  panels: z
    .array(z.object({ roomId: z.string().uuid(), vm: PanelViewModel }))
    .max(50)
    .default([]),
});
export type PollRequest = z.infer<typeof PollRequest>;

export const PollResponse = z.object({
  /** Rooms still being controlled. Empty means the gateway can stop polling fast. */
  watch: z.array(z.string().uuid()).default([]),
  intents: z.array(ControlIntentMessage).default([]),
});
export type PollResponse = z.infer<typeof PollResponse>;

// ---- Telemetry ---------------------------------------------------------------------------------

export const TelemetryEvent = z.object({
  /** ISO time the event happened on the gateway (buffered events keep their original time). */
  at: z.string().datetime(),
  type: z.enum([
    'room.status',
    'activity.started',
    'activity.stopped',
    'device.fault',
    'device.offline',
    'device.online',
    'command.finished',
    'gateway.started',
    'manifest.rejected',
  ]),
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
  /** A link that lets someone at the room control it from their phone; replaced before it expires. */
  z.object({ t: z.literal('qr'), url: z.string().url(), expiresAt: z.string().datetime() }),
  z.object({ t: z.literal('error'), message: z.string() }),
]);
export type PanelServerMessage = z.infer<typeof PanelServerMessage>;

export const PanelClientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('auth'), pin: z.string().max(32) }),
  z.object({ t: z.literal('intent'), intent: PanelIntent }),
]);
export type PanelClientMessage = z.infer<typeof PanelClientMessage>;
