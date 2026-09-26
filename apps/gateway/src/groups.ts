import { GroupController } from '@kestrel/engine';
import type { DividerReport, GroupConfig } from '@kestrel/model';
import type { Logger } from './log';
import type { RoomHost } from './room-host';
import type { Store } from './store';

const KEY_GROUPS = 'groups';
const KEY_OPEN = 'dividers:open';

/**
 * Runs the room groups on this gateway. The logic (which rooms run, suspending and starting them
 * when walls move) is the engine's `GroupController`, shared with the browser simulator; this class
 * connects it to the gateway: the rooms it hosts, panels that follow the active room, and a local
 * store so which walls are open survives restarts and needs no cloud.
 */
export class GroupCoordinator {
  private readonly controller: GroupController;

  constructor(
    host: RoomHost,
    private readonly store: Store,
    log: Logger,
  ) {
    this.controller = new GroupController(
      {
        runtime: (roomId) => host.get(roomId)?.runtime,
        roomName: (roomId) =>
          host.get(roomId)?.signed.manifest.roomName ?? 'A room that is not running',
        changed: () => host.notifyActiveChange(),
        log,
        saveOpen: (ids) => store.setJson(KEY_OPEN, ids),
      },
      store.getJson<GroupConfig[]>(KEY_GROUPS) ?? [],
      store.getJson<string[]>(KEY_OPEN) ?? [],
    );
    host.onDividerRequest((id, open) => void this.controller.set(id, open));
    host.onReload(() => this.controller.reconcile());
    host.setActiveResolver((roomId) => this.controller.activeRoomId(roomId));
  }

  /** The groups the cloud says exist. */
  setConfig(groups: GroupConfig[]) {
    this.store.setJson(KEY_GROUPS, groups);
    this.controller.setConfig(groups);
  }

  report(): DividerReport[] {
    return this.controller.report();
  }

  /** A person (or the portal) opened or closed a wall. */
  set(dividerId: string, open: boolean): Promise<boolean> {
    return this.controller.set(dividerId, open);
  }
}
