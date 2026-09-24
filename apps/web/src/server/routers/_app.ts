import { router } from '../trpc';
import { draftRouter } from './draft';
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
});
export type AppRouter = typeof appRouter;
