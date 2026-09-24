import type { z } from 'zod';
import {
  ConfigResponse,
  EnrollResponse,
  HeartbeatResponse,
  PROTOCOL_VERSION,
  type EnrollRequest,
  type HeartbeatRequest,
  type TelemetryBatch,
} from '@kestrel/model';

export class CloudError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the cloud could not be reached at all. */
    readonly status: number,
  ) {
    super(message);
  }
  get unreachable() {
    return this.status === 0;
  }
  get unauthorised() {
    return this.status === 401 || this.status === 403;
  }
}

const TIMEOUT_MS = 15_000;

/** The gateway's outbound-only HTTPS client. Every request is initiated from the gateway. */
export class CloudClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: z.ZodType<T> | null,
    opts: { body?: unknown; credential?: string } = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/gateway/v1${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-kestrel-protocol': String(PROTOCOL_VERSION),
          ...(opts.credential ? { authorization: `Bearer ${opts.credential}` } : {}),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new CloudError(`Could not reach the cloud: ${e instanceof Error ? e.message : String(e)}`, 0);
    }
    if (!res.ok) {
      let detail = '';
      try {
        detail = ((await res.json()) as { error?: string }).error ?? '';
      } catch {
        // not JSON; the status is enough
      }
      throw new CloudError(detail || `Cloud responded ${res.status}`, res.status);
    }
    const json: unknown = await res.json();
    if (!schema) return json as T;
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new CloudError(`Unexpected response from the cloud on ${path}`, 502);
    return parsed.data;
  }

  enroll(body: EnrollRequest) {
    return this.request('POST', '/enroll', EnrollResponse, { body });
  }

  heartbeat(credential: string, body: HeartbeatRequest) {
    return this.request('POST', '/heartbeat', HeartbeatResponse, { body, credential });
  }

  config(credential: string) {
    return this.request('GET', '/config', ConfigResponse, { credential });
  }

  /** The manifest is returned raw: it must be verified against its hash and signature before parsing. */
  manifest(credential: string, roomId: string, releaseId: string): Promise<unknown> {
    return this.request('GET', `/rooms/${roomId}/manifest?release=${releaseId}`, null, { credential });
  }

  async telemetry(credential: string, body: TelemetryBatch): Promise<void> {
    await this.request('POST', '/telemetry', null, { body, credential });
  }
}
