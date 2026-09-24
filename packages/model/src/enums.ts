import { z } from 'zod';

export const OrgRole = z.enum(['owner', 'dev', 'support', 'customer_viewer']);
export type OrgRole = z.infer<typeof OrgRole>;

export const RoomType = z.enum(['meeting', 'training']);
export type RoomType = z.infer<typeof RoomType>;
