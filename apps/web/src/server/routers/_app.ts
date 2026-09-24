import { router } from '../trpc';
import { auditRouter } from './audit';
import { draftRouter } from './draft';
import { inviteRouter } from './invite';
import { memberRouter } from './member';
import { orgRouter } from './org';
import { roomRouter } from './room';
import { siteRouter } from './site';
import { templateRouter } from './template';

export const appRouter = router({
  org: orgRouter,
  site: siteRouter,
  room: roomRouter,
  draft: draftRouter,
  template: templateRouter,
  member: memberRouter,
  invite: inviteRouter,
  audit: auditRouter,
});
export type AppRouter = typeof appRouter;
