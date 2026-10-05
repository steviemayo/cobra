import type {
  BrowsedPoints,
  ControlPoint,
  Device,
  DeviceCommand,
  DeviceState,
  DiscoveredComponent,
  DiscoveredControl,
  PointReading,
  QuickActionId,
} from '@kestrel/model';

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
  /** AVoIP encoders: where the stream this device makes can be picked up. Rejects if it cannot say. */
  streamLocation?(): Promise<string>;
  /** Read one control point, to check it exists and learn its range. Rejects if it cannot. */
  readPoint?(point: Pick<ControlPoint, 'type' | 'address' | 'min' | 'max'>): Promise<PointReading>;
  /** List every value inside the live device a point could watch, for a pick-list. Rejects if it cannot. */
  browsePoints?(): Promise<BrowsedPoints>;
  /** List the device's own named components, for a pick-list instead of typing one blind. Rejects if it cannot. */
  discoverComponents?(): Promise<DiscoveredComponent[]>;
  /** List the controls of one named component. Rejects if it cannot. */
  discoverControls?(component: string): Promise<DiscoveredControl[]>;
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
