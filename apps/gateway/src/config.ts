import { z } from 'zod';

export const GATEWAY_VERSION = '0.2.4';

const Env = z.object({
  /** Base URL of the Kestrel cloud, e.g. https://app.kestrel.example */
  KESTREL_CLOUD_URL: z.string().url(),
  /** One-time enrolment token from the portal. Only needed until the gateway has enrolled. */
  KESTREL_ENROLL_TOKEN: z.string().optional(),
  /** Where the credential, cached manifests and telemetry buffer live. Mount a volume here. */
  KESTREL_DATA_DIR: z.string().default('./data'),
  KESTREL_PANEL_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  KESTREL_PANEL_HOST: z.string().default('0.0.0.0'),
  /** Built panel web app served to touch panels. */
  KESTREL_PANEL_DIR: z.string().default('../panel/dist'),
  /**
   * off: real devices only. all: every device simulated (demo, no hardware).
   * missing: real drivers where configured, simulated for the rest.
   */
  KESTREL_SIMULATE: z.enum(['off', 'all', 'missing']).default('off'),
  /** Optional pinned public key (PEM), trusted in addition to keys the cloud hands out. */
  KESTREL_PUBLIC_KEY: z.string().optional(),
  /** How long a new release gets to reach its devices before it is refused and the old one kept. */
  KESTREL_HEALTH_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(300).default(15),
  KESTREL_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface GatewayConfig {
  cloudUrl: string;
  enrollToken?: string;
  dataDir: string;
  panelPort: number;
  panelHost: string;
  panelDir: string;
  simulate: 'off' | 'all' | 'missing';
  pinnedPublicKey?: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  version: string;
  healthTimeoutMs?: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): GatewayConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid gateway configuration: ${problems}`);
  }
  const e = parsed.data;
  return {
    cloudUrl: e.KESTREL_CLOUD_URL.replace(/\/+$/, ''),
    enrollToken: e.KESTREL_ENROLL_TOKEN,
    dataDir: e.KESTREL_DATA_DIR,
    panelPort: e.KESTREL_PANEL_PORT,
    panelHost: e.KESTREL_PANEL_HOST,
    panelDir: e.KESTREL_PANEL_DIR,
    simulate: e.KESTREL_SIMULATE,
    pinnedPublicKey: e.KESTREL_PUBLIC_KEY,
    logLevel: e.KESTREL_LOG_LEVEL,
    version: GATEWAY_VERSION,
    healthTimeoutMs: e.KESTREL_HEALTH_TIMEOUT_SECONDS * 1000,
  };
}
