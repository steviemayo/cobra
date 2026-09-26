import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@kestrel/db';
import { signManifest } from '@kestrel/crypto';
import { validateRoomModel } from '@kestrel/engine';
import {
  RoomModel,
  applyBindings,
  type DeviceValues,
  type PanelBranding,
  type PinnedDriver,
} from '@kestrel/model';
import { absorbInline, resolveBindings, sharedRefs, type BindingsDb } from './bindings';
import { pinDrivers, type DriverDb } from './custom-drivers';
import { effectivePanel, readPanel } from './panel-settings';
import type { SigningKey } from './signing';

// Turning a room's draft into a signed, immutable release. Shared by publishing one room and by
// deploying a whole room group. These functions take the database as a parameter so they can be
// tested without one.
export type ReleaseDb = Pick<PrismaClient, 'release' | 'roomDraft' | 'room' | 'gateway'> & DriverDb & BindingsDb;

export interface PublishableRoom {
  id: string;
  name: string;
  panel: unknown;
}

export type Publishable =
  | {
      ok: true;
      draft: { revision: number };
      /** The design: what the room is, without addresses or logins. */
      model: RoomModel;
      drivers: Record<string, PinnedDriver>;
      /** The room's addresses and logins, credential sets resolved. */
      bindings: DeviceValues;
      /** True when the room's gateway can fetch bindings itself, so the release carries none. */
      bindingsExternal: boolean;
    }
  | { ok: false; code: 'BAD_REQUEST'; message: string };

/** Whether the room's draft can be published, and what a release of it would contain. */
export async function checkPublishable(
  db: ReleaseDb,
  orgId: string,
  room: { id: string },
): Promise<Publishable> {
  const draft = await db.roomDraft.findFirst({ where: { roomId: room.id, orgId } });
  if (!draft)
    return { ok: false, code: 'BAD_REQUEST', message: 'Design the room before publishing' };
  const model = RoomModel.parse(draft.model);
  const errors = validateRoomModel(model).issues.filter((i) => i.severity === 'error');
  if (errors.length)
    return {
      ok: false,
      code: 'BAD_REQUEST',
      message: `Fix ${errors.length} design problem${errors.length === 1 ? '' : 's'} first: ${errors[0]!.message}`,
    };
  const pinned = await pinDrivers(db, orgId, model);
  if (!pinned.ok) return { ok: false, code: 'BAD_REQUEST', message: pinned.problems[0]! };
  // A room designed before bindings existed has its addresses inline: move them across first.
  const { model: design } = await absorbInline(db, {
    orgId,
    roomId: room.id,
    model,
    custom: pinned.drivers,
    userId: null,
  });
  const bindings = (await resolveBindings(db, orgId, room.id, undefined, design))?.devices ?? {};
  return {
    ok: true,
    draft: { revision: draft.revision },
    model: design,
    drivers: pinned.drivers,
    bindings,
    bindingsExternal: await gatewayFetchesBindings(db, orgId, room.id),
  };
}

/** Whether the gateway this room is assigned to says it can fetch bindings. No gateway yet: no. */
async function gatewayFetchesBindings(db: ReleaseDb, orgId: string, roomId: string): Promise<boolean> {
  const room = await db.room.findFirst({ where: { id: roomId, orgId } });
  if (!room?.gatewayId) return false;
  const gateway = await db.gateway.findFirst({ where: { id: room.gatewayId, orgId } });
  return !!gateway?.features?.includes('bindings');
}

/** Sign and store the next release of a room. Two people publishing at once: the loser retries. */
export async function createRelease(
  db: ReleaseDb,
  input: {
    orgId: string;
    room: PublishableRoom;
    checked: Extract<Publishable, { ok: true }>;
    key: SigningKey;
    orgBranding: PanelBranding;
    userId: string | null;
  },
) {
  const { orgId, room, checked, key, orgBranding, userId } = input;
  const create = async () => {
    const last = await db.release.aggregate({ where: { roomId: room.id }, _max: { number: true } });
    const number = (last._max.number ?? 0) + 1;
    const id = randomUUID();
    const signed = signManifest(
      {
        manifestVersion: 1,
        orgId,
        roomId: room.id,
        roomName: room.name,
        releaseId: id,
        releaseNumber: number,
        createdAt: new Date().toISOString(),
        // A gateway that fetches bindings gets the design here and the addresses separately. Any
        // other gateway gets everything in the release, as it always did.
        ...(checked.bindingsExternal ? { bindingsExternal: true } : {}),
        model: checked.bindingsExternal ? checked.model : applyBindings(checked.model, checked.bindings),
        drivers: checked.drivers,
        panel: effectivePanel(readPanel(room.panel), orgBranding),
      },
      key,
    );
    return db.release.create({
      data: {
        id,
        orgId,
        roomId: room.id,
        number,
        manifest: signed as unknown as Prisma.InputJsonValue,
        hash: signed.hash,
        draftRevision: checked.draft.revision,
        siteDeviceIds: [...new Set(sharedRefs(checked.model).map((r) => r.siteDeviceId))],
        createdBy: userId,
      },
    });
  };
  try {
    return await create();
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return create();
    throw e;
  }
}
