import type { CombinationConfig, CombinationReport } from '@kestrel/model';
import type { Logger } from './log';
import type { RoomHost } from './room-host';
import type { Store } from './store';

const KEY_COMBINATIONS = 'combinations';
const keyCombined = (id: string) => `combined:${id}`;

/**
 * Joins rooms into one. The primary's panel controls every room in a combination; the others
 * mirror it (video follows or blanks, audio follows or mutes) until the rooms are split, when they
 * go back to off. The gateway owns the live state: it survives restarts, and works with no cloud.
 *
 * A combination only works while its primary and every secondary run on this gateway.
 */
export class CombineCoordinator {
  private combos: CombinationConfig[];
  private readonly combined = new Set<string>();
  private readonly wires = new Map<string, () => void>();

  constructor(
    private readonly host: RoomHost,
    private readonly store: Store,
    private readonly log: Logger,
  ) {
    this.combos = store.getJson<CombinationConfig[]>(KEY_COMBINATIONS) ?? [];
    for (const c of this.combos) if (store.get(keyCombined(c.id)) === '1') this.combined.add(c.id);
    host.onCombineRequest((roomId, combined) => this.request(roomId, combined));
    host.onReload(() => this.apply());
  }

  /** The combinations the cloud says exist. Forgets state for ones that were deleted. */
  setConfig(combos: CombinationConfig[]) {
    this.combos = combos;
    this.store.setJson(KEY_COMBINATIONS, combos);
    const ids = new Set(combos.map((c) => c.id));
    for (const id of [...this.combined])
      if (!ids.has(id)) {
        this.combined.delete(id);
        this.store.delete(keyCombined(id));
      }
    this.apply();
  }

  report(): CombinationReport[] {
    return this.combos.map((c) => ({ id: c.id, combined: this.combined.has(c.id) }));
  }

  /** The primary's panel asked to join or split. */
  private request(roomId: string, combined: boolean) {
    const combo = this.combos.find((c) => c.primaryRoomId === roomId);
    if (combo) this.set(combo.id, combined);
  }

  set(id: string, combined: boolean) {
    const combo = this.combos.find((c) => c.id === id);
    if (!combo || this.combined.has(id) === combined) return;
    if (combined && !this.available(combo)) {
      this.log('warn', 'Cannot combine rooms that are not all running here', { combination: id });
      return;
    }
    if (combined) this.combined.add(id);
    else this.combined.delete(id);
    this.store.set(keyCombined(id), combined ? '1' : '0');
    this.log('info', combined ? 'Rooms combined' : 'Rooms split', { combination: combo.name });
    this.apply();
  }

  private available(c: CombinationConfig) {
    return [c.primaryRoomId, ...c.secondaryRoomIds].every((r) => this.host.get(r));
  }

  /** Bring every room in line with the combinations: what each panel shows, and who follows whom. */
  apply() {
    for (const off of this.wires.values()) off();
    this.wires.clear();
    const inCombo = new Set<string>();

    for (const c of this.combos) {
      if (!this.available(c)) continue;
      const primary = this.host.get(c.primaryRoomId)!;
      const secondaries = c.secondaryRoomIds.map((id) => this.host.get(id)!);
      const combined = this.combined.has(c.id);
      inCombo.add(c.primaryRoomId);
      for (const s of secondaries) inCombo.add(s.roomId);

      primary.runtime.setCombination({
        role: 'primary',
        combined,
        rooms: secondaries.map((s) => s.signed.manifest.roomName),
      });
      for (const s of secondaries) {
        s.runtime.setCombination({
          role: 'secondary',
          combined,
          rooms: [primary.signed.manifest.roomName],
        });
        s.runtime.setSecondary(
          combined ? { video: c.secondaryVideo, audio: c.secondaryAudio } : null,
        );
      }
      if (combined) {
        const follow = () =>
          secondaries.forEach((s) => s.runtime.follow(primary.runtime.getSnapshot()));
        this.wires.set(c.id, primary.runtime.subscribe(follow));
        follow();
      }
    }

    // A room that is no longer part of any combination goes back to being an ordinary room.
    for (const id of this.host.ids())
      if (!inCombo.has(id)) {
        const room = this.host.get(id)!;
        room.runtime.setCombination(null);
        room.runtime.setSecondary(null);
      }
  }
}
