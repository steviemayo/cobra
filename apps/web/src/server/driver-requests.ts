import type { PrismaClient } from '@kestrel/db';
import {
  DRIVER_REQUEST_STATUSES,
  DRIVER_REQUEST_PROTOCOL_LABEL,
  assetCategoryLabel,
  type DriverRequestInput,
  type DriverRequestStatus,
} from '@kestrel/model';
import { saveDriver, type DriverDb } from './custom-drivers';

// Driver requests: a customer says a device has no driver, and Kestrel staff build one. Each request
// raises a support ticket routed to Kestrel, so staff work it from the queue they already use. A built
// driver is saved as a custom driver inside the asking organisation, so it stays private to it until
// Kestrel chooses to promote it.

export type RequestDb = Pick<PrismaClient, 'driverRequest' | 'ticket' | 'ticketComment' | 'device' | 'org'> &
  DriverDb;

export class DriverRequestError extends Error {}

const STATUS_SET = new Set<string>(DRIVER_REQUEST_STATUSES);

/** Two requests are the same device when make and model match, ignoring case and spacing. */
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

export async function createDriverRequest(
  db: RequestDb,
  input: {
    orgId: string;
    by: { id: string; email: string | null };
    request: DriverRequestInput;
  },
): Promise<{ id: string; ticketId: string }> {
  const r = input.request;
  if (r.deviceId) {
    const device = await db.device.findFirst({ where: { id: r.deviceId, orgId: input.orgId } });
    if (!device) throw new DriverRequestError('Device not found');
  }
  // The same person asking twice for the same thing adds nothing; point them at the first.
  const open = await db.driverRequest.findMany({
    where: { orgId: input.orgId, status: { in: ['open', 'in_progress'] } },
  });
  const dup = open.find((o) => norm(o.make) === norm(r.make) && norm(o.model) === norm(r.model));
  if (dup) throw new DriverRequestError(`A driver for ${dup.make} ${dup.model} is already requested`);

  const lines = [
    `Make and model: ${r.make} ${r.model}`,
    `Type of device: ${assetCategoryLabel(r.category)}`,
    `Needs: ${r.need === 'control' ? 'monitoring and control' : 'monitoring only'}`,
    `How it is reached: ${DRIVER_REQUEST_PROTOCOL_LABEL[r.protocol]}`,
    r.docsUrl ? `Documentation: ${r.docsUrl}` : null,
    r.notes ? `Notes: ${r.notes}` : null,
  ].filter(Boolean);
  const ticket = await db.ticket.create({
    data: {
      orgId: input.orgId,
      title: `Driver request: ${r.make} ${r.model}`,
      body: lines.join('\n'),
      deviceId: r.deviceId ?? null,
      createdBy: input.by.id,
      createdByEmail: input.by.email?.toLowerCase() ?? null,
      routedTo: 'kestrel',
      status: 'open',
      escalatedAt: new Date(),
      escalatedBy: input.by.id,
    },
  });
  const row = await db.driverRequest.create({
    data: {
      orgId: input.orgId,
      deviceId: r.deviceId ?? null,
      ticketId: ticket.id,
      make: r.make,
      model: r.model,
      category: r.category,
      need: r.need,
      protocol: r.protocol,
      status: 'open',
      docsUrl: r.docsUrl || null,
      notes: r.notes,
      requestedBy: input.by.id,
      requestedByEmail: input.by.email?.toLowerCase() ?? null,
    },
  });
  return { id: row.id, ticketId: ticket.id };
}

export async function requestsForOrg(db: RequestDb, orgId: string) {
  return db.driverRequest.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 100 });
}

/** Every organisation's requests for staff, each with how many other organisations asked for the same device. */
export async function staffRequests(
  db: RequestDb,
  filter: { status?: DriverRequestStatus | 'active' | 'all' } = {},
) {
  const status = filter.status ?? 'active';
  const rows = await db.driverRequest.findMany({
    where:
      status === 'all'
        ? {}
        : { status: status === 'active' ? { in: ['open', 'in_progress'] } : status },
    orderBy: { createdAt: 'asc' },
    take: 300,
  });
  const orgs = rows.length
    ? await db.org.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.orgId))] } } })
    : [];
  const names = new Map(orgs.map((o) => [o.id, o.name]));
  const all = await db.driverRequest.findMany();
  return rows.map((r) => {
    const key = `${norm(r.make)}|${norm(r.model)}`;
    const askers = new Set(
      all.filter((a) => `${norm(a.make)}|${norm(a.model)}` === key).map((a) => a.orgId),
    );
    return { ...r, orgName: names.get(r.orgId) ?? 'Unknown organisation', orgsAsking: askers.size };
  });
}

export async function updateRequest(
  db: RequestDb,
  input: {
    id: string;
    staffUserId: string;
    status?: DriverRequestStatus;
    staffNote?: string;
    /** A finished driver in the Kestrel driver format. Saved into the asking organisation. */
    spec?: unknown;
  },
) {
  const req = await db.driverRequest.findFirst({ where: { id: input.id } });
  if (!req) throw new DriverRequestError('Request not found');
  if (input.status && !STATUS_SET.has(input.status)) throw new DriverRequestError('Unknown status');

  const before = req.status;
  let status = input.status ?? before;
  let driverSlug = req.driverSlug;
  if (input.spec !== undefined) {
    const res = await saveDriver(db, { orgId: req.orgId, raw: input.spec, by: input.staffUserId });
    if (!res.ok) throw new DriverRequestError(res.problems.slice(0, 3).join('. '));
    const slug = (input.spec as { id?: string }).id;
    driverSlug = slug ? `custom:${slug}` : driverSlug;
    status = 'built';
  }
  const updated = await db.driverRequest.update({
    where: { id: req.id },
    data: { status, driverSlug, staffNote: input.staffNote ?? req.staffNote },
  });

  if (req.ticketId && status !== before) {
    const message =
      status === 'built'
        ? `A driver for ${req.make} ${req.model} is ready. Open the device, choose “Custom” in the driver list and pick it.`
        : status === 'declined'
          ? `We can’t build a driver for ${req.make} ${req.model} right now.${input.staffNote ? ` ${input.staffNote}` : ''}`
          : null;
    if (message) {
      await db.ticketComment.create({
        data: {
          orgId: req.orgId,
          ticketId: req.ticketId,
          authorId: input.staffUserId,
          body: message,
          visibility: 'public',
          fromStaff: true,
        },
      });
      await db.ticket.update({
        where: { id: req.ticketId },
        data: { status: 'resolved', closedAt: new Date() },
      });
    } else if (status === 'in_progress') {
      await db.ticket.update({ where: { id: req.ticketId }, data: { status: 'in_progress' } });
    }
  }
  return updated;
}
