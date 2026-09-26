import { router } from '../trpc';
import { alertRouter } from './alert';
import { auditRouter } from './audit';
import { billingRouter } from './billing';
import { bindingRouter } from './binding';
import { bulkRouter } from './bulk';
import { calendarRouter } from './calendar';
import { mspRouter } from './msp';
import { roomGroupRouter } from './room-group';
import { staffRouter } from './staff';
import { commandRouter } from './command';
import { controlRouter } from './control';
import { deploymentRouter } from './deployment';
import { draftRouter } from './draft';
import { driverRouter } from './driver';
import { gatewayRouter } from './gateway';
import { inviteRouter } from './invite';
import { marketplaceRouter } from './marketplace';
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
  billing: billingRouter,
  driver: driverRouter,
  marketplace: marketplaceRouter,
  calendar: calendarRouter,
  msp: mspRouter,
  roomGroup: roomGroupRouter,
  staff: staffRouter,
  control: controlRouter,
  binding: bindingRouter,
  bulk: bulkRouter,
});
export type AppRouter = typeof appRouter;
