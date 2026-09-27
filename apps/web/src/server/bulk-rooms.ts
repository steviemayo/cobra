import type { Prisma, PrismaClient } from '@kestrel/db';
import {
  RoomModel,
  bulkColumns,
  cellValue,
  checkGrid,
  scopeOfSetting,
  type BulkIssue,
  type BulkRow,
  type CustomDrivers,
  type DeviceValues,
} from '@kestrel/model';
import { bindingChanges, readPlainBindings, setRoomBindings, type BindingsDb } from './bindings';
import { billedRooms } from './room-kinds';

// Creating many rooms from one template at once (docs/driver-classes.md, "Bulk creation"). Each
// row is a room: a new room gets the template's design and its addresses; a room that already has
// that name at the site has its addresses updated instead. These functions take the database as a
// parameter so they can be tested without one, and run inside one transaction in production.
export type BulkDb = Pick<PrismaClient, 'room' | 'roomDraft' | 'gateway'> & BindingsDb;

export interface BulkInput {
  orgId: string;
  siteId: string;
  /** Run the new rooms on this gateway. Existing rooms keep theirs. */
  gatewayId: string | null;
  /** The template's design, already stripped of addresses. */
  model: RoomModel;
  custom: CustomDrivers;
  rows: BulkRow[];
  /** Shared login by device id. */
  credentialSets: Record<string, string>;
  /** The plan's room limit, or null for none. */
  maxRooms: number | null;
  userId: string | null;
}

export type BulkAction = 'create' | 'update' | 'unchanged' | 'error';

export interface BulkRowPlan {
  index: number;
  name: string;
  action: BulkAction;
  roomId?: string;
  issues: BulkIssue[];
}

export interface BulkPlan {
  rows: BulkRowPlan[];
  creates: number;
  updates: number;
  /** Problems that are not about one row: the room limit, the gateway, a shared login. */
  problems: string[];
  /** Nothing to fix: the plan can be applied. */
  ok: boolean;
}

const toJson = (m: RoomModel) => m as unknown as Prisma.InputJsonValue;

/** What each row would do, and what is wrong, without changing anything. */
export async function planBulk(db: BulkDb, input: BulkInput): Promise<BulkPlan> {
  const { columns, logins } = bulkColumns(input.model, input.custom);
  const issues = checkGrid(input.rows, columns);
  const problems: string[] = [];

  // Shared logins: only for devices that need one, and only the organisation's own.
  const loginDevices = new Set(logins.map((l) => l.deviceId));
  for (const [deviceId, setId] of Object.entries(input.credentialSets)) {
    if (!loginDevices.has(deviceId)) problems.push('A shared login was chosen for a device that does not use one');
    else if (!(await db.credentialSet.findFirst({ where: { id: setId, orgId: input.orgId } })))
      problems.push('One of the shared logins chosen does not exist');
  }
  if (input.gatewayId) {
    const gw = await db.gateway.findFirst({ where: { id: input.gatewayId, orgId: input.orgId } });
    if (!gw) problems.push('That gateway does not exist');
    else if (gw.siteId !== input.siteId) problems.push('A room can only use a gateway at its own site');
  }

  const existing = (await db.room.findMany({ where: { orgId: input.orgId, siteId: input.siteId } })).filter(
    (r) => r.kind !== 'combined',
  );
  const byName = new Map<string, typeof existing>();
  for (const r of existing) byName.set(r.name.trim().toLowerCase(), [...(byName.get(r.name.trim().toLowerCase()) ?? []), r]);

  const rows: BulkRowPlan[] = [];
  for (const [index, row] of input.rows.entries()) {
    const own = issues.filter((i) => i.row === index);
    const name = row.name.trim();
    const matches = byName.get(name.toLowerCase()) ?? [];
    const plan: BulkRowPlan = { index, name, action: 'create', issues: own };
    if (own.some((i) => i.level === 'error') || !name) plan.action = 'error';
    else if (matches.length > 1) {
      plan.action = 'error';
      own.push({ row: index, level: 'error', message: 'More than one room at this site has this name' });
    } else if (matches.length === 1) {
      const room = matches[0]!;
      plan.roomId = room.id;
      const draft = await db.roomDraft.findFirst({ where: { roomId: room.id, orgId: input.orgId } });
      const design = draft ? RoomModel.safeParse(draft.model) : null;
      if (!design?.success) {
        plan.action = 'error';
        own.push({ row: index, level: 'error', message: 'This room already exists and has no design to update' });
      } else {
        const values = cellValues(columns, row);
        const missing = Object.keys(values).filter((id) => !design.data.devices.some((d) => d.id === id));
        const wrongScope = Object.entries(values).flatMap(([id, f]) => {
          const device = design.data.devices.find((d) => d.id === id);
          return device ? Object.keys(f).filter((k) => scopeOfSetting(device, k, input.custom) === 'design') : [];
        });
        if (missing.length || wrongScope.length) {
          plan.action = 'error';
          own.push({
            row: index,
            level: 'error',
            message: 'This room already exists with a different design, so its addresses cannot be updated from this template',
          });
        } else {
          const current = await readPlainBindings(db, room.id);
          const change = bindingChanges(current, { values, credentialSets: input.credentialSets });
          plan.action =
            Object.keys(change.values).length || Object.keys(change.credentialSets).length ? 'update' : 'unchanged';
        }
      }
    }
    rows.push(plan);
  }

  const creates = rows.filter((r) => r.action === 'create').length;
  const updates = rows.filter((r) => r.action === 'update').length;
  if (input.maxRooms !== null && creates > 0) {
    const total = await db.room.count({ where: { orgId: input.orgId, ...billedRooms } });
    if (total + creates > input.maxRooms)
      problems.push(
        `Your plan includes ${input.maxRooms} rooms and this organisation has ${total}. Creating ${creates} more would go over. Subscribe to add more`,
      );
  }
  const ok = problems.length === 0 && rows.length > 0 && !rows.some((r) => r.action === 'error');
  return { rows, creates, updates, problems, ok };
}

