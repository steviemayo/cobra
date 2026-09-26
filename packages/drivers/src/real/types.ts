import type { ControlPoint, Device, DeviceCommand, DeviceState, PointReading, QuickActionId } from '@kestrel/model';

/** A driver for one physical device. Translates engine commands into that device's protocol. */
export interface DeviceDriver {
  readonly deviceId: string;
  /** Resolves when the device reports the command applied; rejects if it fails. */
  send(command: DeviceCommand): Promise<void>;
  getState(): DeviceState;
  /** The panel quick actions this device supports. Absent means none. */
  quickActions?(): QuickActionId[];
  /** The optional features of its class this driver supports. Absent means none. */
  features?(): string[];
  /** Read one control point, to check it exists and learn its range. Rejects if it cannot. */
  readPoint?(point: Pick<ControlPoint, 'type' | 'address' | 'min' | 'max'>): Promise<PointReading>;
  /** Called with a fresh snapshot whenever feedback changes. */
  onChange(listener: (state: DeviceState) => void): () => void;
  /** Start any background polling / connections. */
  start(): void;
  close(): void;
}

export interface DriverContext {
  log: (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void;
}

export type DriverFactory = (device: Device, ctx: DriverContext) => DeviceDriver | null;
