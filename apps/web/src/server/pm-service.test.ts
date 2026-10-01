import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '@kestrel/crypto';
import { STARTER_PM_TEMPLATES } from '@kestrel/model';
import {
  addStarterTemplates,
  autoAnswer,
  createSchedule,
  createTemplate,
  deleteSchedule,
  deleteTemplate,
  discardRun,
  issuePmReport,
  listSchedules,
  pmStatus,
  pmSweep,
  saveRun,
  signRun,
  startRun,
  updateTemplate,
  type PmDb,
} from './pm-service';
import { PM_REPORT_PURPOSE, checkDocument } from './register-issues';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const ROOM = '33333333-3333-4333-8333-333333333331';
const DEV = '44444444-4444-4444-8444-444444444441';
const NOW = new Date('2026-09-30T10:00:00Z');
const day = (s: string) => new Date(`${s}T00:00:00Z`);
const at = (d: number) => new Date(NOW.getTime() + d * 86_400_000);

function world() {
  const pmTemplate = table([]);
  const pmSchedule = table([]);
  const pmRun = table([]);
  const room = table([{ id: ROOM, orgId: ORG, name: 'Boardroom', siteId: 's' }]);
  const device = table([
    {
      id: DEV,
      orgId: ORG,
      roomId: ROOM,
      kind: 'active',
      category: 'display',
      name: 'Display',
      online: true,
      firmware: '1.0',
      status: 'in_service',
      configState: {},
    },
    {
      id: 'd2',
      orgId: ORG,
      roomId: ROOM,
      kind: 'active',
      category: 'ptz_camera',
      name: 'Camera',
      online: true,
      firmware: null,
      status: 'in_service',
      configState: {},
    },
  ]);
  const incident = table([]);
  const ticket = table([]);
  const org = table([{ id: ORG, name: 'Acme AV' }]);
  const registerIssue = table([]);
  const deviceEvent = table([]);
  const db = {
    pmTemplate,
    pmSchedule,
    pmRun,
    room,
    device,
    incident,
    ticket,
    org,
    registerIssue,
    deviceEvent,
  } as unknown as PmDb;
  return {
    db,
    pmTemplate,
    pmSchedule,
    pmRun,
    device,
    incident,
    ticket,
    registerIssue,
    deviceEvent,
  };
}

const roomItems = [
  { id: 'online', label: 'Every device answers', type: 'passfail', auto: 'devices_online' },
  { id: 'picture', label: 'Picture is clear', type: 'passfail' },
  { id: 'level', label: 'Speaker level', type: 'number', unit: 'dB', min: 40, max: 60 },
  { id: 'notes', label: 'Notes', type: 'text' },
];

async function roomTemplate(
  w: ReturnType<typeof world>,
  items: unknown[] = roomItems,
  name = 'Room check',
) {
  const r = await createTemplate(w.db, {
    orgId: ORG,
    name,
    appliesTo: 'room',
    items,
    userId: null,
  });
  if (!r.ok) throw new Error(r.message);
  return r.value.id;
}

