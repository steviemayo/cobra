import {
  defaultDeviceState,
  type Device,
  type DeviceCommand,
  type DeviceState,
  type QuickActionId,
} from '@kestrel/model';
import { driverFeatures } from '../quick-actions';
import type { DeviceDriver, DriverContext } from './types';

export abstract class BaseDriver implements DeviceDriver {
  protected state: DeviceState = defaultDeviceState();
  private listeners = new Set<(s: DeviceState) => void>();

  constructor(
    protected readonly device: Device,
    protected readonly ctx: DriverContext,
  ) {}

  get deviceId() {
    return this.device.id;
  }

  abstract send(command: DeviceCommand): Promise<void>;
  quickActions(): QuickActionId[] {
    return [];
  }
  /** Optional class features. Built-in drivers say them in the driver list; others override. */
  features(): string[] {
    return driverFeatures(this.device.control);
  }
  start(): void {}
  close(): void {}

  getState(): DeviceState {
    return structuredClone(this.state);
  }

  onChange(listener: (s: DeviceState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Apply a change to the state and tell listeners if anything actually differs. */
  protected update(change: (s: DeviceState) => void) {
    const before = JSON.stringify(this.state);
    change(this.state);
    if (JSON.stringify(this.state) !== before) {
      const snapshot = this.getState();
      for (const l of this.listeners) l(snapshot);
    }
  }

  protected setting<T>(key: string, fallback: T): T {
    const v = this.device.settings[key];
    return (v === undefined ? fallback : v) as T;
  }

  protected fail(message: string): never {
    throw new Error(`${this.device.name}: ${message}`);
  }
}
