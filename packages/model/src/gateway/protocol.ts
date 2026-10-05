import { z } from 'zod';
import { PinnedDriver } from '../driver-spec';
import { LocalId } from '../room/common';
import { TransitionAction } from '../room/groups';
import { RoomModel } from '../room/room-model';
import { Meetings, RoomMeetings } from '../schedule';
import { PanelIntent, PanelViewModel, RoomStatus } from '../runtime/panel';
import { DeviceCommand, DeviceDetails, PowerState } from '../runtime/device';

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
  'discover_components',
  'discover_controls',
  'browse_points',
  'snapshot',
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
  discover_components: {
    label: 'List a device’s components',
    description: 'Ask a point-based device what named components it has. Changes nothing.',
    needsDevice: true,
  },
  discover_controls: {
    label: 'List a component’s controls',
    description: 'Ask a point-based device what controls one named component has. Changes nothing.',
    needsDevice: true,
  },
  browse_points: {
    label: 'List what a device can report',
    description:
      'Read a monitored device’s own tree and list the values a control point can watch. Changes nothing.',
    needsDevice: false,
  },
  snapshot: {
    label: 'Take a camera snapshot',
    description:
      'Ask a camera for one still picture and send it back to be shown once. Changes nothing and nothing is kept.',
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

/**
 * Whatever a device's own driver reports back, whether or not the room has control: power state,
 * the input it is on, mute, volume and so on. A field the driver has no answer for is left out, and
 * a device that answers nothing at all gets no `feedback` on its report.
 */
export const DeviceFeedback = z.object({
  power: PowerState.optional(),
  /** For a destination device: the name of the port it is currently on. */
  input: z.string().max(80).optional(),
  muted: z.boolean().optional(),
  /** 0 to 100. */
  volume: z.number().min(0).max(100).optional(),
  /** Displays: is the picture blanked. */
  blanked: z.boolean().optional(),
  recording: z.boolean().optional(),
  occupied: z.boolean().optional(),
  /** AVoIP decoders: is it receiving the stream it was pointed at. */
  streamConnected: z.boolean().optional(),
  activeApp: z.string().max(200).optional(),
  /** Music players: playing, paused, stopped or buffering. */
  playback: z.string().max(40).optional(),
  /** Music players: where the audio comes from (Spotify, Line in). */
  playSource: z.string().max(100).optional(),
  /** Conference systems: is a meeting or call running. */
  inMeeting: z.boolean().optional(),
  /** Conference systems: idle, present, in_meeting or other. */
  roomState: z.string().max(40).optional(),
});
export type DeviceFeedback = z.infer<typeof DeviceFeedback>;
/** The fields of `DeviceFeedback`, for code that walks them generically (change detection, history). */
export const DEVICE_FEEDBACK_FIELDS = [
  'power',
  'input',
  'muted',
  'volume',
  'blanked',
  'recording',
  'occupied',
  'streamConnected',
  'activeApp',
  'playback',
  'playSource',
  'inMeeting',
  'roomState',
] as const satisfies readonly (keyof DeviceFeedback)[];
export type DeviceFeedbackField = (typeof DEVICE_FEEDBACK_FIELDS)[number];

/** One watched control point and whether its reading is in bounds. Points with no reading yet are left out. */
export const WatchedPoint = z.object({
  pointId: z.string().min(1).max(100),
  name: z.string().max(200),
  ok: z.boolean(),
  /** In plain words, when it is not ok. */
  message: z.string().max(300).optional(),
  severity: z.enum(['info', 'warning', 'critical']).default('warning'),
});
export type WatchedPoint = z.infer<typeof WatchedPoint>;

/**
 * How a device answered the gateway's pings since the last heartbeat. Absent when the device has no
 * address to ping, or when it is online but never answers pings (they are blocked), which says
 * nothing about the network.
 */
export const DeviceLatency = z.object({
  /** Pings sent in this window, and how many were answered. */
  sent: z.number().int().min(1).max(1000),
  ok: z.number().int().min(0).max(1000),
  /** Round-trip times of the answered pings. Absent when none were. */
  minMs: z.number().min(0).max(60_000).optional(),
  avgMs: z.number().min(0).max(60_000).optional(),
  maxMs: z.number().min(0).max(60_000).optional(),
});
export type DeviceLatency = z.infer<typeof DeviceLatency>;

/**
 * What a gateway reports about a tracked device's network address (docs/decisions.md, DA-*). The
 * cloud keeps the address it was told, so a gateway that finds a device at a new address says so and
 * keeps saying so until the cloud's device set carries that address.
 */
export const DeviceAddressReport = z.object({
  /** The device's MAC as the gateway read it from its own network (the ARP table). Same network only. */
  mac: z.string().max(40).optional(),
  /** The device has moved: where it was, where it is now, and how the gateway knows it is the same device. */
  change: z
    .object({
      from: z.string().max(100),
      to: z.string().max(100),
      how: z.enum(['hostname', 'mac', 'identity']),
    })
    .optional(),
  /** Addresses that might be the device but could not be told apart, for a person to pick. */
  candidates: z
    .array(z.object({ address: z.string().max(100), note: z.string().max(200) }))
    .max(10)
    .optional(),
  /** Why the gateway could not follow it: it answers at its address but is a different device, or nothing was found. */
  issue: z.enum(['identity_changed', 'not_found']).optional(),
});
export type DeviceAddressReport = z.infer<typeof DeviceAddressReport>;

export const DeviceReport = z.object({
  deviceId: z.string().min(1).max(100),
  name: z.string().max(200),
  online: z.boolean(),
  /**
   * The gateway has already waited out a run of quick failed checks before saying this device is
   * offline, so the cloud raises the problem now instead of applying its own grace period.
   */
  confirmed: z.boolean().optional(),
  /** How long the device has been unreachable, in milliseconds, when `confirmed`. */
  offlineForMs: z.number().int().min(0).max(86_400_000).optional(),
  /** The driver this device uses (for example "pjlink" or "custom:my-driver"), so versions can be compared by driver. */
  driver: z.string().max(100).optional(),
  /** The firmware version the device reported, if its driver can ask. */
  firmware: z.string().max(100).optional(),
  /** Ping round-trip times since the last heartbeat, a measure of the network to the device. */
  latency: DeviceLatency.optional(),
  /** The points this device is watched on. Absent when none are. */
  watched: z.array(WatchedPoint).max(100).optional(),
  /** What each control point reads now (by point id), as Kestrel shows it: 0 to 100 for a level. Absent when it has none. */
  points: z.record(z.string().max(100), z.union([z.number(), z.boolean(), z.string().max(500)])).optional(),
  /** Whatever the driver reports back, control or not. Absent when it has nothing to say. */
  feedback: DeviceFeedback.optional(),
  /**
   * What the device says about itself (serial, programs, IP table, ...). Sent when it changes and
   * now and then as a refresh, so absent means "same as last time", not "none".
   */
  details: DeviceDetails.optional(),
  /** Tracked devices only: the address the gateway sees, and what it did about it. */
  address: DeviceAddressReport.optional(),
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

// ---- Announcing an unclaimed gateway -------------------------------------------------------------

/**
 * What a gateway sends when it is running but cannot enrol (no token, or a token that is used up or
 * expired): who it is, so staff can see it and give it to the right organisation. Nothing secret
 * but `secret`, which only proves later that it is the same install, and is stored hashed.
 */
export const AnnounceRequest = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  /** Random and stable for this install; public. */
  installId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  secret: z.string().min(20).max(100),
  gatewayVersion: z.string().max(50),
  hostname: z.string().max(100).optional(),
  os: z.string().max(100).optional(),
  /** The machine's own private addresses, to help tell where it is. */
  localAddresses: z.array(z.string().max(45)).max(8).default([]),
});
export type AnnounceRequest = z.infer<typeof AnnounceRequest>;

export const AnnounceResponse = z.object({
  /** `claimed` carries the enrolment token (until the gateway has enrolled with it). */
  status: z.enum(['unclaimed', 'claimed', 'dismissed']),
  enrollToken: z.string().max(200).optional(),
  /** When to ask again. */
  retrySeconds: z.number().int().min(5).max(86_400),
});
export type AnnounceResponse = z.infer<typeof AnnounceResponse>;

// ---- Gateway updates ---------------------------------------------------------------------------

/** How far a gateway got with an update the portal asked for. Success is the version changing. */
export const UpdateState = z.enum(['downloading', 'staged', 'applying', 'failed', 'unsupported']);
export type UpdateState = z.infer<typeof UpdateState>;

export const GatewayUpdateReport = z.object({
  state: UpdateState,
  /** The version this attempt was for. */
  version: z.string().max(50).optional(),
  /** In plain words, for `failed` and `unsupported`. */
  error: z.string().max(300).optional(),
});
export type GatewayUpdateReport = z.infer<typeof GatewayUpdateReport>;

/**
 * The portal asking a gateway to update to `version` now. Sent only to a gateway that said it can
 * ('self-update') and only once the requested time has come. `bundle` is the release the gateway
 * must fetch (from `/api/gateway/v1/bundle`) and check against `sha256` before it acts on it; a
 * gateway refuses an order for a bundle that has no digest.
 */
export const GatewayUpdateOrder = z.object({
  version: z.string().max(50),
  bundle: z
    .object({
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      size: z.number().int().positive().optional(),
    })
    .optional(),
});
export type GatewayUpdateOrder = z.infer<typeof GatewayUpdateOrder>;

/** Where a gateway downloads its update bundle from: a short-lived link straight to the release asset. */
export const BundleLocation = z.object({
  url: z.string().url().max(2000),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().positive().optional(),
  version: z.string().max(50),
  /**
   * CI's signature over this version and the zip's SHA-256 (base64). The gateway checks it against
   * the release key built into it, so it does not have to take the portal's word for the bundle.
   * Absent on releases made before bundles were signed.
   */
  signature: z.string().max(300).optional(),
});
export type BundleLocation = z.infer<typeof BundleLocation>;

export const HeartbeatRequest = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  gatewayVersion: z.string().max(50),
  uptimeSeconds: z.number().int().min(0),
  configVersion: z.string().nullable(),
  rooms: z.array(RoomReport),
  /** Devices polled on their own (not part of a room's design), by device id. Older gateways send none. */
  devices: z.array(DeviceReport).max(500).default([]),
  /** Version of the device set this gateway is running, so the cloud can say when to fetch a new one. */
  deviceSetVersion: z.string().max(100).optional(),
  /** Outcomes of commands received in earlier heartbeat responses. */
  commandResults: z.array(CommandResult).max(50).default([]),
  /** Which movable walls are open, for the groups this gateway runs. The gateway owns this state. */
  dividers: z.array(DividerReport).max(500).default([]),
  /** What this gateway can do beyond the basics (see GATEWAY_FEATURES). Older gateways send none. */
  features: z.array(z.string().max(40)).max(20).default([]),
  /** Progress on an update the portal asked for. Absent when there is none in hand. */
  updateReport: GatewayUpdateReport.optional(),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

export const HeartbeatResponse = z.object({
  /** If this differs from the gateway's configVersion it should fetch /config. */
  configVersion: z.string(),
  /** Version of the device set this gateway should run. If it differs from the gateway's, it fetches /devices. */
  deviceSetVersion: z.string().optional(),
  serverTime: z.string().datetime(),
  /** Settings to put back on polled devices now (configuration profiles set to enforce, and pushes). */
  enforce: z.array(z.object({ deviceId: z.string().uuid(), command: DeviceCommand })).max(200).default([]),
  /** Allowlisted commands to run now. */
  commands: z.array(GatewayCommand).default([]),
  /** Rooms someone is controlling from the portal right now. Non-empty means: start polling fast. */
  watch: z.array(z.string().uuid()).default([]),
  /** Something is waiting for this gateway (a webhook): poll once now to collect it. */
  pollNow: z.boolean().default(false),
  /**
   * Whether the organisation's plan includes control. When false the gateway keeps watching devices
   * but refuses every command, by every route. An older cloud that never sends it means control.
   */
  control: z.boolean().default(true),
  /** The release channel this gateway follows, and the newest version on it, when the cloud knows. */
  update: z
    .object({ channel: z.enum(['stable', 'beta']), latest: z.string().max(50).nullable() })
    .optional(),
  /** Update to this version now. Only ever sent to a gateway that advertised 'self-update'. */
  updateOrder: GatewayUpdateOrder.optional(),
  /** Today's bookings for the rooms whose calendars were read recently. Sent only to a gateway that says it shows them. */
  schedules: z.array(RoomMeetings).max(200).default([]),
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
    'room.occupancy',
    'activity.started',
    'activity.stopped',
    'device.fault',
    'device.offline',
    'device.online',
    /** A feedback field changed (see DeviceFeedback): logged for history and usage reports, control or not. */
    'device.feedback',
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
  /** The room's bookings, replaced whole. Null means they are not known right now (hide them). */
  z.object({ t: z.literal('schedule'), meetings: Meetings.nullable() }),
  z.object({ t: z.literal('error'), message: z.string() }),
]);
export type PanelServerMessage = z.infer<typeof PanelServerMessage>;

export const PanelClientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('auth'), pin: z.string().max(32) }),
  z.object({ t: z.literal('intent'), intent: PanelIntent }),
]);
export type PanelClientMessage = z.infer<typeof PanelClientMessage>;
