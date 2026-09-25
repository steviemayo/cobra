import type {
  DividerReport,
  GroupConfig,
  PanelLinking,
  RoomGroupSpec,
  TransitionAction,
} from '@kestrel/model';
import type { ParkedState, RoomRuntime } from '../runtime/runtime';
import { combinedKey, liveCombinations } from './combinations';

/** What the controller needs from wherever the rooms actually run (a gateway, or the browser simulator). */
export interface GroupControllerHost {
  /** The runtime of a room, if that room is running here. */
  runtime(roomId: string): RoomRuntime | undefined;
  roomName(roomId: string): string;
  /** Which room runs a panel's room may have changed, so panels can follow it. */
  changed(): void;
  log(level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void;
  /** The set of open walls changed and should be remembered. */
  saveOpen?(openDividerIds: string[]): void;
}

/** Which rooms are really running the devices for one arrangement of open walls. */
interface Plan {
  /** Room id (ordinary or combined) -> the ordinary rooms it stands for right now. */
  active: Map<string, string[]>;
  /** Joined sets that have no combined room running here, so they cannot go live. */
  missing: string[];
}

/**
 * Owns the movable walls of every room group. When walls make a set of rooms into one space, that
 * space's combined room runs and the rooms it stands for are suspended, so two programs never drive
 * the same devices; closing a wall reverses it. What the new space does as it starts is the wall's
 * open or close setting from the portal (off, on, follow, restore).
 *
 * It has no IO of its own, so the same code runs on the gateway (where the open walls are saved and
 * survive restarts) and in the browser simulator.
 */
export class GroupController {
  private groups: GroupConfig[];
  private open: Set<string>;
  /** What each room was doing when it was last suspended, for the "restore" setting. */
  private readonly parked = new Map<string, ParkedState>();

  constructor(
    private readonly host: GroupControllerHost,
    groups: GroupConfig[] = [],
    open: string[] = [],
  ) {
    this.groups = groups;
    this.open = new Set(open);
  }

  /** The groups that exist. Rooms of a group that is gone go back to running on their own. */
  setConfig(groups: GroupConfig[]) {
    const before = new Set(this.groups.flatMap((g) => this.roomsOf(g)));
    this.groups = groups;
    const dividers = new Set(groups.flatMap((g) => g.dividers.map((d) => d.id)));
    for (const id of [...this.open]) if (!dividers.has(id)) this.open.delete(id);
    this.host.saveOpen?.([...this.open]);
    const still = new Set(groups.flatMap((g) => this.roomsOf(g)));
    for (const id of before) if (!still.has(id)) this.host.runtime(id)?.resume();
    this.reconcile();
  }

  report(): DividerReport[] {
    return this.groups.flatMap((g) =>
      g.dividers.map((d) => ({ id: d.id, open: this.open.has(d.id) })),
    );
  }

  /** The room whose runtime a panel for `roomId` should show and control. */
  activeRoomId(roomId: string): string {
    for (const g of this.groups) {
      if (!g.roomIds.includes(roomId)) continue;
      for (const [id, covers] of this.plan(g, this.open).active)
        if (covers.includes(roomId)) return id;
    }
    return roomId;
  }

  /**
   * A person (or the portal) opened or closed a wall. Returns false if it could not be done.
   * Opening is refused while the combined room it would create is not running here.
   */
  async set(dividerId: string, open: boolean): Promise<boolean> {
    const group = this.groups.find((g) => g.dividers.some((d) => d.id === dividerId));
    const divider = group?.dividers.find((d) => d.id === dividerId);
    if (!group || !divider) return false;
    if (this.open.has(dividerId) === open) return true;

    const next = new Set(this.open);
    if (open) next.add(dividerId);
    else next.delete(dividerId);
    const before = this.plan(group, this.open);
    const after = this.plan(group, next);
    if (open && after.missing.length > 0) {
      this.host.log('warn', 'Cannot open a wall: the combined room is not running here', {
        divider: divider.name,
        rooms: after.missing,
      });
      return false;
    }

    // Read what was on before anything is stopped.
    const wasOn = (roomId: string) => {
      for (const [id, covers] of before.active)
        if (covers.includes(roomId)) {
          const status = this.host.runtime(id)?.getSnapshot().status;
          return status === 'on' || status === 'starting';
        }
      return false;
    };
    const starting = [...after.active]
      .filter(([id]) => !before.active.has(id))
      .map(([id, covers]) => ({ id, fromOn: covers.some(wasOn) }));

    this.open = next;
    this.host.saveOpen?.([...this.open]);
    this.host.log('info', open ? 'Wall opened' : 'Wall closed', { divider: divider.name });

    // Stop the old spaces first, so no device is ever driven by two rooms at once.
    for (const id of before.active.keys())
      if (!after.active.has(id)) {
        const runtime = this.host.runtime(id);
        if (runtime) this.parked.set(id, runtime.suspend());
      }
    for (const { id, fromOn } of starting) {
      const runtime = this.host.runtime(id);
      if (!runtime) continue;
      runtime.resume();
      this.begin(runtime, open ? divider.onOpen : divider.onClose, fromOn, this.parked.get(id), id);
    }
    this.publish();
    return true;
  }

