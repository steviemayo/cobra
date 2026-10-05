import { z } from 'zod';
import { AssetCategory } from './devices';

// A customer asking Kestrel for a driver for a device that has none. Shared by the portal form and
// the server so both agree on what a request holds.

export const DRIVER_REQUEST_PROTOCOLS = [
  'unknown',
  'tcp',
  'udp',
  'http',
  'websocket',
  'snmp',
  'ssh',
  'serial',
] as const;
export const DRIVER_REQUEST_PROTOCOL_LABEL: Record<(typeof DRIVER_REQUEST_PROTOCOLS)[number], string> = {
  unknown: 'Not sure',
  tcp: 'TCP (Telnet or raw text)',
  udp: 'UDP',
  http: 'HTTP or REST',
  websocket: 'WebSocket',
  snmp: 'SNMP',
  ssh: 'SSH',
  serial: 'Serial (RS-232 or RS-485)',
};

export const DRIVER_REQUEST_NEEDS = ['monitor', 'control'] as const;
export const DRIVER_REQUEST_STATUSES = ['open', 'in_progress', 'built', 'declined'] as const;
export type DriverRequestStatus = (typeof DRIVER_REQUEST_STATUSES)[number];

export const DRIVER_REQUEST_STATUS_LABEL: Record<DriverRequestStatus, string> = {
  open: 'Requested',
  in_progress: 'In progress',
  built: 'Built',
  declined: 'Declined',
};

export const DriverRequestInput = z.object({
  make: z.string().trim().min(1).max(60),
  model: z.string().trim().min(1).max(60),
  category: AssetCategory,
  need: z.enum(DRIVER_REQUEST_NEEDS).default('monitor'),
  protocol: z.enum(DRIVER_REQUEST_PROTOCOLS).default('unknown'),
  /** A link to the manufacturer's control protocol or API documentation. */
  docsUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || /^https?:\/\//i.test(v), 'Use a link that starts with http:// or https://')
    .optional(),
  notes: z.string().trim().max(2000).default(''),
  /** The device it was raised from. */
  deviceId: z.string().uuid().optional(),
});
export type DriverRequestInput = z.infer<typeof DriverRequestInput>;
