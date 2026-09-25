import { combinedKey, liveCombinations, type ParkedState, type RoomRuntime } from '@kestrel/engine';
import type {
  DividerReport,
  GroupConfig,
  PanelLinking,
  RoomGroupSpec,
  TransitionAction,
} from '@kestrel/model';
import type { Logger } from './log';
import type { RoomHost } from './room-host';
import type { Store } from './store';

const KEY_GROUPS = 'groups';
const KEY_OPEN = 'dividers:open';

/** Which rooms are really running the devices for one arrangement of open walls. */
interface Plan {
  /** Room id (ordinary or combined) -> the ordinary rooms it stands for right now. */
  active: Map<string, string[]>;
  /** Joined sets that have no combined room running here, so they cannot go live. */
  missing: string[];
}

/**
 * Owns the movable walls of every room group on this gateway. The state (which walls are open)
 * survives restarts and needs no cloud. When walls make a set of rooms into one space, that space's
 * combined room runs and the rooms it stands for are suspended, so two programs never drive the
 * same devices; closing a wall reverses it. What the new space does as it starts is the wall's
 * open or close setting from the portal.
 */
export class GroupCoordinator {
  private groups: GroupConfig[];
  private open: Set<string>;
  /** What each room was doing when it was last suspended, for the "restore" setting. */
  private readonly parked = new Map<string, ParkedState>();

  constructor(
    private readonly host: RoomHost,
    private readonly store: Store,
    private readonly log: Logger,
  ) {
    this.groups = store.getJson<GroupConfig[]>(KEY_GROUPS) ?? [];
    this.open = new Set(store.getJson<string[]>(KEY_OPEN) ?? []);
    host.onDividerRequest((id, open) => void this.set(id, open));
    host.onReload(() => this.reconcile());
    host.setActiveResolver((roomId) => this.activeRoomId(roomId));
  }

  /** The groups the cloud says exist. Rooms of a group that is gone go back to running on their own. */
  setConfig(groups: GroupConfig[]) {
    const before = new Set(this.groups.flatMap((g) => this.roomsOf(g)));
    this.groups = groups;
    this.store.setJson(KEY_GROUPS, groups);
    const dividers = new Set(groups.flatMap((g) => g.dividers.map((d) => d.id)));
    for (const id of [...this.open]) if (!dividers.has(id)) this.open.delete(id);
    this.store.setJson(KEY_OPEN, [...this.open]);
    const still = new Set(groups.flatMap((g) => this.roomsOf(g)));
    for (const id of before) if (!still.has(id)) this.host.get(id)?.runtime.resume();
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
      this.log('warn', 'Cannot open a wall: the combined room is not running here', {
        divider: divider.name,
        rooms: after.missing,
      });
      return false;
    }

    // Read what was on before anything is stopped.
    const wasOn = (roomId: string) => {
      for (const [id, covers] of before.active)
        if (covers.includes(roomId)) {
          const status = this.host.get(id)?.runtime.getSnapshot().status;
          return status === 'on' || status === 'starting';
        }
      return false;
    };
    const starting = [...after.active]
      .filter(([id]) => !before.active.has(id))
      .map(([id, covers]) => ({ id, fromOn: covers.some(wasOn) }));

    this.open = next;
    this.store.setJson(KEY_OPEN, [...this.open]);
    this.log('info', open ? 'Wall opened' : 'Wall closed', { divider: divider.name });

    // Stop the old spaces first, so no device is ever driven by two rooms at once.
    for (const id of before.active.keys())
      if (!after.active.has(id)) {
        const room = this.host.get(id);
        if (room) this.parked.set(id, room.runtime.suspend());
      }
    for (const { id, fromOn } of starting) {
      const runtime = this.host.get(id)?.runtime;
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
        this.log('error', 'A room could not start after a wall moved', {
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
        const runtime = this.host.get(id)?.runtime;
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
      if (combined && this.host.get(combined.roomId)) {
        active.set(combined.roomId, set.roomIds);
        for (const r of set.roomIds) covered.add(r);
      } else missing.push(set.key);
    }
    for (const id of g.roomIds) if (!covered.has(id)) active.set(id, [id]);
    return { active, missing };
  }

  private roomName(id: string): string {
    return this.host.get(id)?.signed.manifest.roomName ?? 'A room that is not running';
  }

  /** Tell every room's panel which walls it can move, then tell panels which room to follow. */
  private publish() {
    for (const g of this.groups) {
      const { active } = this.plan(g, this.open);
      for (const id of this.roomsOf(g)) {
        const runtime = this.host.get(id)?.runtime;
        if (!runtime) continue;
        const combined = g.combined.find((c) => c.roomId === id);
        const space = combined ? combined.memberRoomIds : (active.get(id) ?? [id]);
        const inSpace = new Set(space);
        const linking: PanelLinking = {
          space: space.map((r) => this.roomName(r)),
          dividers: g.dividers
            .filter((d) => d.roomIds.some((r) => inSpace.has(r)))
            .map((d) => {
              const isOpen = this.open.has(d.id);
              return {
                id: d.id,
                name: d.name,
                open: isOpen,
                rooms: d.roomIds.map((r) => this.roomName(r)),
                available:
                  isOpen || this.plan(g, new Set(this.open).add(d.id)).missing.length === 0,
              };
            }),
        };
        runtime.setLinking(linking);
      }
    }
    this.host.notifyActiveChange();
  }
}
