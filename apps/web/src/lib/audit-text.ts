import { ROLE_LABEL } from './format';

const s = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const role = (v: unknown) => ROLE_LABEL[s(v) as keyof typeof ROLE_LABEL] ?? s(v);

// Human wording for audit log rows: "<actor> <this text>".
export function describeAudit(action: string, meta: Record<string, unknown>): string {
  switch (action) {
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
    case 'deployment.create':
      return meta.kind === 'rollback'
        ? `rolled “${s(meta.room)}” back to release ${s(meta.number)}`
        : `deployed release ${s(meta.number)} to “${s(meta.room)}”`;
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
    case 'incident.acknowledge':
      return 'acknowledged an incident';
    case 'alert_channel.create':
      return `added alert channel “${s(meta.name)}” (${s(meta.type)})`;
    case 'alert_channel.update':
      return `changed alert channel “${s(meta.name)}”`;
    case 'alert_channel.delete':
      return `removed alert channel “${s(meta.name)}”`;
    case 'ticket.create':
      return `opened support request “${s(meta.title)}”`;
    case 'ticket.update':
      return 'updated a support request';
    default:
      return action;
  }
}