describe('checklists', () => {
  it('creates, refuses repeats and bad items, bumps the version on a change, and refuses to delete one in use', async () => {
    const w = world();
    const id = await roomTemplate(w);
    expect(
      (
        await createTemplate(w.db, {
          orgId: ORG,
          name: 'Room check',
          appliesTo: 'room',
          items: roomItems,
          userId: null,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await createTemplate(w.db, {
          orgId: ORG,
          name: 'Empty',
          appliesTo: 'room',
          items: [],
          userId: null,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await createTemplate(w.db, {
          orgId: ORG,
          name: 'Twice',
          appliesTo: 'room',
          items: [roomItems[0], roomItems[0]],
          userId: null,
        })
      ).ok,
    ).toBe(false);
    await updateTemplate(w.db, {
      orgId: ORG,
      templateId: id,
      items: [...roomItems, { id: 'x', label: 'Extra', type: 'passfail' }],
    });
    expect(w.pmTemplate.rows[0]!.version).toBe(2);
    await createSchedule(w.db, {
      orgId: ORG,
      templateId: id,
      roomId: ROOM,
      intervalDays: 90,
      firstDueOn: day('2026-10-15'),
      userId: null,
    });
    expect((await deleteTemplate(w.db, ORG, id)).ok).toBe(false);
  });

  it('adds the starter checklists once', async () => {
    const w = world();
    expect(await addStarterTemplates(w.db, ORG, null)).toBe(STARTER_PM_TEMPLATES.length);
    expect(await addStarterTemplates(w.db, ORG, null)).toBe(0);
  });
});

describe('schedules', () => {
  it('needs the right target for the checklist, and says overdue or due soon', async () => {
    const w = world();
    const id = await roomTemplate(w);
    expect(
      (
        await createSchedule(w.db, {
          orgId: ORG,
          templateId: id,
          intervalDays: 90,
          firstDueOn: day('2026-10-15'),
          userId: null,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await createSchedule(w.db, {
          orgId: ORG,
          templateId: id,
          roomId: ROOM,
          intervalDays: 0,
          firstDueOn: day('2026-10-15'),
          userId: null,
        })
      ).ok,
    ).toBe(false);
    const dev = await createTemplate(w.db, {
      orgId: ORG,
      name: 'Camera check',
      appliesTo: 'device',
      category: 'ptz_camera',
      items: [{ id: 'a', label: 'A', type: 'passfail' }],
      userId: null,
    });
    if (!dev.ok) throw new Error('x');
    expect(
      (
        await createSchedule(w.db, {
          orgId: ORG,
          templateId: dev.value.id,
          deviceId: DEV,
          intervalDays: 30,
          firstDueOn: day('2026-10-15'),
          userId: null,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await createSchedule(w.db, {
          orgId: ORG,
          templateId: dev.value.id,
          deviceId: 'd2',
          intervalDays: 30,
          firstDueOn: day('2026-10-15'),
          userId: null,
        })
      ).ok,
    ).toBe(true);
    await createSchedule(w.db, {
      orgId: ORG,
      templateId: id,
      roomId: ROOM,
      intervalDays: 90,
      firstDueOn: day('2026-09-20'),
      userId: null,
    });
    const list = await listSchedules(w.db, ORG, NOW);
    expect(list.map((s) => s.state).sort()).toEqual(['ok', 'overdue']);
  });
});

describe('a visit', () => {
  it('fills in what monitoring can answer, and says what it saw', async () => {
    const w = world();
    const t = await roomTemplate(w);
    w.device.rows[1]!.online = false;
    const r = await startRun(w.db, { orgId: ORG, templateId: t, roomId: ROOM, userId: 'u1' }, NOW);
    if (!r.ok) throw new Error(r.message);
    const results = w.pmRun.rows[0]!.results as {
      itemId: string;
      result: unknown;
      auto?: { value: string };
    }[];
    expect(results.find((x) => x.itemId === 'online')).toMatchObject({
      result: 'fail',
      auto: { value: '1 of 2 not answering' },
    });
    expect(results.find((x) => x.itemId === 'picture')!.result).toBeNull();
  });

  it('answers each auto source from live data', async () => {
    const w = world();
    expect(
      await autoAnswer(w.db, ORG, 'device_online', { roomId: null, deviceId: DEV }),
    ).toMatchObject({ result: 'pass' });
    expect(
      await autoAnswer(w.db, ORG, 'firmware_known', { roomId: null, deviceId: 'd2' }),
    ).toMatchObject({ result: 'fail' });
    w.device.rows[0]!.configState = { power: { drifted: true } };
    expect(
      await autoAnswer(w.db, ORG, 'no_config_drift', { roomId: ROOM, deviceId: null }),
    ).toMatchObject({ result: 'fail', value: '1 device drifted' });
    w.incident.rows.push({ id: 'i', orgId: ORG, roomId: ROOM, status: 'open', subject: 's' });
    expect(
      await autoAnswer(w.db, ORG, 'no_open_incidents', { roomId: ROOM, deviceId: null }),
    ).toMatchObject({ result: 'fail', value: '1 open' });
  });

  it('cannot be signed until everything is answered, then is frozen', async () => {
    const w = world();
    const t = await roomTemplate(w);
    const start = await startRun(
      w.db,
      { orgId: ORG, templateId: t, roomId: ROOM, userId: 'u1' },
      NOW,
    );
    if (!start.ok) throw new Error(start.message);
    const runId = start.value.id;
    const sign = (over = {}) =>
      signRun(
        w.db,
        {
          orgId: ORG,
          runId,
          userId: 'u1',
          name: 'Sam Tech',
          raiseTicket: false,
          markInRepair: false,
          ...over,
        },
        at(1),
      );
    expect(await sign()).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Still to answer/),
    });
    const answers = (w.pmRun.rows[0]!.results as Record<string, unknown>[]).map((r) =>
      r.itemId === 'picture'
        ? { ...r, result: 'pass' }
        : r.itemId === 'level'
          ? { ...r, result: 50 }
          : r,
    );
    expect(
      (await saveRun(w.db, { orgId: ORG, runId, results: answers, notes: 'All good' })).ok,
    ).toBe(true);
    expect(await sign({ name: '  ' })).toMatchObject({ ok: false });
    const done = await sign();
    expect(done).toMatchObject({ ok: true, value: { failed: 0, ticketId: null } });
    expect(w.pmRun.rows[0]).toMatchObject({ status: 'signed', signedByName: 'Sam Tech' });
    // Frozen: no more answers, no second sign-off, no removal.
    expect((await saveRun(w.db, { orgId: ORG, runId, results: answers })).ok).toBe(false);
    expect((await sign()).ok).toBe(false);
    expect((await discardRun(w.db, ORG, runId)).ok).toBe(false);
  });

  it('raises one ticket for the failed items, marks a failed device in repair, and records it in the device history', async () => {
    const w = world();
    const t = await createTemplate(w.db, {
      orgId: ORG,
      name: 'Display check',
      appliesTo: 'device',
      category: 'display',
      items: [
        { id: 'picture', label: 'Picture is clear', type: 'passfail' },
        { id: 'hours', label: 'Hours', type: 'number', max: 1000 },
      ],
      userId: null,
    });
    if (!t.ok) throw new Error('x');
    const start = await startRun(
      w.db,
      { orgId: ORG, templateId: t.value.id, deviceId: DEV, userId: 'u1' },
      NOW,
    );
    if (!start.ok) throw new Error(start.message);
    const answers = [
      {
        itemId: 'picture',
        label: 'Picture is clear',
        type: 'passfail',
        result: 'fail',
        note: 'Dead pixels',
      },
      { itemId: 'hours', label: 'Hours', type: 'number', result: 1500 },
    ];
    await saveRun(w.db, { orgId: ORG, runId: start.value.id, results: answers });
    const done = await signRun(
      w.db,
      {
        orgId: ORG,
        runId: start.value.id,
        userId: 'u1',
        name: 'Sam',
        raiseTicket: true,
        markInRepair: true,
      },
      at(1),
    );
    expect(done).toMatchObject({ ok: true, value: { failed: 2 } });
    expect(w.ticket.rows).toHaveLength(1);
    expect(w.ticket.rows[0]).toMatchObject({ deviceId: DEV, roomId: ROOM });
    expect(String(w.ticket.rows[0]!.body)).toContain('Dead pixels');
    expect(w.device.rows[0]!.status).toBe('in_repair');
    expect(w.deviceEvent.rows.map((e) => e.type)).toEqual(
      expect.arrayContaining(['status_changed', 'pm_failed']),
    );
  });

  it('moves the schedule on after sign-off, and closes the overdue notice', async () => {
    const w = world();
    const t = await roomTemplate(w, [{ id: 'a', label: 'A', type: 'passfail' }]);
    const s = await createSchedule(w.db, {
      orgId: ORG,
      templateId: t,
      roomId: ROOM,
      intervalDays: 90,
      firstDueOn: day('2026-09-25'),
      userId: null,
    });
    if (!s.ok) throw new Error('x');
    const jobs = await pmSweep(w.db, NOW);
    expect(jobs).toHaveLength(1);
    expect(w.incident.rows[0]).toMatchObject({
      kind: 'pm_overdue',
      severity: 'info',
      status: 'open',
    });
    const start = await startRun(
      w.db,
      { orgId: ORG, templateId: t, scheduleId: s.value.id, userId: 'u1' },
      NOW,
    );
    if (!start.ok) throw new Error(start.message);
    await saveRun(w.db, {
      orgId: ORG,
      runId: start.value.id,
      results: [{ itemId: 'a', label: 'A', type: 'passfail', result: 'pass' }],
    });
    await signRun(
      w.db,
      {
        orgId: ORG,
        runId: start.value.id,
        userId: 'u1',
        name: 'Sam',
        raiseTicket: false,
        markInRepair: false,
      },
      NOW,
    );
    expect(w.pmSchedule.rows[0]!.lastRunOn).toEqual(day('2026-09-30'));
    // Five days late is within a fifth of 90 days, so the rhythm holds: 25 Sep plus 90 days.
    expect((w.pmSchedule.rows[0]!.nextDueOn as Date).toISOString().slice(0, 10)).toBe('2026-12-24');
    expect(w.incident.rows[0]!.status).toBe('resolved');
  });
});

describe('status and reports', () => {
  it('counts overdue and due soon, and on-time share', async () => {
    const w = world();
    const t = await roomTemplate(w, [{ id: 'a', label: 'A', type: 'passfail' }]);
    await createSchedule(w.db, {
      orgId: ORG,
      templateId: t,
      roomId: ROOM,
      intervalDays: 90,
      firstDueOn: day('2026-09-20'),
      userId: null,
    });
    await createSchedule(w.db, {
      orgId: ORG,
      templateId: t,
      roomId: ROOM,
      intervalDays: 90,
      firstDueOn: day('2026-10-03'),
      userId: null,
    });
    w.pmRun.rows.push(
      {
        id: 'r1',
        orgId: ORG,
        status: 'signed',
        dueOn: day('2026-06-01'),
        signedAt: day('2026-05-30'),
        roomId: ROOM,
      },
      {
        id: 'r2',
        orgId: ORG,
        status: 'signed',
        dueOn: day('2026-06-01'),
        signedAt: day('2026-06-10'),
        roomId: ROOM,
      },
    );
    const s = await pmStatus(w.db, ORG, NOW);
    expect(s).toMatchObject({ overdue: 1, dueSoon: 1, schedules: 2, onTimePct: 50 });
    expect(await pmStatus(w.db, ORG, NOW, new Set(['other']))).toMatchObject({
      overdue: 0,
      schedules: 0,
      onTimePct: null,
    });
  });

  it('signs a report of the visits in a period, and the signature checks out', async () => {
    const w = world();
    const t = await roomTemplate(w, [{ id: 'a', label: 'A', type: 'passfail' }]);
    const start = await startRun(
      w.db,
      { orgId: ORG, templateId: t, roomId: ROOM, userId: 'u1' },
      NOW,
    );
    if (!start.ok) throw new Error(start.message);
    await saveRun(w.db, {
      orgId: ORG,
      runId: start.value.id,
      results: [{ itemId: 'a', label: 'A', type: 'passfail', result: 'pass' }],
    });
    await signRun(
      w.db,
      {
        orgId: ORG,
        runId: start.value.id,
        userId: 'u1',
        name: 'Sam',
        raiseTicket: false,
        markInRepair: false,
      },
      NOW,
    );
    const keys = generateKeyPair();
    const report = await issuePmReport(
      w.db,
      { orgId: ORG, from: day('2026-09-01'), to: day('2026-09-30'), userId: 'u1' },
      { ...keys, keyId: 'k1' },
      NOW,
    );
    if (!report.ok) throw new Error(report.message);
    const stored = w.registerIssue.rows[0]!;
    expect(stored).toMatchObject({ kind: 'pm_report', number: 1 });
    const payload = (stored.payload as { payload: { summary: { visits: number } } }).payload;
    expect(payload.summary.visits).toBe(1);
    expect(
      checkDocument(stored.payload, PM_REPORT_PURPOSE, [
        { keyId: 'k1', publicKeyPem: keys.publicKeyPem },
      ]),
    ).toMatchObject({ valid: true, number: 1 });
    expect(
      (
        await issuePmReport(
          w.db,
          { orgId: ORG, from: day('2026-10-01'), to: day('2026-09-01'), userId: null },
          { ...keys, keyId: 'k1' },
        )
      ).ok,
    ).toBe(false);
  });

  it('removes a schedule and its overdue notice', async () => {
    const w = world();
    const t = await roomTemplate(w, [{ id: 'a', label: 'A', type: 'passfail' }]);
    const s = await createSchedule(w.db, {
      orgId: ORG,
      templateId: t,
      roomId: ROOM,
      intervalDays: 30,
      firstDueOn: day('2026-09-01'),
      userId: null,
    });
    if (!s.ok) throw new Error('x');
    await pmSweep(w.db, NOW);
    expect((await deleteSchedule(w.db, ORG, s.value.id)).ok).toBe(true);
    expect(w.incident.rows[0]!.status).toBe('resolved');
    expect(w.pmSchedule.rows).toHaveLength(0);
  });
});
