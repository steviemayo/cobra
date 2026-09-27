import type { Prisma, PrismaClient } from '@kestrel/db';
import { isVideoDestination, type RoomModel } from '@kestrel/model';

// Commissioning: a walk through a room to check every part of it works, made from the room's design,
// with a record of who signed it off. A signed-off run never changes. These functions take the
// database as a parameter so they can be tested without one.
export type CommissioningDb = Pick<PrismaClient, 'commissioningRun'>;

export type Result = 'pending' | 'pass' | 'fail' | 'skip';

export interface CheckItem {
  /** Stable for a design, so a re-run lines up with the last. */
  id: string;
  group: string;
  label: string;
  hint?: string;
  result: Result;
  note?: string;
}

export const MAX_NOTE = 500;
export const MAX_ITEMS = 80;

export class CommissioningError extends Error {}

const CAMERAS = ['conf_camera', 'fixed_camera', 'ptz_camera', 'autoframing_camera'];
const ENVIRONMENT = ['lighting', 'blinds', 'screen', 'lifter', 'hvac'];

/** The checks for a room, in the order someone would walk through them. */
export function checklistFor(model: RoomModel): CheckItem[] {
  const items: CheckItem[] = [];
  const add = (group: string, id: string, label: string, hint?: string) =>
    items.push({ id, group, label, ...(hint ? { hint } : {}), result: 'pending' });

  for (const a of model.activities) {
    if (a.hidden) continue;
    if (a.kind === 'room_off')
      add('What people do', `activity:${a.id}`, `“${a.name}” turns everything off`, 'Screens go off or blank and the room goes quiet.');
    else if (a.kind === 'video_call')
      add('What people do', `activity:${a.id}`, `Start “${a.name}” and join a test call`, 'The far end sees and hears the room, and the room hears the far end.');
    else if (a.kind === 'record')
      add('What people do', `activity:${a.id}`, `“${a.name}” starts and stops a recording`, 'The recording is saved and plays back.');
    else if (a.sources.length > 0)
      for (const s of a.sources)
        add('What people do', `activity:${a.id}:${s.id}`, `“${a.name}” with ${s.label}`, `The right screen comes on, shows ${s.label}, and the sound follows.`);
    else add('What people do', `activity:${a.id}`, `Start “${a.name}”`, 'Everything it should turn on comes on.');
  }

  for (const d of model.devices) {
    if (isVideoDestination(d.category))
      add('Screens', `display:${d.id}`, `${d.name} shows a picture`, 'Right size, sharp, and nothing cut off at the edges.');
  }
  for (const d of model.devices) {
    if (d.category === 'audio_destination') add('Sound', `speakers:${d.id}`, `Sound comes from ${d.name}`, 'Clear, at a comfortable level.');
    else if (d.category === 'reinforcement_mic')
      add('Sound', `mic:${d.id}`, `Speak into ${d.name}`, 'You hear yourself through the room speakers, with no squeal.');
    else if (d.category === 'voice_capture_mic')
      add('Sound', `mic:${d.id}`, `The far end hears ${d.name} in a call`, 'Voices are clear from every seat that should be covered.');
  }
  if (model.devices.some((d) => d.category === 'audio_destination' || d.category === 'display' || d.category === 'projector'))
    add('Sound', 'room:volume', 'Volume up, down and mute work on the panel', 'Each press changes the sound; mute silences it.');

  for (const d of model.devices) {
    if (CAMERAS.includes(d.category)) {
      add('Cameras', `camera:${d.id}`, `${d.name} shows a picture`, 'Framed on the right part of the room.');
      if (d.category === 'ptz_camera' || d.category === 'autoframing_camera')
        add('Cameras', `camera:${d.id}:move`, `${d.name} moves and recalls its saved positions`, 'It moves smoothly and returns to each preset.');
    }
  }
  for (const d of model.devices) {
    if (ENVIRONMENT.includes(d.category)) add('Room', `env:${d.id}`, `${d.name} works from the panel`);
    else if (d.category === 'occupancy_sensor')
      add('Room', `sensor:${d.id}`, `${d.name} notices someone walking in`, 'The room reacts, or Monitoring shows the room as occupied.');
  }

  add('Room', 'room:online', 'Every device shows online in Monitoring', 'Nothing is listed as not answering.');
  add('Room', 'room:panel', 'The panel opens on the room’s tablet or screen and matches what the room is doing');
  return items.slice(0, MAX_ITEMS);
}

export function progress(items: CheckItem[]) {
  const count = (r: Result) => items.filter((i) => i.result === r).length;
  return { total: items.length, pending: count('pending'), pass: count('pass'), fail: count('fail'), skip: count('skip') };
}

