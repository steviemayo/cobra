import type { Device, DeviceCommand, DeviceState } from '@kestrel/model';

/** A driver for one physical device. Translates engine commands into that device's protocol. */
export interface DeviceDriver {
  readonly deviceId: string;
  /** Resolves when the device reports the command applied; rejects if it fails. */
  send(command: DeviceCommand): Promise<void>;
  getState(): DeviceState;
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
