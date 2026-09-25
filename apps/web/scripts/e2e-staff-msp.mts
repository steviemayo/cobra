// Manual end-to-end check of the staff portal, service providers and site-limited access, run
// through the real tRPC router against the DEV database. It creates throwaway organisations, users
// (random ids; no sign-in needed because it calls the router directly) and staff rows, and deletes
// them all at the end, even if a check fails.
//
// Run from apps/web:
//   ../gateway/node_modules/.bin/tsx --conditions=react-server --env-file=../../.env scripts/e2e-staff-msp.mts
//
// What it proves that the unit tests cannot: real Postgres queries (uuid arrays, OR filters, joins),
// and the access rules as the router enforces them: who is let in, at what role, limited to which
// sites, and what a view-only staff session can and cannot do.
import { randomUUID } from 'node:crypto';
import { db } from '@kestrel/db';

// Staff need a second factor in production; a script has none.
process.env.STAFF_REQUIRE_MFA = 'false';
const { appRouter } = await import('../src/server/routers/_app.ts');

const tag = randomUUID().slice(0, 8);
const id = () => randomUUID();
let failures = 0;
let checks = 0;

function ok(name: string, cond: boolean, detail?: unknown) {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''}`);
  }
}

/** The router's error, or null if the call worked. `after()` needs a real request, so its complaint is not a failure. */
async function outcome(
  fn: () => Promise<unknown>,
): Promise<{ error: string | null; value?: unknown }> {
  try {
    return { error: null, value: await fn() };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/outside a request scope/i.test(message)) return { error: null };
    return { error: message };
  }
}
const refused = (o: { error: string | null }) => o.error !== null;
const as = (userId: string, email: string) =>
  appRouter.createCaller({ user: { id: userId, email } as never });

// ---- World ----------------------------------------------------------------------------------
const U = {
  cust: { id: id(), email: `owner-${tag}@e2e.test` },
  mspOwner: { id: id(), email: `msp-owner-${tag}@e2e.test` },
  mspSupport: { id: id(), email: `msp-support-${tag}@e2e.test` },
  outsider: { id: id(), email: `outsider-${tag}@e2e.test` },
  staffAdmin: { id: id(), email: `staff-admin-${tag}@e2e.test` },
  staffReader: { id: id(), email: `staff-reader-${tag}@e2e.test` },
};
const customer = id();
const msp = id();
const siteA = id();
const siteB = id();
const roomA = id();
const roomB = id();

async function setup() {
  await db.org.create({
    data: {
      id: customer,
      name: `E2E Customer ${tag}`,
      kind: 'customer',
      billing: { create: { trialEndsAt: new Date(Date.now() + 20 * 86_400_000) } },
      members: { create: { userId: U.cust.id, email: U.cust.email, role: 'owner' } },
    },
  });
  await db.org.create({
    data: {
      id: msp,
      name: `E2E Provider ${tag}`,
      kind: 'msp',
      billing: { create: { trialEndsAt: new Date(Date.now() + 20 * 86_400_000) } },
      members: {
        create: [
          { userId: U.mspOwner.id, email: U.mspOwner.email, role: 'owner' },
          { userId: U.mspSupport.id, email: U.mspSupport.email, role: 'support' },
        ],
      },
    },
  });
  await db.site.createMany({
    data: [
      { id: siteA, orgId: customer, name: 'Head office' },
      { id: siteB, orgId: customer, name: 'Warehouse' },
    ],
  });
  await db.room.createMany({
    data: [
      { id: roomA, orgId: customer, siteId: siteA, name: 'Boardroom', type: 'meeting' },
      { id: roomB, orgId: customer, siteId: siteB, name: 'Dock office', type: 'meeting' },
    ],
  });
  await db.staffUser.createMany({
    data: [
      { userId: U.staffAdmin.id, email: U.staffAdmin.email, roles: ['admin'] },
      { userId: U.staffReader.id, email: U.staffReader.email, roles: ['readonly'] },
    ],
  });
}

async function cleanup() {
  const staffIds = [U.staffAdmin.id, U.staffReader.id];
  await db.staffAudit.deleteMany({ where: { staffUserId: { in: staffIds } } });
  await db.supportSession.deleteMany({ where: { orgId: { in: [customer, msp] } } });
  await db.staffUser.deleteMany({ where: { userId: { in: staffIds } } });
  await db.org.deleteMany({ where: { id: { in: [customer, msp] } } }); // members, sites, rooms, grants, tickets, notes, overrides cascade
}

// ---- Checks ---------------------------------------------------------------------------------
async function run() {
  const cust = as(U.cust.id, U.cust.email);
  const provider = as(U.mspOwner.id, U.mspOwner.email);
  const support = as(U.mspSupport.id, U.mspSupport.email);
  const outsider = as(U.outsider.id, U.outsider.email);

  console.log('\nOutsiders');
  ok(
    'a stranger cannot list the customer’s rooms',
    refused(await outcome(() => outsider.room.list({ orgId: customer }))),
  );
  ok(
    'the customer’s owner can',
    !refused(await outcome(() => cust.room.list({ orgId: customer }))),
  );

  console.log('\nInviting a provider limited to one site');
  ok(
    'the code of a customer org is rejected',
    refused(
      await outcome(() =>
        cust.msp.invite({ orgId: customer, code: customer, role: 'manage', siteIds: [] }),
      ),
    ),
  );
  ok(
    'a site from another organisation is rejected',
    refused(
      await outcome(() =>
        cust.msp.invite({ orgId: customer, code: msp, role: 'manage', siteIds: [id()] }),
      ),
    ),
  );
  ok(
    'the provider cannot invite itself into the customer',
    refused(
      await outcome(() =>
        provider.msp.invite({ orgId: customer, code: msp, role: 'manage', siteIds: [] }),
      ),
    ),
  );
  const invited = await outcome(() =>
    cust.msp.invite({ orgId: customer, code: msp, role: 'manage', siteIds: [siteA] }),
  );
  ok('the owner can invite it for site A only', !refused(invited), invited.error);
  const grantId = (invited.value as { id: string }).id;
  ok(
    'a pending invitation gives no access',
    refused(await outcome(() => provider.room.list({ orgId: customer }))),
  );
  ok(
    'only the provider’s owner can accept',
    refused(await outcome(() => support.msp.respond({ orgId: msp, grantId, accept: true }))),
  );
  ok(
    'the provider’s owner accepts',
    !refused(await outcome(() => provider.msp.respond({ orgId: msp, grantId, accept: true }))),
  );

  console.log('\nA provider limited to site A');
  const rooms = (await provider.room.list({ orgId: customer })) as { id: string }[];
  ok(
    'sees only the room at site A',
    rooms.length === 1 && rooms[0]!.id === roomA,
    rooms.map((r) => r.id),
  );
  const overview = (await provider.room.overview({ orgId: customer })) as { id: string }[];
  ok('overview is limited too', overview.length === 1 && overview[0]!.id === roomA);
  ok(
    'cannot open the room at site B',
    refused(await outcome(() => provider.room.get({ orgId: customer, roomId: roomB }))),
  );
  const sites = (await provider.site.list({ orgId: customer })) as { id: string }[];
  ok('sees only site A', sites.length === 1 && sites[0]!.id === siteA);
  ok(
    'cannot open site B',
    refused(await outcome(() => provider.site.get({ orgId: customer, siteId: siteB }))),
  );
  const live = (await provider.monitoring.overview({ orgId: customer })) as {
    rooms: { id: string }[];
  };
  ok('monitoring overview is limited', live.rooms.length === 1 && live.rooms[0]!.id === roomA);
  ok(
    'cannot read monitoring for the room at site B',
    refused(await outcome(() => provider.monitoring.room({ orgId: customer, roomId: roomB }))),
  );
  const closed = await outcome(() => provider.deployment.overview({ orgId: customer }));
  ok(
    'deployments are not available to a site-limited provider',
    closed.error?.includes('limited to specific sites') === true,
    closed.error,
  );
  ok(
    'the team list is not available',
    refused(await outcome(() => provider.member.list({ orgId: customer }))),
  );
  ok(
    'billing is not available',
    refused(await outcome(() => provider.billing.status({ orgId: customer }))),
  );
  ok(
    'cannot rename the customer',
    refused(await outcome(() => provider.org.rename({ orgId: customer, name: 'Hijacked' }))),
  );
  ok(
    'cannot create a room',
    refused(
      await outcome(() =>
        provider.room.create({ orgId: customer, siteId: siteA, name: 'X', type: 'meeting' }),
      ),
    ),
  );
  ok(
    'cannot invite another provider or end the connection',
    refused(await outcome(() => provider.msp.end({ orgId: customer, grantId }))),
  );

  console.log('\nTickets follow the sites');
  const t1 = await cust.ticket.create({
    orgId: customer,
    title: `Site A problem ${tag}`,
    body: 'Screen is black',
    roomId: roomA,
    priority: 'normal',
    toKestrel: false,
  });
  const t2 = await cust.ticket.create({
    orgId: customer,
    title: `Site B problem ${tag}`,
    body: 'No sound',
    roomId: roomB,
    priority: 'normal',
    toKestrel: false,
  });
  const routed = await db.ticket.findMany({ where: { orgId: customer } });
  ok(
    'a ticket about a site A room goes to the provider',
    routed.find((t) => t.id === t1.id)?.routedTo === `msp:${msp}`,
    routed.map((t) => t.routedTo),
  );
  ok(
    'a ticket about a site B room stays with the customer’s team',
    routed.find((t) => t.id === t2.id)?.routedTo === 'org',
  );
  const list = (await provider.ticket.list({ orgId: customer, status: 'all', limit: 50 })) as {
    id: string;
  }[];
  ok(
    'the provider lists only the site A ticket',
    list.length === 1 && list[0]!.id === t1.id,
    list.map((t) => t.id),
  );
  ok(
    'it cannot open the site B ticket',
    refused(await outcome(() => provider.ticket.get({ orgId: customer, ticketId: t2.id }))),
  );
  ok(
    'it can comment on its own ticket',
    !refused(
      await outcome(() =>
        provider.ticket.comment({
          orgId: customer,
          ticketId: t1.id,
          body: 'On it',
          internal: false,
        }),
      ),
    ),
  );
  ok(
    'it cannot comment on the other',
    refused(
      await outcome(() =>
        provider.ticket.comment({ orgId: customer, ticketId: t2.id, body: 'Hi', internal: false }),
      ),
    ),
  );
  ok(
    'it cannot raise a ticket without a room at its sites',
    refused(
      await outcome(() =>
        provider.ticket.create({
          orgId: customer,
          title: 'Nope nope',
          body: 'x',
          priority: 'normal',
          toKestrel: false,
        }),
      ),
    ),
  );
  const queue = (await provider.msp.tickets({ orgId: msp, status: 'active' })) as { id: string }[];
  ok(
    'the provider’s own queue shows it',
    queue.some((t) => t.id === t1.id),
  );
  const dash = (await provider.msp.dashboard({ orgId: msp })) as {
    customers: { rooms: number; limitedToSites: number }[];
  };
  ok(
    'the provider’s dashboard counts only its site',
    dash.customers[0]?.rooms === 1 && dash.customers[0]?.limitedToSites === 1,
    dash.customers,
  );

  console.log('\nThe customer’s view');
  const provs = (await cust.msp.providers({ orgId: customer })) as {
    siteNames: string[];
    status: string;
  }[];
  ok(
    'lists the provider with its site',
    provs[0]?.siteNames[0] === 'Head office' && provs[0]?.status === 'active',
    provs,
  );
  const audit = (await cust.audit.list({ orgId: customer, limit: 50 })) as {
    actor: string;
    action: string;
  }[];
  ok(
    'the activity log records the invitation and its acceptance',
    audit.some((a) => a.action === 'msp.invite') && audit.some((a) => a.action === 'msp.accepted'),
    audit.map((a) => a.action),
  );

  console.log('\nEnding it');
  ok(
    'the customer ends the connection',
    !refused(await outcome(() => cust.msp.end({ orgId: customer, grantId }))),
  );
  ok(
    'the provider is locked out',
    refused(await outcome(() => provider.room.list({ orgId: customer }))),
  );
  ok(
    'its ticket went back to the customer’s team',
    (await db.ticket.findFirst({ where: { id: t1.id } }))?.routedTo === 'org',
  );

  console.log('\nA whole-organisation grant at support level');
  const again = await cust.msp.invite({ orgId: customer, code: msp, role: 'support', siteIds: [] });
  await provider.msp.respond({ orgId: msp, grantId: again.id, accept: true });
  const both = (await support.room.list({ orgId: customer })) as unknown[];
  ok('the provider’s support person sees both rooms', both.length === 2);
  ok(
    'but cannot create rooms (support is not dev)',
    refused(
      await outcome(() =>
        support.room.create({ orgId: customer, siteId: siteA, name: 'X', type: 'meeting' }),
      ),
    ),
  );
  ok(
    'and cannot rename the customer (owner only)',
    refused(await outcome(() => provider.org.rename({ orgId: customer, name: 'Hijacked' }))),
  );
  ok(
    'even the provider’s owner is capped below owner',
    refused(
      await outcome(() =>
        provider.msp.invite({ orgId: customer, code: msp, role: 'manage', siteIds: [] }),
      ),
    ),
  );
  await cust.msp.end({ orgId: customer, grantId: again.id });

  console.log('\nKestrel staff');
  const admin = as(U.staffAdmin.id, U.staffAdmin.email);
  const reader = as(U.staffReader.id, U.staffReader.email);
  ok(
    'a non-staff user cannot use the staff portal',
    refused(await outcome(() => cust.staff.orgs.list())),
  );
  const dir = (await admin.staff.orgs.list()) as { id: string }[];
  ok(
    'staff see the organisation directory',
    dir.some((o) => o.id === customer),
  );
  ok(
    'opening an organisation is audited',
    !refused(await outcome(() => admin.staff.orgs.get({ orgId: customer }))) &&
      (await db.staffAudit.count({ where: { orgId: customer, action: 'org.view' } })) === 1,
  );
  ok(
    'a read-only staff member cannot change a licence',
    refused(
      await outcome(() =>
        reader.staff.licence.set({ orgId: customer, plan: 'pro', reason: 'because' }),
      ),
    ),
  );
  ok(
    'staff cannot enter without a session',
    refused(await outcome(() => admin.room.list({ orgId: customer }))),
  );

  console.log('\nLicences');
  const before = (await cust.billing.status({ orgId: customer })) as {
    entitlements: { maxRooms: number | null; adjusted?: unknown };
  };
  ok(
    'the trial has the default room limit',
    before.entitlements.maxRooms === 5 && !before.entitlements.adjusted,
    before.entitlements,
  );
  ok(
    'a reason is required',
    refused(
      await outcome(() => admin.staff.licence.set({ orgId: customer, maxRooms: 9, reason: 'x' })),
    ),
  );
  ok(
    'staff lift the room limit',
    !refused(
      await outcome(() =>
        admin.staff.licence.set({ orgId: customer, maxRooms: 9, reason: 'Pilot for the e2e run' }),
      ),
    ),
  );
  const after = (await cust.billing.status({ orgId: customer })) as {
    entitlements: { maxRooms: number | null; adjusted?: unknown };
  };
  ok(
    'the customer sees the adjusted limit and that Kestrel adjusted it',
    after.entitlements.maxRooms === 9 && !!after.entitlements.adjusted,
    after.entitlements,
  );
  const log = (await cust.audit.list({ orgId: customer, limit: 50 })) as {
    actor: string;
    action: string;
    meta: Record<string, unknown>;
  }[];
  const entry = log.find((a) => a.action === 'license.adjust');
  ok(
    'the activity log says Kestrel staff, without the reason',
    entry?.actor === 'Kestrel staff' && !JSON.stringify(entry).includes('Pilot for the e2e run'),
    entry,
  );

  console.log('\nSupport sessions');
  ok(
    'a reason is required',
    refused(
      await outcome(() =>
        admin.staff.session.start({ orgId: customer, mode: 'read', reason: 'no', minutes: 15 }),
      ),
    ),
  );
  const started = await outcome(() =>
    admin.staff.session.start({
      orgId: customer,
      mode: 'read',
      reason: 'Checking the e2e customer',
      minutes: 15,
    }),
  );
  ok('staff open a view-only session', !refused(started), started.error);
  const seen = (await admin.room.list({ orgId: customer })) as unknown[];
  ok('inside it they see the customer’s rooms', seen.length === 2);
  const blocked = await outcome(() =>
    admin.ticket.comment({
      orgId: customer,
      ticketId: t2.id,
      body: 'Should not post',
      internal: false,
    }),
  );
  ok(
    'a view-only session refuses every change',
    blocked.error?.includes('view-only') === true,
    blocked.error,
  );
  ok(
    'and logs the attempt',
    (await db.staffAudit.count({ where: { orgId: customer, action: 'session.blocked' } })) >= 1,
  );
  ok(
    'the customer’s log shows the session and why',
    (await db.auditLog.count({ where: { orgId: customer, action: 'staff.session.start' } })) === 1,
  );
  ok(
    'ending it stops access',
    !refused(
      await outcome(() =>
        admin.staff.session.end({ sessionId: (started.value as { id: string }).id }),
      ),
    ) && refused(await outcome(() => admin.room.list({ orgId: customer }))),
  );

  console.log('\nA customer that blocks staff');
  await cust.org.setStaffAccess({ orgId: customer, blocked: true });
  ok(
    'a session without a ticket is refused',
    refused(
      await outcome(() =>
        admin.staff.session.start({
          orgId: customer,
          mode: 'read',
          reason: 'Trying anyway',
          minutes: 15,
        }),
      ),
    ),
  );
  ok(
    'a linked open ticket counts as consent',
    !refused(
      await outcome(() =>
        admin.staff.session.start({
          orgId: customer,
          mode: 'act',
          reason: 'They raised a ticket',
          minutes: 15,
          ticketId: t2.id,
        }),
      ),
    ),
  );
  ok(
    'in an act session a change goes through',
    !refused(
      await outcome(() =>
        admin.ticket.update({ orgId: customer, ticketId: t2.id, priority: 'high' }),
      ),
    ),
  );
  ok(
    'and is logged against the session',
    (await db.staffAudit.count({ where: { orgId: customer, action: 'session.act' } })) >= 1,
  );
  const t2row = await db.ticket.findFirst({ where: { id: t2.id } });
  ok('the change really happened', t2row?.priority === 'high');
  await admin.staff.session.end({
    sessionId: (await db.supportSession.findFirst({ where: { orgId: customer, endedAt: null } }))!
      .id,
  });

  console.log('\nTicket escalation to Kestrel');
  ok(
    'the customer’s owner escalates a ticket',
    !refused(
      await outcome(() =>
        cust.ticket.escalate({ orgId: customer, ticketId: t2.id, note: 'Please look' }),
      ),
    ),
  );
  const q = (await admin.staff.tickets.queue({})) as { id: string; orgName: string }[];
  ok(
    'it is in the staff queue',
    q.some((r) => r.id === t2.id),
  );
  ok(
    'staff reply, publicly',
    !refused(
      await outcome(() =>
        admin.staff.tickets.comment({
          ticketId: t2.id,
          body: 'We are looking',
          visibility: 'public',
        }),
      ),
    ),
  );
  ok(
    'and leave an internal note',
    !refused(
      await outcome(() =>
        admin.staff.tickets.comment({
          ticketId: t2.id,
          body: 'Secret note',
          visibility: 'internal',
        }),
      ),
    ),
  );
  const thread = (await cust.ticket.get({ orgId: customer, ticketId: t2.id })) as {
    comments: { body: string; authorEmail: string; visibility: string }[];
  };
  ok(
    'the customer’s owner sees the reply as Kestrel support and the internal note',
    thread.comments.some(
      (c) => c.body === 'We are looking' && c.authorEmail === 'Kestrel support',
    ) && thread.comments.some((c) => c.body === 'Secret note'),
  );
  const viewer = id();
  await db.member.create({
    data: {
      orgId: customer,
      userId: viewer,
      email: `viewer-${tag}@e2e.test`,
      role: 'customer_viewer',
    },
  });
  const asViewer = (await as(viewer, `viewer-${tag}@e2e.test`).ticket.get({
    orgId: customer,
    ticketId: t2.id,
  })) as { comments: { body: string }[] };
  ok(
    'a customer viewer never sees the internal note',
    !asViewer.comments.some((c) => c.body === 'Secret note') &&
      asViewer.comments.some((c) => c.body === 'We are looking'),
  );
  ok(
    'staff hand it back',
    !refused(
      await outcome(() => admin.staff.tickets.handBack({ ticketId: t2.id, note: 'Over to you' })),
    ),
  );

  console.log('\nFleet health');
  const h = (await admin.staff.health()) as { summary: { organisations: number } };
  ok('staff see the fleet summary', h.summary.organisations >= 1);
}

// ---- Go -------------------------------------------------------------------------------------
try {
  await setup();
  await run();
} catch (e) {
  failures++;
  console.error('\nThe run stopped early:', e);
} finally {
  await cleanup().catch((e) => {
    failures++;
    console.error('CLEANUP FAILED (delete the "E2E" organisations by hand):', e);
  });
  await db.$disconnect();
}
console.log(`\n${checks} checks, ${failures} failed.`);
process.exit(failures ? 1 : 0);
