import { router } from '../trpc';
import { orgRouter } from './org';
import { roomRouter } from './room';
import { siteRouter } from './site';

export const appRouter = router({ org: orgRouter, site: siteRouter, room: roomRouter });
export type AppRouter = typeof appRouter;
