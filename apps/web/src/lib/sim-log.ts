import type { Device, DeviceState } from '@kestrel/model';

const portName = (d: Device, id: string | null | undefined) =>
  id ? (d.ports.find((p) => p.id === id)?.name ?? id) : 'nothing';

const POWER_TEXT = {
  off: 'is off',
  warming: 'is warming up',
  on: 'is on',
  cooling: 'is cooling down',
} as const;

// Plain-language description of what changed on a device between two feedback snapshots.
export function describeChange(
  device: Device,
  prev: DeviceState | undefined,
  next: DeviceState,
): string[] {
  const out: string[] = [];
  const name = device.name;
  if (!prev) return out;
  if (prev.online !== next.online)
    out.push(`${name} ${next.online ? 'is back online' : 'went offline'}`);
  if (prev.power !== next.power && next.power) out.push(`${name} ${POWER_TEXT[next.power]}`);
  if (prev.selectedInput !== next.selectedInput && next.selectedInput)
    out.push(`${name} switched to ${portName(device, next.selectedInput)}`);
  for (const [outPort, from] of Object.entries(next.routes))
    if (prev.routes[outPort] !== from)
      out.push(
        from
          ? `${name} routed ${portName(device, from)} to ${portName(device, outPort)}`
          : `${name} cleared ${portName(device, outPort)}`,
      );
  if (prev.muted !== next.muted && next.muted !== undefined)
    out.push(`${name} ${next.muted ? 'muted' : 'unmuted'}`);
  if (prev.volume !== next.volume && next.volume !== undefined)
    out.push(`${name} volume ${Math.round(next.volume)}`);
  if (prev.preset !== next.preset && next.preset) out.push(`${name} preset “${next.preset}”`);
  if (prev.recording !== next.recording && next.recording !== undefined)
    out.push(`${name} ${next.recording ? 'started' : 'stopped'} recording`);
  for (const [port, present] of Object.entries(next.signal))
    if (prev.signal[port] !== present)
      out.push(`${name}: ${present ? 'signal on' : 'signal lost on'} ${portName(device, port)}`);
  return out;
}
