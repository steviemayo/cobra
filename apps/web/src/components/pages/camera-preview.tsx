'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CameraIcon } from 'lucide-react';
import { BUILT_IN_DRIVERS, DeviceControl } from '@kestrel/model';
import { Section } from '@/components/common/section';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Device = RouterOutputs['device']['get'];

/** How often to ask whether the gateway has answered, and how long to wait. A gateway reports within one heartbeat. */
const POLL_MS = 2500;
const GIVE_UP_MS = 75_000;

/** Whether this device's driver can give a picture. */
function canPreview(control: unknown): boolean {
  const c = DeviceControl.safeParse(control);
  return (
    c.success &&
    c.data.kind === 'driver' &&
    (BUILT_IN_DRIVERS[c.data.driverId]?.features ?? []).includes('snapshot')
  );
}

type Shot = { data: string; takenAt: Date };

/**
 * One picture from a monitored camera, on request. The picture comes through the camera's gateway,
 * is shown once, and lives only in this page's memory: it is not saved anywhere, and leaving the page
 * or pressing Hide forgets it.
 */
export function CameraPreview({ device }: { device: Device }) {
  const trpc = useTRPC();
  const { orgId, canSupport } = useOrg();
  const eligible = device.kind === 'active' && canSupport && canPreview(device.control);
  const enabled = useQuery({
    ...trpc.device.previewEnabled.queryOptions({ orgId }),
    enabled: eligible,
  });

  const [commandId, setCommandId] = useState<string | null>(null);
  const [shot, setShot] = useState<Shot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef(0);

  const ask = useMutation(
    trpc.device.snapshotRequest.mutationOptions({
      onSuccess: (res) => {
        startedAt.current = Date.now();
        setCommandId(res.commandId);
      },
      onError: (e) => setError(e.message),
    }),
  );
  const fetchShot = useMutation(trpc.device.snapshotResult.mutationOptions());
  // The loop below must not restart whenever the mutation object changes identity.
  const fetchRef = useRef(fetchShot.mutateAsync);
  fetchRef.current = fetchShot.mutateAsync;

  // While a picture is awaited, ask now and then. Each answer is final: the picture is handed over once.
  useEffect(() => {
    if (!commandId) return;
    let cancelled = false;
    let busy = false;
    const tick = async () => {
      if (busy || cancelled) return;
      if (Date.now() - startedAt.current > GIVE_UP_MS) {
        setCommandId(null);
        setError('The gateway did not answer in time. Check that it is online and try again.');
        return;
      }
      busy = true;
      try {
        const res = await fetchRef.current({ orgId, commandId });
        if (cancelled) return;
        if (res.status === 'ready') {
          setShot({ data: res.data, takenAt: new Date(res.takenAt) });
          setCommandId(null);
        } else if (res.status === 'failed') {
          setError(res.error);
          setCommandId(null);
        } else if (res.status === 'gone') {
          setError('That picture is no longer available. Take another.');
          setCommandId(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not get the picture');
          setCommandId(null);
        }
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [commandId, orgId]);

  if (!eligible || enabled.isPending) return null;

  const waiting = ask.isPending || commandId !== null;
  return (
    <Section title="Live preview">
      <div className="space-y-3 p-4">
        {!enabled.data?.enabled ? (
          <p className="text-sm text-muted-foreground">
            Camera previews are off for this organisation.{' '}
            <Link className="underline" href={orgPath(orgId, '/settings')}>
              An owner can turn them on in Settings.
            </Link>
          </p>
        ) : (
          <>
            {shot && (
              <div className="space-y-2">
                <img
                  src={`data:image/jpeg;base64,${shot.data}`}
                  alt={`Snapshot from ${device.name}`}
                  className="max-h-[28rem] w-auto max-w-full rounded-md border"
                />
                <p className="text-xs text-muted-foreground">
                  Taken at {shot.takenAt.toLocaleTimeString()}. Shown once and not saved.
                </p>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={waiting}
                onClick={() => {
                  setError(null);
                  setShot(null);
                  ask.mutate({ orgId, deviceId: device.id });
                }}
              >
                {waiting ? <Spinner /> : <CameraIcon data-icon="inline-start" />}
                {shot ? 'Take another' : 'Take a picture'}
              </Button>
              {shot && (
                <Button size="sm" variant="ghost" onClick={() => setShot(null)}>
                  Hide
                </Button>
              )}
              {waiting && (
                <span className="text-xs text-muted-foreground">
                  Asking the gateway. This can take up to half a minute.
                </span>
              )}
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {!shot && !waiting && !error && (
              <p className="text-xs text-muted-foreground">
                One picture, on request. It is shown once and not saved, and the request is
                recorded in the audit trail.
              </p>
            )}
          </>
        )}
      </div>
    </Section>
  );
}
