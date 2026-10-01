import type { PrismaClient } from '@kestrel/db';
import {
  COMMAND_INFO,
  CommandType,
  PointAddress,
  PointType,
  type CommandResult,
  type GatewayCommand,
} from '@kestrel/model';
import { writeAudit } from './audit';

// Remote commands. Support asks in the portal; the gateway collects the request in its next
// heartbeat response (it never accepts inbound connections), runs it if it is on the allowlist,
// and reports the outcome in a later heartbeat.
export type CommandDb = Pick<PrismaClient, 'remoteCommand' | 'room' | 'deviceStatus' | 'auditLog' | 'gateway'>;

export const MAX_COMMANDS_PER_ROOM_MINUTE = 6;
const MAX_PER_HEARTBEAT = 10;

export type RequestResult = { ok: true; id: string } | { ok: false; error: string };

export async function requestCommand(
  db: CommandDb,
  input: {
    orgId: string;
    roomId: string;
    type: string;
    args?: Record<string, string>;
    requestedBy: string | null;
  },
  now = new Date(),
): Promise<RequestResult> {
  const type = CommandType.safeParse(input.type);
  if (!type.success) return { ok: false, error: 'That command is not allowed' };
  const room = await db.room.findFirst({ where: { id: input.roomId, orgId: input.orgId } });
  if (!room) return { ok: false, error: 'Room not found' };
  if (!room.gatewayId)
    return { ok: false, error: 'This room has no gateway to run the command on' };

  // A gateway that does not know a command would fail to read the whole reply that carries it, so it
  // is only sent to one that says it can run it.
  if (type.data === 'discover_devices') {
    const gateway = await db.gateway.findFirst({ where: { id: room.gatewayId, orgId: input.orgId } });
    if (!gateway?.features?.includes('discovery'))
      return { ok: false, error: 'This gateway needs updating before it can look for devices.' };
  }

  const args: Record<string, string> = {};
  if (COMMAND_INFO[type.data].needsDevice) {
    const deviceId = input.args?.deviceId;
    const device = deviceId
      ? await db.deviceStatus.findFirst({ where: { roomId: room.id, deviceId } })
      : null;
    if (!device) return { ok: false, error: 'Choose one of this room’s devices' };
    args.deviceId = device.deviceId;
  }
  if (type.data === 'verify_point') {
    // The point to read travels with the command, so it can be checked before it is published.
    const kind = PointType.safeParse(input.args?.type);
    const parse = (): ReturnType<typeof PointAddress.safeParse> | null => {
      try {
        return PointAddress.safeParse(JSON.parse(input.args?.address ?? ''));
      } catch {
        return null;
      }
    };
    const address = parse();
    if (!kind.success || !address?.success) return { ok: false, error: 'That control point is not valid' };
    const text = JSON.stringify(address.data);
    if (text.length > 200) return { ok: false, error: 'That control point address is too long' };
    args.type = kind.data;
    args.address = text;
  }

  if (type.data === 'discover_controls') {
    const component = (input.args?.component ?? '').trim();
    if (!component || component.length > 100) return { ok: false, error: 'That component name is not valid' };
    args.component = component;
  }

  if (type.data === 'discover_devices' && input.args?.subnet) {
    // One /24 the gateway is on, like 192.168.1. The gateway checks it is one of its own as well.
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(input.args.subnet))
      return { ok: false, error: 'That is not a network address' };
    args.subnet = input.args.subnet;
  }

  const recent = await db.remoteCommand.count({
    where: { roomId: room.id, createdAt: { gte: new Date(now.getTime() - 60_000) } },
  });
  if (recent >= MAX_COMMANDS_PER_ROOM_MINUTE)
    return { ok: false, error: 'Too many commands for this room. Try again in a minute' };

  const created = await db.remoteCommand.create({
    data: {
      orgId: input.orgId,
      gatewayId: room.gatewayId,
      roomId: room.id,
      type: type.data,
      args,
      status: 'pending',
      requestedBy: input.requestedBy,
      createdAt: now,
    },
  });
  await writeAudit(
    {
      orgId: input.orgId,
      actorId: input.requestedBy,
      action: 'command.request',
      target: room.id,
      meta: { commandId: created.id, type: type.data, room: room.name, ...args },
    },
    db,
  );
  return { ok: true, id: created.id };
}

/** Hands a gateway the commands waiting for it, marking them sent so each is delivered once. */
export async function takePendingCommands(
  db: CommandDb,
  gatewayId: string,
  now = new Date(),
): Promise<GatewayCommand[]> {
  const pending = await db.remoteCommand.findMany({
    where: { gatewayId, status: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: MAX_PER_HEARTBEAT,
  });
  const out: GatewayCommand[] = [];
  for (const c of pending) {
    // Claim it first: a second heartbeat racing this one must not get the same command.
    const { count } = await db.remoteCommand.updateMany({
      where: { id: c.id, status: 'pending' },
      data: { status: 'sent', sentAt: now },
    });
    if (count === 0) continue;
    out.push({
      id: c.id,
      type: c.type as GatewayCommand['type'],
      roomId: c.roomId,
      args: (c.args ?? {}) as Record<string, string>,
    });
  }
  return out;
}

/** Records what a gateway says happened. A gateway can only answer commands sent to it. */
export async function applyCommandResults(
  db: CommandDb,
  gatewayId: string,
  results: CommandResult[],
  now = new Date(),
): Promise<void> {
  for (const r of results) {
    const cmd = await db.remoteCommand.findFirst({
      where: { id: r.id, gatewayId, status: 'sent' },
    });
    if (!cmd) continue;
    await db.remoteCommand.update({
      where: { id: cmd.id },
      data: {
        status: r.ok ? 'succeeded' : 'failed',
        output: r.output as object,
        error: r.error ?? null,
        finishedAt: now,
      },
    });
    await writeAudit(
      {
        orgId: cmd.orgId,
        actorId: null,
        action: 'command.result',
        target: cmd.roomId,
        meta: { commandId: cmd.id, type: cmd.type, ok: r.ok },
      },
      db,
    );
  }
}
