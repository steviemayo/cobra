import { z } from 'zod';
import type { DriverSpec } from './driver-spec';
import { BUILT_IN_DRIVERS } from './room/drivers';
import { settingScope, type SettingScope } from './room/driver-classes';
import type { Device } from './room/device';
import type { RoomModel } from './room/room-model';

// Bindings (docs/driver-classes.md): where a room's devices are and how to log in to them. They are
// kept apart from the room's design so templates carry no addresses or passwords, an IP change needs
// no new release, and a password can be rotated in one place.

/** Setting values by device id, then by setting key. */
export type DeviceValues = Record<string, Record<string, unknown>>;

/** Custom drivers by `custom:<id>`, as pinned into a release or looked up for a draft. */
export type CustomDrivers = Record<string, { spec: DriverSpec }>;

/** One thing someone has to fill in for a device: an address, a login. */
export interface BindingSlot {
  key: string;
  label: string;
  scope: Exclude<SettingScope, 'design'>;
  required: boolean;
}

const HOST: BindingSlot = { key: 'host', label: 'Address', scope: 'binding', required: true };
const PORT: BindingSlot = { key: 'port', label: 'Port', scope: 'binding', required: false };

const GENERIC_SLOTS: Record<string, BindingSlot[]> = {
  pjlink: [
    HOST,
    PORT,
    { key: 'password', label: 'PJLink password', scope: 'secret', required: false },
  ],
  tcp: [HOST, { ...PORT, required: true }],
  serial: [{ key: 'path', label: 'Serial port', scope: 'binding', required: true }],
  rest: [
    HOST,
    PORT,
    { key: 'headers', label: 'Request headers (may hold a token)', scope: 'secret', required: false },
  ],
};

/** Every setting a driver says it reads, with what each is for. Undefined for a driver we know nothing about. */
function declared(
  device: Device,
  custom: CustomDrivers,
): { key: string; label: string; scope: SettingScope; required: boolean }[] | undefined {
  const control = device.control;
  if (!control) return undefined;
  if (control.kind === 'generic') return GENERIC_SLOTS[control.protocol];
  if (control.driverId.startsWith('custom:')) {
    const spec = custom[control.driverId]?.spec;
    if (!spec) return undefined;
    const own = spec.settings.map((s) => ({
      key: s.key,
      label: s.label,
      scope: settingScope(s.key, { scope: s.scope, type: s.type }),
      required: s.required,
    }));
    const keys = new Set(own.map((s) => s.key));
    return [...(keys.has('host') ? [] : [HOST]), ...(keys.has('port') ? [] : [PORT]), ...own];
  }
  const info = BUILT_IN_DRIVERS[control.driverId];
  return info?.settings.map((s) => ({ key: s.key, label: s.label, scope: s.scope, required: !!s.required }));
}

/** What someone has to fill in for this device outside the design. Empty for a device with no driver. */
export function slotsFor(device: Device, custom: CustomDrivers = {}): BindingSlot[] {
  return (declared(device, custom) ?? []).filter(
    (s): s is BindingSlot => s.scope === 'binding' || s.scope === 'secret',
  );
}

/** The scope of one setting of a device: from its driver, else from the setting's name. */
export function scopeOfSetting(device: Device, key: string, custom: CustomDrivers = {}): SettingScope {
  const known = declared(device, custom)?.find((s) => s.key === key);
  return known ? known.scope : settingScope(key);
}

/** A device's settings split by scope. */
export function splitSettings(device: Device, custom: CustomDrivers = {}) {
  const design: Record<string, unknown> = {};
  const binding: Record<string, unknown> = {};
  const secret: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(device.settings)) {
    const scope = scopeOfSetting(device, key, custom);
    (scope === 'design' ? design : scope === 'binding' ? binding : secret)[key] = value;
  }
  return { design, binding, secret };
}

/**
 * The room without its bindings, and the bindings taken out of it. Device settings keep only what
 * the room is (design). `values` holds addresses and logins together; `parts` has the same values
 * apart, so secrets can be sealed and the rest stored as they are.
 */
export function stripBindings(
  model: RoomModel,
  custom: CustomDrivers = {},
): { model: RoomModel; values: DeviceValues; parts: { binding: DeviceValues; secret: DeviceValues } } {
  const values: DeviceValues = {};
  const parts = { binding: {} as DeviceValues, secret: {} as DeviceValues };
  const devices = model.devices.map((d) => {
    const { design, binding, secret } = splitSettings(d, custom);
    const taken = { ...binding, ...secret };
    if (Object.keys(taken).length > 0) values[d.id] = taken;
    if (Object.keys(binding).length > 0) parts.binding[d.id] = binding;
    if (Object.keys(secret).length > 0) parts.secret[d.id] = secret;
    return { ...d, settings: design };
  });
  return { model: { ...model, devices }, values, parts };
}

/** The room with these bindings laid over each device's settings. Bindings win. */
export function applyBindings(model: RoomModel, values: DeviceValues): RoomModel {
  return {
    ...model,
    devices: model.devices.map((d) => {
      const v = values[d.id];
      return v && Object.keys(v).length > 0 ? { ...d, settings: { ...d.settings, ...v } } : d;
    }),
  };
}

export interface MissingBinding {
  deviceId: string;
  deviceName: string;
  key: string;
  label: string;
}

const isBlank = (v: unknown) => v === undefined || v === null || v === '';

/** Required addresses and logins nobody has filled in yet. A device with no driver needs none. */
export function missingBindings(
  model: RoomModel,
  have: DeviceValues,
  custom: CustomDrivers = {},
): MissingBinding[] {
  const out: MissingBinding[] = [];
  for (const d of model.devices)
    for (const slot of slotsFor(d, custom))
      if (slot.required && isBlank(have[d.id]?.[slot.key]) && isBlank(d.settings[slot.key]))
        out.push({ deviceId: d.id, deviceName: d.name, key: slot.key, label: slot.label });
  return out;
}

// ---- What travels to a gateway -------------------------------------------------------------------

export const BindingsPayload = z.object({
  orgId: z.string().uuid(),
  roomId: z.string().uuid(),
  /** Goes up whenever anything in the room's bindings changes, including a credential set it uses. */
  version: z.number().int().min(1),
  devices: z.record(z.string(), z.record(z.string(), z.unknown())),
});
export type BindingsPayload = z.infer<typeof BindingsPayload>;

/** A bindings payload signed like a manifest, so a gateway trusts it only if Kestrel made it. */
export const SignedBindings = z.object({
  payload: BindingsPayload,
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().min(1),
  keyId: z.string().min(1),
});
export type SignedBindings = z.infer<typeof SignedBindings>;

/** Names of what a gateway can do beyond the basics, sent in its heartbeat. */
export const GATEWAY_FEATURES = ['bindings', 'display-extras'] as const;
export type GatewayFeature = (typeof GATEWAY_FEATURES)[number];

/**
 * What a gateway must be able to do to run this room, beyond the basics. A release that needs
 * something must not go to a gateway that has not said it can (an older one would fail to read it).
 */
export function gatewayNeeds(model: RoomModel): GatewayFeature[] {
  const actions = [...model.activities.flatMap((a) => a.actions), ...model.states.flatMap((s) => s.actions)];
  const needs: GatewayFeature[] = [];
  if (actions.some((a) => a.type === 'press_key' || a.type === 'launch_app')) needs.push('display-extras');
  return needs;
}