// ---- Runs ----------------------------------------------------------------------------------------

export interface RunView {
  id: string;
  roomId: string;
  releaseNumber: number | null;
  items: CheckItem[];
  status: 'in_progress' | 'signed_off';
  startedAt: Date;
  startedByEmail: string | null;
  signedOffAt: Date | null;
  signedOffByEmail: string | null;
  notes: string | null;
}

type Row = Awaited<ReturnType<CommissioningDb['commissioningRun']['findFirst']>>;

function view(row: NonNullable<Row>): RunView {
  return {
    id: row.id,
    roomId: row.roomId,
    releaseNumber: row.releaseNumber,
    items: row.items as unknown as CheckItem[],
    status: row.status === 'signed_off' ? 'signed_off' : 'in_progress',
    startedAt: row.startedAt,
    startedByEmail: row.startedByEmail,
    signedOffAt: row.signedOffAt,
    signedOffByEmail: row.signedOffByEmail,
    notes: row.notes,
  };
}

/** Starts a walk-through. Only one can be under way for a room at a time. */
export async function startRun(
  db: CommissioningDb,
  input: { orgId: string; roomId: string; model: RoomModel; releaseNumber: number | null; user: { id: string; email: string | null } },
): Promise<RunView> {
  const open = await db.commissioningRun.findFirst({ where: { orgId: input.orgId, roomId: input.roomId, status: 'in_progress' } });
  if (open) throw new CommissioningError('A check of this room is already under way. Finish or sign it off first.');
  const row = await db.commissioningRun.create({
    data: {
      orgId: input.orgId,
      roomId: input.roomId,
      releaseNumber: input.releaseNumber,
      items: checklistFor(input.model) as unknown as Prisma.InputJsonValue,
      startedBy: input.user.id,
      startedByEmail: input.user.email,
    },
  });
  return view(row);
}

export async function getRun(db: CommissioningDb, orgId: string, runId: string): Promise<RunView | null> {
  const row = await db.commissioningRun.findFirst({ where: { id: runId, orgId } });
  return row ? view(row) : null;
}

export async function listRuns(db: CommissioningDb, orgId: string, roomId: string): Promise<RunView[]> {
  const rows = await db.commissioningRun.findMany({ where: { orgId, roomId }, orderBy: { startedAt: 'desc' }, take: 50 });
  return rows.map(view);
}

/** Records how one check went. A failure needs a note saying what was wrong. */
export async function setResult(
  db: CommissioningDb,
  input: { orgId: string; runId: string; itemId: string; result: Result; note?: string },
): Promise<RunView> {
  const row = await db.commissioningRun.findFirst({ where: { id: input.runId, orgId: input.orgId } });
  if (!row) throw new CommissioningError('Check not found.');
  if (row.status === 'signed_off') throw new CommissioningError('This check has been signed off and cannot change.');
  const items = row.items as unknown as CheckItem[];
  const item = items.find((i) => i.id === input.itemId);
  if (!item) throw new CommissioningError('That item is not in this check.');
  const note = input.note?.trim().slice(0, MAX_NOTE);
  item.result = input.result;
  if (note) item.note = note;
  else if (input.result === 'pass' || input.result === 'pending') delete item.note;
  const updated = await db.commissioningRun.update({ where: { id: row.id }, data: { items: items as unknown as Prisma.InputJsonValue } });
  return view(updated);
}

/**
 * Signs the check off. Everything must have an answer, and every failure a note. A check with
 * failures can still be signed off (to record what was found), and says so.
 */
export async function signOff(
  db: CommissioningDb,
  input: { orgId: string; runId: string; notes?: string; user: { id: string; email: string | null } },
  now = new Date(),
): Promise<RunView> {
  const row = await db.commissioningRun.findFirst({ where: { id: input.runId, orgId: input.orgId } });
  if (!row) throw new CommissioningError('Check not found.');
  if (row.status === 'signed_off') throw new CommissioningError('This check has already been signed off.');
  const items = row.items as unknown as CheckItem[];
  const p = progress(items);
  if (p.pending > 0) throw new CommissioningError(`${p.pending} ${p.pending === 1 ? 'item still needs' : 'items still need'} an answer.`);
  const bare = items.filter((i) => i.result === 'fail' && !i.note);
  if (bare.length > 0) throw new CommissioningError(`Say what was wrong with “${bare[0]!.label}” before signing off.`);
  const updated = await db.commissioningRun.update({
    where: { id: row.id },
    data: {
      status: 'signed_off',
      signedOffBy: input.user.id,
      signedOffByEmail: input.user.email,
      signedOffAt: now,
      notes: input.notes?.trim().slice(0, 2000) || null,
    },
  });
  return view(updated);
}