function cellValues(columns: ReturnType<typeof bulkColumns>['columns'], row: BulkRow): DeviceValues {
  const values: DeviceValues = {};
  for (const c of columns) {
    const text = row.values[c.id];
    if (text !== undefined && text.trim() !== '') (values[c.deviceId] ??= {})[c.key] = cellValue(c.key, text);
  }
  return values;
}

export type BulkResult =
  | { ok: true; plan: BulkPlan; created: { id: string; name: string }[]; updated: { id: string; name: string }[] }
  | { ok: false; plan: BulkPlan };

/** Checks everything first, then creates and updates. Nothing is written when anything is wrong. */
export async function applyBulk(db: BulkDb, input: BulkInput): Promise<BulkResult> {
  const plan = await planBulk(db, input);
  if (!plan.ok) return { ok: false, plan };
  const { columns } = bulkColumns(input.model, input.custom);
  const created: { id: string; name: string }[] = [];
  const updated: { id: string; name: string }[] = [];

  for (const [index, row] of input.rows.entries()) {
    const step = plan.rows[index]!;
    const values = cellValues(columns, row);
    if (step.action === 'create') {
      const room = await db.room.create({
        data: {
          orgId: input.orgId,
          siteId: input.siteId,
          name: step.name,
          type: input.model.roomType,
          ...(input.gatewayId ? { gatewayId: input.gatewayId } : {}),
        },
      });
      await db.roomDraft.create({
        data: { orgId: input.orgId, roomId: room.id, model: toJson(input.model), updatedBy: input.userId },
      });
      await setRoomBindings(db, {
        orgId: input.orgId,
        roomId: room.id,
        userId: input.userId,
        values,
        credentialSets: input.credentialSets,
      });
      created.push({ id: room.id, name: step.name });
    } else if (step.action === 'update' && step.roomId) {
      await setRoomBindings(db, {
        orgId: input.orgId,
        roomId: step.roomId,
        userId: input.userId,
        values,
        credentialSets: input.credentialSets,
      });
      updated.push({ id: step.roomId, name: step.name });
    }
  }
  return { ok: true, plan, created, updated };
}
