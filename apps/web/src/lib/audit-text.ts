import { ROLE_LABEL } from './format';

const s = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const role = (v: unknown) => ROLE_LABEL[s(v) as keyof typeof ROLE_LABEL] ?? s(v);

// Human wording for audit log rows: "<actor> <this text>".
export function describeAudit(action: string, meta: Record<string, unknown>): string {
  switch (action) {
    case 'member.join_request':
      return `asked to join this organisation (${s(meta.email)})`;
    case 'member.join_approve':
      return `approved ${s(meta.email)} joining as ${role(meta.role)}`;
    case 'member.join_decline':
      return `declined ${s(meta.email)}’s request to join`;
    case 'msp.invite':
      return `invited ${s(meta.msp)} to look after this organisation (${s(meta.role)} access)`;
    case 'msp.invited':
      return `invited us to look after ${s(meta.customer)} (${s(meta.role)} access)`;
    case 'msp.accepted':
      return meta.msp
        ? `${s(meta.msp)} accepted the invitation`
        : `accepted the invitation from ${s(meta.customer)}`;
    case 'msp.declined':
      return meta.msp
        ? `${s(meta.msp)} declined the invitation`
        : `declined the invitation from ${s(meta.customer)}`;
    case 'msp.ended':
      return meta.msp
        ? `ended the connection with ${s(meta.msp)}`
        : `ended the connection with ${s(meta.customer)}`;
    case 'msp.brand':
      return `updated the brand shown to customers (“${s(meta.name)}”)`;
    case 'msp.brand_on':
      return `chose to show ${s(meta.msp)}’s name, logo and colour in the portal and on panels`;
    case 'msp.brand_off':
      return `stopped showing ${s(meta.msp)}’s name, logo and colour`;
    case 'ticket.route':
      return `${meta.to === 'provider' ? 'sent' : 'took back'} support request “${s(meta.title)}”${meta.to === 'provider' ? ' to the service provider' : ' for your own team'}`;
    case 'staff.session.start':
      return `started a ${s(meta.mode) === 'act' ? 'support session where they can make changes' : 'view-only support session'} for ${s(meta.minutes)} minutes: “${s(meta.reason)}”${meta.ticketId ? ' (linked to a support ticket)' : ''}`;
    case 'staff.session.end':
      return 'ended their support session';
    case 'org.staff_access':
      return meta.blocked
        ? 'required a support ticket before Kestrel staff can open a session here'
        : 'allowed Kestrel staff to open a support session without a ticket';
    case 'license.adjust':
      return `adjusted this organisation’s licence: ${s(meta.summary)}`;
    case 'license.revoke':
      return 'removed an adjustment to this organisation’s licence';
    case 'org.create':
      return `created the organisation “${s(meta.name)}”`;
    case 'org.rename':
      return `renamed the organisation to “${s(meta.name)}”`;
    case 'site.create':
      return `created site “${s(meta.name)}”`;
    case 'site.update':
      return `updated site “${s(meta.name)}”`;
    case 'site.delete':
      return `deleted site “${s(meta.name)}”`;
    case 'room.create':
      return `created room “${s(meta.name)}” in ${s(meta.site)}`;
    case 'room.duplicate':
      return `copied room “${s(meta.from)}” to a new room “${s(meta.name)}”`;
    case 'room.copy': {
      const rooms = Array.isArray(meta.rooms) ? meta.rooms.map((r) => `“${s(r)}”`) : [];
      return `made ${rooms.length} cop${rooms.length === 1 ? 'y' : 'ies'} of room “${s(meta.from)}”: ${rooms.join(', ')}`;
    }
    case 'room.shape_save':
      return `saved a room shape “${s(meta.name)}”`;
    case 'room.shape_delete':
      return `deleted the room shape “${s(meta.name)}”`;
    case 'device.shared':
      return `set a device to serve ${typeof meta.rooms === 'number' ? meta.rooms : 0} other room${meta.rooms === 1 ? '' : 's'}`;
    case 'room.staging_copy':
      return `made a staging copy of room “${s(meta.from)}” called “${s(meta.name)}”`;
    case 'room.staging_promote':
      return `promoted the design of staging room “${s(meta.staging)}” into “${s(meta.room)}”`;
    case 'room.update':
      return `updated room “${s(meta.name)}”${meta.site ? ` (now in ${s(meta.site)})` : ''}`;
    case 'room.delete':
      return `deleted room “${s(meta.name)}”`;
    case 'invite.create':
      return `invited ${s(meta.email)} as ${role(meta.role)}`;
    case 'invite.revoke':
      return 'revoked an invitation';
    case 'invite.accept':
      return `accepted the invitation (${s(meta.email)} joined as ${role(meta.role)})`;
    case 'member.role':
      return `changed ${s(meta.email)} from ${role(meta.from)} to ${role(meta.to)}`;
    case 'member.remove':
      return `removed ${s(meta.email)} from the organisation`;
    case 'member.leave':
      return 'left the organisation';
    case 'release.publish':
      return `published release ${s(meta.number)} of “${s(meta.room)}”`;
    case 'release.restore_design':
      return `put the design of “${s(meta.room)}” back to an earlier release`;
    case 'deployment.create':
      return meta.kind === 'rollback'
        ? `rolled “${s(meta.room)}” back to release ${s(meta.number)}`
        : `deployed release ${s(meta.number)} to “${s(meta.room)}”`;
    case 'deployment.bulk':
      return `${meta.mode === 'rollback' ? 'rolled back' : 'deployed'} ${s(meta.sent)} of ${s(meta.chosen)} chosen rooms (${s(meta.skipped)} already running or on their way, ${s(meta.blocked)} could not go)`;
    case 'deployment.schedule':
      return `scheduled release ${s(meta.number)} for “${s(meta.room)}”`;
    case 'deployment.cancel':
      return `cancelled the scheduled deployment of release ${s(meta.number)} to “${s(meta.room)}”`;
    case 'room.gateway':
      return meta.gateway
        ? `set “${s(meta.room)}” to run on gateway “${s(meta.gateway)}”`
        : `removed the gateway from “${s(meta.room)}”`;
    case 'gateway.create':
      return `added gateway “${s(meta.name)}”`;
    case 'gateway.enroll':
      return `gateway “${s(meta.name)}” connected`;
    case 'command.request':
      return `asked “${s(meta.room)}” to ${s(meta.type).replace('_', ' ')}`;
    case 'command.result':
      return `the gateway finished a ${s(meta.type).replace('_', ' ')} command (${meta.ok ? 'worked' : 'failed'})`;
    case 'driver.save':
      return meta.created
        ? 'created a custom driver'
        : `saved version ${s(meta.version)} of a custom driver`;
    case 'driver.delete':
      return `deleted the custom driver “${s(meta.name)}”`;
    case 'marketplace.publish':
      return meta.updated
        ? 'updated a marketplace listing'
        : 'published a template to the marketplace for review';
    case 'marketplace.withdraw':
      return 'withdrew a marketplace listing';
    case 'marketplace.get':
      return `added “${s(meta.name)}” from the marketplace`;
    case 'marketplace.checkout':
      return `started a purchase of “${s(meta.name)}”`;
    case 'calendar.connect':
      return `connected the ${s(meta.provider) === 'graph' ? 'Microsoft 365' : 'Google'} calendar “${s(meta.name)}”`;
    case 'org.delete.request':
      return 'asked Kestrel to delete the organisation';
    case 'callout.request':
      return `asked for a support callout: ${s(meta.title)}`;
    case 'callout.pay':
      return 'opened payment for a support callout quote';
    case 'callout.transfer':
      return 'moved a callout between Kestrel and a service provider';
    case 'callout.provider_schedule':
      return 'scheduled a visit for a callout';
    case 'callout.provider_complete':
      return 'completed a callout for the service provider';
    case 'callout.to_kestrel':
      return 'sent a callout to Kestrel instead of the service provider';
    case 'callout.cancel':
      return 'cancelled a support callout';
    case 'latency.limits':
      return 'changed the network health limits';
    case 'latency.reset':
      return 'reset the network health limits to the defaults';
    case 'calendar.update':
      return `updated the calendar profile “${s(meta.name)}”`;
    case 'calendar.remove':
      return `removed the ${s(meta.provider) === 'graph' ? 'Microsoft 365' : 'Google'} calendar profile “${s(meta.name)}”`;
    case 'calendar.room':
      return meta.connectionId ? 'chose a calendar for a room' : 'removed the calendar from a room';
    case 'trigger.fire':
      return `a trigger started “${s(meta.room)}”`;
    case 'combination.create':
      return `set up combined rooms “${s(meta.name)}”`;
    case 'combination.update':
      return `changed combined rooms “${s(meta.name)}”`;
    case 'combination.delete':
      return `removed combined rooms “${s(meta.name)}”`;
    case 'combination.set':
      return `${meta.combined ? 'joined' : 'split'} “${s(meta.name)}”`;
    case 'group.deploy':
      return `deployed a room group (${s(meta.deployed)} of ${s(meta.rooms)} rooms sent, ${s(meta.published)} new releases)`;
    case 'report.schedule':
      return meta.enabled
        ? `set the monthly report to be emailed to ${s(meta.recipients)} ${meta.recipients === 1 ? 'address' : 'addresses'}`
        : 'turned off the monthly report email';
    case 'org.retention':
      return `set how long the activity log is kept to ${s(meta.days)} days: “${s(meta.reason)}”`;
    case 'audit.export':
      return `downloaded the activity log (${s(meta.rows)} rows, ${s(meta.format)})`;
    case 'wall.set':
      return `${meta.open ? 'combined' : 'separated'} “${s(meta.room)}” with its neighbouring rooms from the portal`;
    case 'room.hook_secret':
      return `generated a new webhook secret for “${s(meta.room)}”`;
    case 'hook.fire':
      return `a webhook ran “${s(meta.hook)}” in “${s(meta.room)}”`;
    case 'org.branding':
      return 'changed the organisation’s panel theme';
    case 'control.intent':
      return `${meta.intent === 'activity.stop' ? 'stopped' : 'started'} an activity in “${s(meta.room)}” from the portal`;
    case 'billing.subscribe':
      return meta.changed
        ? `changed the plan to ${s(meta.plan)}`
        : `started checkout for the ${s(meta.plan)} plan`;
    case 'incident.acknowledge':
      return 'acknowledged an incident';
    case 'alert_channel.create':
      return `added alert channel “${s(meta.name)}” (${s(meta.type)})`;
    case 'alert_channel.update':
      return `changed alert channel “${s(meta.name)}”`;
    case 'commissioning.start':
      return `started a commissioning check of “${s(meta.room)}”`;
    case 'commissioning.signoff':
      return `signed off the commissioning check of “${s(meta.room)}” (${s(meta.pass)} passed, ${s(meta.fail)} failed, ${s(meta.skip)} skipped)`;
    case 'apikey.create':
      return `made an API key called “${s(meta.name)}” (${s(meta.prefix)})`;
    case 'apikey.revoke':
      return 'revoked an API key';
    case 'alert_channel.rules':
      return `changed the timing of the alert channel “${s(meta.name)}”: ${s(meta.rules)}`;
    case 'alert_channel.delete':
      return `removed alert channel “${s(meta.name)}”`;
    case 'ticket.create':
      return `opened support request “${s(meta.title)}”`;
    case 'ticket.update':
      return meta.status
        ? `marked a support request ${s(meta.status).replace('_', ' ')}`
        : 'updated a support request';
    case 'ticket.escalate':
      return `escalated support request “${s(meta.title)}” to Kestrel support`;
    case 'ticket.handback':
      return `handed support request “${s(meta.title)}” back to your team`;
    default:
      return action;
  }
}
