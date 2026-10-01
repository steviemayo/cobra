import { z } from 'zod';
import type { PublicKey } from '@kestrel/model';
import { BUILT_IN_MANIFEST_KEYS } from './trusted-keys';

export const GATEWAY_VERSION = '0.4.3';

const Env = z.object({
  /** Base URL of the Kestrel cloud, e.g. https://app.kestrel.example */
  KESTREL_CLOUD_URL: z.string().url(),
  /** One-time enrolment token from the portal. Only needed until the gateway has enrolled. */
  KESTREL_ENROLL_TOKEN: z.string().optional(),
  /** Where the credential, the saved device list and the telemetry buffer live. Mount a volume here. */
  KESTREL_DATA_DIR: z.string().default('./data'),
  /** The local status and admin page. (Named for the panel it once served; the name is kept so installs keep working.) */
  KESTREL_PANEL_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  KESTREL_PANEL_HOST: z.string().default('0.0.0.0'),
  /** Optional pinned public key (PEM), trusted in addition to keys the cloud hands out. */
  KESTREL_PUBLIC_KEY: z.string().optional(),
  /**
   * Container installs only: where the updater (Watchtower's HTTP API) can be asked to update this
   * gateway, and the token it expects. Without them a container cannot update itself.
   */
  KESTREL_UPDATE_URL: z.string().url().optional(),
  KESTREL_UPDATE_TOKEN: z.string().optional(),
  /**
   * Names this gateway may be reached by, besides IP addresses, `localhost`, its own machine name,
   * bare names and `.local`/`.lan` names. Comma separated; `*.example.com` allows a domain and `*`
   * allows anything (which turns off the protection against DNS rebinding).
   */
  KESTREL_ALLOWED_HOSTS: z.string().optional(),
  /**
   * Trust the signing keys the cloud sends, in addition to the ones built into this gateway. Only
   * for a gateway that talks to a Kestrel other than the one it was built for (a self-hosted
   * cloud with its own signing key); it removes the protection against a hijacked cloud.
   */
  KESTREL_TRUST_CLOUD_KEYS: z.enum(['true', 'false']).default('false'),
  KESTREL_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface GatewayConfig {
  cloudUrl: string;
  enrollToken?: string;
  dataDir: string;
  panelPort: number;
  panelHost: string;
  pinnedPublicKey?: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  version: string;
  updateUrl?: string;
  updateToken?: string;
  allowedHosts?: string[];
  /** Signing keys this gateway trusts for device lists and update bundles. Empty or absent: trust what the cloud sends (tests, demos). */
  trustedKeys?: PublicKey[];
  /** Also trust keys the cloud sends, on top of `trustedKeys`. */
  trustCloudKeys?: boolean;
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
    pinnedPublicKey: e.KESTREL_PUBLIC_KEY,
    logLevel: e.KESTREL_LOG_LEVEL,
    version: GATEWAY_VERSION,
    updateUrl: e.KESTREL_UPDATE_URL,
    updateToken: e.KESTREL_UPDATE_TOKEN,
    allowedHosts: (e.KESTREL_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    trustedKeys: BUILT_IN_MANIFEST_KEYS,
    trustCloudKeys: e.KESTREL_TRUST_CLOUD_KEYS === 'true',
  };
}
