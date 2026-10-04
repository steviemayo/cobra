import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { CONFIG_FIELDS, ConfigParams, type ConfigState } from '@kestrel/model';
import { writeAudit } from '../audit';
import {
  baselineDrift,
  compareSnapshots,
  continueDeploy,
  createProfile,
  deleteProfile,
  deviceConfigView,
  planProfileDeploy,
  rollbackDeploy,
  setBaseline,
  setDeviceConfig,
  startDeploy,
  takeSnapshot,
  updateProfile,
} from '../config-service';
import { featureProcedure, orgProcedure, requireRole, router } from '../trpc';

// Configuration is a Premium feature (and part of a running trial).
const pro = featureProcedure('configuration');

const orgId = z.string().uuid();
const id = z.string().uuid();
const ROLES = ['owner', 'dev', 'support'] as const;

function fail(message: string): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}

// Configuration: profiles, drift, snapshots and staged deploys (docs/pivot-monitoring.md).
export const configRouter = router({
  /** What can be held to a value, for pickers. */
  fields: orgProcedure.input(z.object({ orgId })).query(() =>
    Object.entries(CONFIG_FIELDS).map(([field, f]) => ({
      field,
      label: f.label,
      type: f.type,
      options: f.options ?? null,
      min: f.min ?? null,
      max: f.max ?? null,
    })),
  ),

  profiles: pro.input(z.object({ orgId })).query(async ({ ctx }) => {
    const [profiles, devices] = await Promise.all([
      db.configProfile.findMany({ where: { orgId: ctx.orgId }, orderBy: { name: 'asc' } }),
      db.device.findMany({ where: { orgId: ctx.orgId, profileId: { not: null } } }),
    ]);
    return profiles.map((p) => {
      const held = devices.filter((d) => d.profileId === p.id);
      const drifted = held.filter((d) =>
        Object.values((d.configState ?? {}) as unknown as ConfigState).some((s) => s?.drifted),
      ).length;
      return {
        ...p,
        params: ConfigParams.catch([]).parse(p.params),
        devices: held.length,
        drifted,
      };
    });
  }),

  createProfile: pro
    .input(
      z.object({
        orgId,
        name: z.string().trim().min(1).max(80),
        description: z.string().trim().max(500).nullable().optional(),
        category: z.string().max(40).nullable().optional(),
        params: z.unknown(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...ROLES]);
      const res = await createProfile(db, { ...input, orgId: ctx.orgId, userId: ctx.user.id });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'config.profile_create',
        target: res.value.id,
        meta: { name: input.name },
      });
      return res.value;
    }),

  updateProfile: pro
    .input(
      z.object({
        orgId,
        profileId: id,
        name: z.string().trim().min(1).max(80).optional(),
        description: z.string().trim().max(500).nullable().optional(),
        category: z.string().max(40).nullable().optional(),
        params: z.unknown().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...ROLES]);
      const res = await updateProfile(db, { ...input, orgId: ctx.orgId });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'config.profile_update',
        target: input.profileId,
      });
      return res.value;
    }),

  deleteProfile: pro.input(z.object({ orgId, profileId: id })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const res = await deleteProfile(db, ctx.orgId, input.profileId);
    if (!res.ok) return fail(res.message);
    await writeAudit({
      orgId: ctx.orgId,
      actorId: ctx.user.id,
      action: 'config.profile_delete',
      target: input.profileId,
    });
    return res.value;
  }),

  /** One device: its profile, its own settings, what applies to it, and what it could be held to. */
  device: pro.input(z.object({ orgId, deviceId: id })).query(async ({ ctx, input }) => {
    const v = await deviceConfigView(db, ctx.orgId, input.deviceId);
    if (!v) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such device' });
    return { ...v, baseline: await baselineDrift(db, ctx.orgId, input.deviceId) };
  }),

  setDevice: pro
    .input(
      z.object({
        orgId,
        deviceId: id,
        profileId: id.nullable().optional(),
        params: z.unknown().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...ROLES]);
      const res = await setDeviceConfig(db, { ...input, orgId: ctx.orgId, actorId: ctx.user.id });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'config.device_set',
        target: input.deviceId,
      });
      return res.value;
    }),

  /** Every monitored device with what it is held to and whether it has drifted. */
  overview: pro.input(z.object({ orgId })).query(async ({ ctx }) => {
    const [devices, profiles, baselines, rooms] = await Promise.all([
      db.device.findMany({ where: { orgId: ctx.orgId, kind: 'active' }, orderBy: { name: 'asc' } }),
      db.configProfile.findMany({ where: { orgId: ctx.orgId } }),
      db.deviceSnapshot.findMany({ where: { orgId: ctx.orgId, isBaseline: true } }),
      db.room.findMany({ where: { orgId: ctx.orgId } }),
    ]);
    return devices.map((d) => {
      const state = (d.configState ?? {}) as unknown as ConfigState;
      const drift = Object.entries(state).filter(([f, s]) => f !== '__push' && s?.drifted);
      return {
        id: d.id,
        name: d.name,
        roomName: rooms.find((r) => r.id === d.roomId)?.name ?? null,
        profileName: profiles.find((p) => p.id === d.profileId)?.name ?? null,
        held: !!d.profileId || (Array.isArray(d.configParams) && d.configParams.length > 0),
        drift: drift.map(([field, s]) => ({
          field,
          label: CONFIG_FIELDS[field]?.label ?? field,
          desired: s.desired,
          actual: s.actual,
          since: s.since,
          attempts: s.attempts,
        })),
        baselineAt: baselines.find((b) => b.deviceId === d.id)?.takenAt ?? null,
      };
    });
  }),

  snapshots: pro.input(z.object({ orgId, deviceId: id })).query(({ ctx, input }) =>
    db.deviceSnapshot.findMany({
      where: { orgId: ctx.orgId, deviceId: input.deviceId },
      orderBy: { takenAt: 'desc' },
      take: 50,
      select: {
        id: true,
        reason: true,
        isBaseline: true,
        note: true,
        takenAt: true,
        takenBy: true,
      },
    }),
  ),

  takeSnapshot: pro
    .input(
      z.object({
        orgId,
        deviceId: id,
        note: z.string().max(200).nullable().optional(),
        baseline: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...ROLES]);
      const res = await takeSnapshot(db, {
        orgId: ctx.orgId,
        deviceId: input.deviceId,
        reason: 'manual',
        note: input.note,
        userId: ctx.user.id,
        baseline: input.baseline,
      });
      if (!res.ok) return fail(res.message);
      return res.value;
    }),

  setBaseline: pro.input(z.object({ orgId, snapshotId: id })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, [...ROLES]);
    const res = await setBaseline(db, ctx.orgId, input.snapshotId);
    if (!res.ok) return fail(res.message);
    return res.value;
  }),

  /** What differs between two snapshots, or a snapshot and the device as it is now (live). */
  compare: pro
    .input(z.object({ orgId, deviceId: id, from: z.string().max(40), to: z.string().max(40) }))
    .query(async ({ ctx, input }) => {
      const r = await compareSnapshots(db, { ...input, orgId: ctx.orgId });
      if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: 'Snapshot not found' });
      return r;
    }),

  deployPlan: pro
    .input(z.object({ orgId, profileId: id, deviceIds: z.array(id).min(1).max(200) }))
    .query(async ({ ctx, input }) => {
      const r = await planProfileDeploy(db, { ...input, orgId: ctx.orgId });
      if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such profile' });
      return r;
    }),

  deploy: pro
    .input(
      z.object({
        orgId,
        profileId: id,
        deviceIds: z.array(id).min(1).max(200),
        canaryCount: z.number().int().min(0).max(20).default(0),
        note: z.string().max(200).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...ROLES]);
      const res = await startDeploy(db, { ...input, orgId: ctx.orgId, userId: ctx.user.id });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'config.deploy',
        target: res.value.id,
        meta: { profileId: input.profileId, devices: input.deviceIds.length },
      });
      return res.value;
    }),

  continueDeploy: pro.input(z.object({ orgId, deployId: id })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, [...ROLES]);
    const res = await continueDeploy(db, ctx.orgId, input.deployId, ctx.user.id);
    if (!res.ok) return fail(res.message);
    await writeAudit({
      orgId: ctx.orgId,
      actorId: ctx.user.id,
      action: 'config.deploy_continue',
      target: input.deployId,
    });
    return res.value;
  }),

  rollbackDeploy: pro.input(z.object({ orgId, deployId: id })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, [...ROLES]);
    const res = await rollbackDeploy(db, ctx.orgId, input.deployId, ctx.user.id);
    if (!res.ok) return fail(res.message);
    await writeAudit({
      orgId: ctx.orgId,
      actorId: ctx.user.id,
      action: 'config.deploy_rollback',
      target: input.deployId,
    });
    return res.value;
  }),

  deploys: pro.input(z.object({ orgId })).query(({ ctx }) =>
    db.configDeploy.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ),

  /** Settings changes across the estate (drift, corrections, pushes, rollbacks), newest first. */
  changes: pro
    .input(z.object({ orgId, limit: z.number().int().min(1).max(200).default(100) }))
    .query(async ({ ctx, input }) => {
      const types = [
        'config_drift',
        'config_corrected',
        'config_restored',
        'config_pushed',
        'config_rolled_back',
        'config_changed',
        'profile_assigned',
        'snapshot_taken',
      ];
      const [events, devices] = await Promise.all([
        db.deviceEvent.findMany({
          where: { orgId: ctx.orgId, type: { in: types } },
          orderBy: { at: 'desc' },
          take: input.limit,
        }),
        db.device.findMany({ where: { orgId: ctx.orgId }, select: { id: true, name: true } }),
      ]);
      return events.map((e) => ({
        ...e,
        deviceName: devices.find((d) => d.id === e.deviceId)?.name ?? 'A device',
      }));
    }),
});
