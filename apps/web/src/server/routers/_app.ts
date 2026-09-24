import { router } from '../trpc';
import { alertRouter } from './alert';
import { auditRouter } from './audit';
import { commandRouter } from './command';
import { deploymentRouter } from './deployment';
import { draftRouter } from './draft';
import { gatewayRouter } from './gateway';
import { inviteRouter } from './invite';
import { memberRouter } from './member';
import { monitoringRouter } from './monitoring';
import { orgRouter } from './org';
import { releaseRouter } from './release';
import { roomRouter } from './room';
import { siteRouter } from './site';
import { templateRouter } from './template';
import { ticketRouter } from './ticket';

export const appRouter = router({
  org: orgRouter,
  site: siteRouter,
  room: roomRouter,
  draft: draftRouter,
  template: templateRouter,
  member: memberRouter,
  invite: inviteRouter,
  audit: auditRouter,
  gateway: gatewayRouter,
  release: releaseRouter,
  deployment: deploymentRouter,
  monitoring: monitoringRouter,
  alert: alertRouter,
  command: commandRouter,
  ticket: ticketRouter,
});
export type AppRouter = typeof appRouter;
