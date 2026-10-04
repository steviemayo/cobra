import { router } from '../trpc';
import { alertRouter } from './alert';
import { apikeyRouter } from './apikey';
import { auditRouter } from './audit';
import { billingRouter } from './billing';
import { bindingRouter } from './binding';
import { deviceRouter } from './device';
import { areaRouter } from './area';
import { roomUsageRouter } from './room-usage';
import { configRouter } from './config';
import { supportRouter } from './support';
import { registerRouter } from './register';
import { pmRouter } from './pm';
import { calendarRouter } from './calendar';
import { calloutRouter } from './callout';
import { mspRouter } from './msp';
import { staffRouter } from './staff';
import { draftRouter } from './draft';
import { discoveryRouter } from './discovery';
import { driverRouter } from './driver';
import { gatewayRouter } from './gateway';
import { inviteRouter } from './invite';
import { joinRequestRouter } from './join-request';
import { latencyRouter } from './latency';
import { memberRouter } from './member';
import { monitoringRouter } from './monitoring';
import { recapRouter } from './recap';
import { briefingRouter } from './briefing';
import { legalRouter } from './legal';
import { orgRouter } from './org';
import { reportRouter } from './report';
import { roomRouter } from './room';
import { siteRouter } from './site';
import { ticketRouter } from './ticket';
import { usageRouter } from './usage';

export const appRouter = router({
  legal: legalRouter,
  org: orgRouter,
  site: siteRouter,
  room: roomRouter,
  draft: draftRouter,
  member: memberRouter,
  invite: inviteRouter,
  joinRequest: joinRequestRouter,
  audit: auditRouter,
  gateway: gatewayRouter,
  discovery: discoveryRouter,
  monitoring: monitoringRouter,
  recap: recapRouter,
  briefing: briefingRouter,
  alert: alertRouter,
  ticket: ticketRouter,
  billing: billingRouter,
  driver: driverRouter,
  calendar: calendarRouter,
  callout: calloutRouter,
  latency: latencyRouter,
  msp: mspRouter,
  staff: staffRouter,
  binding: bindingRouter,
  device: deviceRouter,
  area: areaRouter,
  roomUsage: roomUsageRouter,
  config: configRouter,
  support: supportRouter,
  register: registerRouter,
  pm: pmRouter,
  apikey: apikeyRouter,
  usage: usageRouter,
  report: reportRouter,
});
export type AppRouter = typeof appRouter;
