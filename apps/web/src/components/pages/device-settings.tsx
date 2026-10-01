'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Section } from '@/components/common/section';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useRoomsOverview } from '@/lib/use-estate';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';
import { DRIVER_OPTIONS, controlFor } from './assets';
import { DeviceConnection } from './device-connection';

type Device = RouterOutputs['device']['get'];

const AUTO = '__auto';
const NO_ROOM = '__none';

/** The driver choice (an id in DRIVER_OPTIONS) a device's control stands for. */
function choiceOf(control: unknown): string {
  const c = control as { kind?: string; driverId?: string; protocol?: string } | null;
  return c?.kind === 'driver' ? (c.driverId ?? '') : (c?.protocol ?? '');
}

/** A row of the settings tab: what it is, a note, the control, and its own save button. */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2 border-b px-4 py-3 last:border-b-0 sm:grid-cols-[14rem_minmax(0,1fr)] sm:gap-6">
      <div>
        <Label className="text-sm">{label}</Label>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

/**
 * Everything about how a monitored device is reached, in one place: which gateway polls it, which
 * driver talks to it, its address and logins, which room it is in, and whether it is pinged.
 */
export function DeviceSettings({ device }: { device: Device }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport } = useOrg();
  const gateways = useQuery(trpc.gateway.list.queryOptions({ orgId }));
  const rooms = useRoomsOverview();

  const gatewayNow = device.gatewayOverride ? (device.gatewayId ?? AUTO) : AUTO;
  const driverNow = choiceOf(device.control);
  const roomNow = device.roomId ?? NO_ROOM;
  const settings = (device.settings ?? {}) as Record<string, unknown>;
  const pingNow = settings.probe !== false;

  const [gateway, setGateway] = useState(gatewayNow);
  const [driver, setDriver] = useState(driverNow);
  const [room, setRoom] = useState(roomNow);
  const [confirmDriver, setConfirmDriver] = useState(false);

  const save = useMutation(
    trpc.device.update.mutationOptions({
      onSuccess: async () => {
        toast.success('Saved. The gateway picks the change up within a minute.');
        await Promise.all([
          qc.invalidateQueries({ queryKey: trpc.device.get.queryKey() }),
          qc.invalidateQueries({ queryKey: trpc.device.list.queryKey() }),
          qc.invalidateQueries({ queryKey: trpc.device.events.queryKey() }),
        ]);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const put = (patch: Record<string, unknown>) =>
    save.mutate({ orgId, deviceId: device.id, ...patch } as never);

  const siteGateways = (gateways.data ?? []).filter((g) => g.siteId === device.siteId);
  const siteRooms = (rooms.data ?? []).filter((r) => r.siteId === device.siteId);
  const gatewayOptions = [
    { value: AUTO, label: 'Automatic (the room’s gateway, then the site’s default)' },
    ...siteGateways.map((g) => ({
      value: g.id,
      label: `${g.name}${g.status === 'online' ? '' : ` (${g.status})`}`,
    })),
  ];

  return (
    <div className="space-y-6">
      <Section title="Connection">
        <Row label="Gateway" hint="The gateway at this site that polls the device and pings it.">
          <div className="flex flex-wrap items-center gap-2">
            <SimpleSelect
              className="w-full sm:w-96"
              value={gateway}
              onValueChange={setGateway}
              options={gatewayOptions}
              disabled={!canSupport}
            />
            {canSupport && (
              <Button
                size="sm"
                disabled={save.isPending || gateway === gatewayNow}
                onClick={() => put({ gatewayId: gateway === AUTO ? null : gateway })}
              >
                {save.isPending && <Spinner />}
                Save
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {device.gatewayName
              ? `Polled now by ${device.gatewayName} (${device.gatewayStatus ?? 'unknown'})${device.gatewayOverride ? ', set on this device' : ', chosen automatically'}.`
              : 'No gateway is assigned, so nothing is polling this device.'}
            {gateway !== gatewayNow &&
              ' Its readings and response times will come from the new gateway once it has the device.'}
          </p>
        </Row>

        <Row label="Driver" hint="How Kestrel talks to the device.">
          <div className="flex flex-wrap items-center gap-2">
            <SimpleSelect
              className="w-full sm:w-96"
              value={driver}
              onValueChange={setDriver}
              options={
                DRIVER_OPTIONS.some((o) => o.value === driverNow) || !driverNow
                  ? DRIVER_OPTIONS
                  : [{ value: driverNow, label: driverNow }, ...DRIVER_OPTIONS]
              }
              placeholder="Choose a driver"
              disabled={!canSupport}
            />
            {canSupport && (
              <Button
                size="sm"
                disabled={save.isPending || !driver || driver === driverNow}
                onClick={() => setConfirmDriver(true)}
              >
                Save
              </Button>
            )}
          </div>
        </Row>

        <Row label="Room" hint="Only rooms at this device’s site.">
          <div className="flex flex-wrap items-center gap-2">
            <SimpleSelect
              className="w-full sm:w-96"
              value={room}
              onValueChange={setRoom}
              options={[
                { value: NO_ROOM, label: 'Not in a room' },
                ...siteRooms.map((r) => ({ value: r.id, label: r.name })),
              ]}
              disabled={!canSupport}
            />
            {canSupport && (
              <Button
                size="sm"
                disabled={save.isPending || room === roomNow}
                onClick={() => put({ roomId: room === NO_ROOM ? null : room })}
              >
                Save
              </Button>
            )}
          </div>
        </Row>

        <Row
          label="Response time"
          hint="The gateway pings the device’s address to measure the network. Turn it off for a device that does not answer pings."
        >
          <div className="flex items-center gap-3">
            <Switch
              checked={pingNow}
              disabled={!canSupport || save.isPending}
              onCheckedChange={(on) => {
                const next = { ...settings };
                if (on) delete next.probe;
                else next.probe = false;
                put({ settings: next });
              }}
              aria-label="Measure response time"
            />
            <span className="text-sm text-muted-foreground">
              {pingNow ? 'Pinged' : 'Not pinged'}
            </span>
          </div>
        </Row>
      </Section>

      <DeviceConnection
        key={`${device.id}:${device.version}`}
        deviceId={device.id}
        control={device.control as never}
        values={device.values}
        hasLogin={device.hasLogin}
        credentialSetId={device.credentialSetId}
        canEdit={canSupport}
      />
      {!canSupport && (
        <p className="text-xs text-muted-foreground">You can view but not change this device.</p>
      )}

      <ConfirmDialog
        open={confirmDriver}
        onOpenChange={setConfirmDriver}
        title="Change the driver?"
        description="The gateway will rebuild this device with the new driver. Control points the new driver can’t read are removed, and the address and logins stay as they are."
        confirmLabel="Change driver"
        onConfirm={() => put({ control: controlFor(driver) })}
      />
    </div>
  );
}
