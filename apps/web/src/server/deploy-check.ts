import type { PrismaClient } from '@kestrel/db';
import { gatewayNeeds, missingBindings, type CustomDrivers, type DeviceValues, type RoomModel } from '@kestrel/model';
import { resolveBindings, type BindingsDb } from './bindings';

// Whether a release can go to a room's gateway right now: the gateway must be able to run it, and
// every address and login the room needs must be filled in. These functions take the database as a
// parameter so they can be tested without one.
export type DeployCheckDb = Pick<PrismaClient, 'release' | 'gateway'> & BindingsDb;

export type DeployCheck = { ok: true } | { ok: false; message: string };

/** A plain sentence naming what a room still needs, or null when it is ready. */
export function setupProblem(
  model: RoomModel,
  bindings: DeviceValues,
  custom: CustomDrivers = {},
): string | null {
  const missing = missingBindings(model, bindings, custom);
  if (missing.length === 0) return null;
  const first = missing[0]!;
  const more = missing.length > 1 ? ` (and ${missing.length - 1} more)` : '';
  return `Needs setup: ${first.deviceName} needs its ${first.label.toLowerCase()}${more}. Fill it in under the room’s devices.`;
}

/** A sentence when this room's design needs something its gateway has not said it can do, else null. */
export async function gatewayTooOld(
  db: Pick<PrismaClient, 'gateway'>,
  orgId: string,
  gatewayId: string,
  model: RoomModel,
): Promise<string | null> {
  const needs = gatewayNeeds(model);
  if (needs.length === 0) return null;
  const gateway = await db.gateway.findFirst({ where: { id: gatewayId, orgId } });
  if (needs.every((n) => gateway?.features?.includes(n))) return null;
  return 'This design uses display keys or apps, which this room’s gateway is too old to run. Update the gateway first.';
}

export async function checkDeployable(
  db: DeployCheckDb,
  input: { orgId: string; roomId: string; gatewayId: string; releaseId: string },
): Promise<DeployCheck> {
  const release = await db.release.findFirst({
    where: { id: input.releaseId, roomId: input.roomId, orgId: input.orgId },
  });
  if (!release) return { ok: false, message: 'That release does not exist' };
  const signed = release.manifest as {
    manifest?: { model?: RoomModel; drivers?: CustomDrivers; bindingsExternal?: boolean };
  } | null;
  const manifest = signed?.manifest;
  if (!manifest?.model) return { ok: false, message: 'That release cannot be read' };

  if (manifest.bindingsExternal) {
    const gateway = await db.gateway.findFirst({ where: { id: input.gatewayId, orgId: input.orgId } });
    if (!gateway?.features?.includes('bindings'))
      return {
        ok: false,
        message:
          'This gateway needs updating before it can run this room, because the room’s addresses are kept separately. Update the gateway, or publish the room again.',
      };
  }

  const tooOld = await gatewayTooOld(db, input.orgId, input.gatewayId, manifest.model);
  if (tooOld) return { ok: false, message: tooOld };

  const resolved = await resolveBindings(db, input.orgId, input.roomId);
  const problem = setupProblem(manifest.model, resolved?.devices ?? {}, manifest.drivers ?? {});
  return problem ? { ok: false, message: problem } : { ok: true };
}
