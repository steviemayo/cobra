import type { DeviceBus } from '@kestrel/model';
import type { Plan } from './plan';

export interface StepResult {
  stepId: string;
  status: 'done' | 'failed' | 'skipped';
  error?: string;
}

export interface ExecuteHooks {
  onStepStart?: (stepId: string) => void;
  onStepEnd?: (result: StepResult) => void;
  signal?: AbortSignal;
  /** Per-step limit. Default 30s. */
  timeoutMs?: number;
}

export interface ExecuteResult {
  ok: boolean;
  results: StepResult[];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Runs a plan with as much parallelism as its dependencies allow. Each step proceeds the moment
 * everything it depends on reports ready: no fixed waits. A failed step skips only its dependents.
 */
export async function executePlan(
  plan: Plan,
  bus: DeviceBus,
  hooks: ExecuteHooks = {},
): Promise<ExecuteResult> {
  const timeoutMs = hooks.timeoutMs ?? 30_000;
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const started = new Map<string, Promise<StepResult>>();
  const results: StepResult[] = [];

  const run = (id: string): Promise<StepResult> => {
    const existing = started.get(id);
    if (existing) return existing;
    const step = byId.get(id)!;
    const p = (async (): Promise<StepResult> => {
      const deps = await Promise.all(step.dependsOn.filter((d) => byId.has(d)).map(run));
      let result: StepResult;
      if (deps.some((d) => d.status !== 'done') || hooks.signal?.aborted) {
        result = { stepId: id, status: 'skipped' };
      } else {
        hooks.onStepStart?.(id);
        try {
          await withTimeout(bus.send(step.deviceId, step.command), timeoutMs);
          result = { stepId: id, status: 'done' };
        } catch (e) {
          result = {
            stepId: id,
            status: 'failed',
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }
      results.push(result);
      hooks.onStepEnd?.(result);
      return result;
    })();
    started.set(id, p);
    return p;
  };

  await Promise.all(plan.steps.map((s) => run(s.id)));
  return { ok: results.every((r) => r.status === 'done'), results };
}