  private begin(
    runtime: RoomRuntime,
    action: TransitionAction,
    fromOn: boolean,
    parked: ParkedState | undefined,
    roomId: string,
  ) {
    const run = (p: Promise<void>) =>
      void p.catch((e: unknown) =>
        this.host.log('error', 'A room could not start after a wall moved', {
          roomId,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    switch (action) {
      case 'off':
        return run(runtime.turnOff());
      case 'on':
        return run(runtime.turnOn());
      case 'follow':
        return fromOn ? run(runtime.turnOn()) : undefined;
      case 'restore':
        return run(runtime.restore(parked));
    }
  }

  /**
   * Bring every room in line with the open walls without starting or stopping anything: after a
   * restart, when a room's release is replaced, or when the config changes.
   */
  reconcile() {
    for (const g of this.groups) {
      const { active } = this.plan(g, this.open);
      for (const id of this.roomsOf(g)) {
        const runtime = this.host.runtime(id);
        if (!runtime) continue;
        if (active.has(id)) runtime.resume();
        else if (!runtime.isSuspended) this.parked.set(id, runtime.suspend());
      }
    }
    this.publish();
  }

  // ---- Internals ------------------------------------------------------------------------------

  private roomsOf(g: GroupConfig): string[] {
    return [...g.roomIds, ...g.combined.map((c) => c.roomId)];
  }

  private spec(g: GroupConfig): RoomGroupSpec {
    return {
      roomIds: g.roomIds,
      dividers: g.dividers.map((d) => ({ id: d.id, name: d.name, roomIds: d.roomIds })),
    };
  }

  private plan(g: GroupConfig, open: ReadonlySet<string>): Plan {
    const active = new Map<string, string[]>();
    const missing: string[] = [];
    const covered = new Set<string>();
    for (const set of liveCombinations(this.spec(g), [...open])) {
      const combined = g.combined.find((c) => combinedKey(c.memberRoomIds) === set.key);
      if (combined && this.host.runtime(combined.roomId)) {
        active.set(combined.roomId, set.roomIds);
        for (const r of set.roomIds) covered.add(r);
      } else missing.push(set.key);
    }
    for (const id of g.roomIds) if (!covered.has(id)) active.set(id, [id]);
    return { active, missing };
  }

  /** Tell every room's panel which rooms it can link with, then tell panels which room to follow. */
  private publish() {
    for (const g of this.groups) {
      const { active } = this.plan(g, this.open);
      for (const id of this.roomsOf(g)) {
        const runtime = this.host.runtime(id);
        if (!runtime) continue;
        const combined = g.combined.find((c) => c.roomId === id);
        const space = combined ? combined.memberRoomIds : (active.get(id) ?? [id]);
        const inSpace = new Set(space);
        const linking: PanelLinking = {
          space: space.map((r) => this.host.roomName(r)),
          dividers: g.dividers
            .filter((d) => d.roomIds.some((r) => inSpace.has(r)))
            .map((d) => {
              const isOpen = this.open.has(d.id);
              return {
                id: d.id,
                name: d.name,
                open: isOpen,
                rooms: d.roomIds.map((r) => this.host.roomName(r)),
                adds: d.roomIds.filter((r) => !inSpace.has(r)).map((r) => this.host.roomName(r)),
                available:
                  isOpen || this.plan(g, new Set(this.open).add(d.id)).missing.length === 0,
              };
            }),
        };
        runtime.setLinking(linking);
      }
    }
    this.host.changed();
  }
}
