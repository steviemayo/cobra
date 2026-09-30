import { router } from '../trpc';
import { alertRouter } from './alert';
import { apikeyRouter } from './apikey';
import { auditRouter } from './audit';
import { billingRouter } from './billing';
import { bindingRouter } from './binding';
import { bulkRouter } from './bulk';
import { siteDeviceRouter } from './site-device';
import { deviceRouter } from './device';
import { areaRouter } from './area';
import { roomUsageRouter } from './room-usage';
import { configRouter } from './config';
import { supportRouter } from './support';
import { calendarRouter } from './calendar';
import { mspRouter } from './msp';
import { roomGroupRouter } from './room-group';
import { staffRouter } from './staff';
import { commandRouter } from './command';
import { commissioningRouter } from './commissioning';
import { controlRouter } from './control';
import { deploymentRouter } from './deployment';
import { draftRouter } from './draft';
import { driverRouter } from './driver';
import { gatewayRouter } from './gateway';
import { inviteRouter } from './invite';
import { joinRequestRouter } from './join-request';
import { marketplaceRouter } from './marketplace';
import { memberRouter } from './member';
import { monitoringRouter } from './monitoring';
import { orgRouter } from './org';
import { releaseRouter } from './release';
import { reportRouter } from './report';
import { roomRouter } from './room';
import { siteRouter } from './site';
import { templateRouter } from './template';
import { ticketRouter } from './ticket';
import { usageRouter } from './usage';

export const appRouter = router({
  org: orgRouter,
  site: siteRouter,
  room: roomRouter,
  draft: draftRouter,
  template: templateRouter,
  member: memberRouter,
  invite: inviteRouter,
  joinRequest: joinRequestRouter,
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
  siteDevice: siteDeviceRouter,
  device: deviceRouter,
  area: areaRouter,
  roomUsage: roomUsageRouter,
  config: configRouter,
  support: supportRouter,
  commissioning: commissioningRouter,
  apikey: apikeyRouter,
  usage: usageRouter,
  report: reportRouter,
});
export type AppRouter = typeof appRouter;
