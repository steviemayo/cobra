import { cn } from '@/lib/utils';

export type HealthLevel = 'healthy' | 'degraded' | 'down' | 'unknown';

const TONE: Record<HealthLevel, string> = {
  healthy: 'bg-success',
  degraded: 'bg-warning',
  down: 'bg-destructive',
  unknown: 'bg-muted-foreground/35',
};
const LABEL: Record<HealthLevel, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'Unknown',
};

export const HEALTH_ORDER: Record<HealthLevel, number> = {
  down: 0,
  degraded: 1,
  unknown: 2,
  healthy: 3,
};

export function HealthDot({ level, className }: { level: HealthLevel; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2 shrink-0 rounded-full', TONE[level], className)}
    />
  );
}

export function HealthPill({
  level,
  reasons,
  className,
}: {
  level: HealthLevel;
  reasons?: string[];
  className?: string;
}) {
  return (
    <span
      className={cn('inline-flex items-center gap-2 text-sm', className)}
      title={reasons?.length ? reasons.join('. ') : undefined}
    >
      <HealthDot level={level} />
      <span className={cn(level === 'unknown' && 'text-muted-foreground')}>{LABEL[level]}</span>
    </span>
  );
}

const SEVERITY_TONE: Record<string, string> = {
  critical: 'bg-destructive',
  warning: 'bg-warning',
  info: 'bg-muted-foreground/50',
};
export const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

export function SeverityPill({ severity }: { severity: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span
        aria-hidden
        className={cn(
          'size-2 shrink-0 rounded-full',
          SEVERITY_TONE[severity] ?? 'bg-muted-foreground/50',
        )}
      />
      {SEVERITY_LABEL[severity] ?? severity}
    </span>
  );
}

export function OnlineDot({ online, className }: { online: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        online ? 'bg-success' : 'bg-destructive',
        className,
      )}
    />
  );
}

export const dateTime = (d: Date | string) =>
  new Date(d).toLocaleString('en-AU', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

export const INCIDENT_KIND_LABEL: Record<string, string> = {
  device_offline: 'Device offline',
  gateway_offline: 'Gateway offline',
  room_fault: 'Room fault',
  deploy_failed: 'Release refused',
  point_alert: 'Watched value out of bounds',
  config_drift: 'Setting changed',
  config_enforce_failed: 'Setting could not be put back',
  pm_overdue: 'Maintenance overdue',
  latency_high: 'Slow responses',
  network_degraded: 'Network slow',
};
