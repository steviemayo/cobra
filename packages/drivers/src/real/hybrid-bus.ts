import type {
  DeviceBus,
  DeviceCommand,
  DeviceEvent,
  DeviceState,
  QuickActionId,
} from '@kestrel/model';
import type { Simulation } from '../sim/simulation';
import type { DeviceDriver } from './types';

/**
 * One bus for a whole room. Devices that have a real driver talk to real hardware; the rest
 * (optionally) fall back to the simulator so a room can be brought up piece by piece.
 */
export class HybridBus implements DeviceBus {
  constructor(
    private readonly real: Map<string, DeviceDriver>,
    private readonly sim: Simulation | null,
  ) {}

  send(deviceId: string, command: DeviceCommand): Promise<void> {
    const driver = this.real.get(deviceId);
    if (driver) return driver.send(command);
    if (this.sim) return this.sim.send(deviceId, command);
    return Promise.reject(new Error(`No driver available for ${deviceId}`));
  }

  getState(deviceId: string): DeviceState | undefined {
    return this.real.get(deviceId)?.getState() ?? this.sim?.getState(deviceId);
  }

  quickActions(deviceId: string): QuickActionId[] {
    const driver = this.real.get(deviceId);
    if (driver) return driver.quickActions?.() ?? [];
    return this.sim?.quickActions(deviceId) ?? [];
  }

  features(deviceId: string): string[] {
    const driver = this.real.get(deviceId);
    if (driver) return driver.features?.() ?? [];
    return this.sim?.features(deviceId) ?? [];
  }

  subscribe(listener: (event: DeviceEvent) => void): () => void {
    const offs: (() => void)[] = [];
    if (this.sim)
      offs.push(
        this.sim.subscribe((e) => {
          if (!this.real.has(e.deviceId)) listener(e);
        }),
      );
    for (const [deviceId, driver] of this.real)
      offs.push(driver.onChange((state) => listener({ deviceId, state })));
    return () => offs.forEach((off) => off());
  }

  start() {
    for (const d of this.real.values()) d.start();
  }

  /** Ids of real devices that are not currently reachable. Simulated devices are never offline. */
  offline(): string[] {
    return [...this.real].filter(([, d]) => !d.getState().online).map(([id]) => id);
  }

  close() {
    for (const d of this.real.values()) d.close();
    this.sim?.dispose();
  }
}
