import { chmodSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SignedManifest, TelemetryEvent } from '@kestrel/model';
import type { Logger } from './log';

const MAX_UNSENT = 20_000;

/**
 * Everything the gateway must remember across restarts, in one SQLite file: its credential,
 * the verified manifests it is running (so rooms boot with no internet), and buffered telemetry.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    // The credential and the room's device logins live in here: private to the account running the gateway.
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      this.init(path);
    } catch (e) {
      // A constructor that throws leaves the file open, and an open file cannot be moved or deleted on
      // Windows: the damaged state would then have to be removed by hand.
      this.db.close();
      throw e;
    }
  }

  private init(path: string) {
    if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS manifests (
        room_id TEXT PRIMARY KEY,
        release_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        json TEXT NOT NULL,
        saved_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        room_id TEXT,
        data TEXT NOT NULL,
        sent INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS telemetry_unsent ON telemetry (sent, id);
    `);
  }

  /** Throws if the file is damaged or cannot be written. */
  selfCheck() {
    const row = this.db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    if (row && row.quick_check !== 'ok') throw new Error(`the state file is damaged (${row.quick_check})`);
    this.set('selfcheck', new Date().toISOString());
    this.delete('selfcheck');
  }

  close() {
    this.db.close();
  }

  // ---- key/value ------------------------------------------------------------------------------

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string) {
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  delete(key: string) {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  keysWithPrefix(prefix: string): string[] {
    const rows = this.db
      .prepare("SELECT key FROM kv WHERE substr(key, 1, ?) = ?")
      .all(prefix.length, prefix) as { key: string }[];
    return rows.map((r) => r.key);
  }

  getJson<T>(key: string): T | null {
    const v = this.get(key);
    return v === null ? null : (JSON.parse(v) as T);
  }

  setJson(key: string, value: unknown) {
    this.set(key, JSON.stringify(value));
  }

  // ---- manifests ------------------------------------------------------------------------------

  saveManifest(signed: SignedManifest) {
    this.db
      .prepare(
        `INSERT INTO manifests (room_id, release_id, hash, json, saved_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET release_id = excluded.release_id, hash = excluded.hash,
           json = excluded.json, saved_at = excluded.saved_at`,
      )
      .run(
        signed.manifest.roomId,
        signed.manifest.releaseId,
        signed.hash,
        JSON.stringify(signed),
        new Date().toISOString(),
      );
  }

  /** Raw stored manifests. Callers must verify them again before use. */
  loadManifests(): { roomId: string; releaseId: string; raw: unknown }[] {
    const rows = this.db.prepare('SELECT room_id, release_id, json FROM manifests').all() as {
      room_id: string;
      release_id: string;
      json: string;
    }[];
    return rows.map((r) => ({ roomId: r.room_id, releaseId: r.release_id, raw: JSON.parse(r.json) as unknown }));
  }

  deleteManifest(roomId: string) {
    this.db.prepare('DELETE FROM manifests WHERE room_id = ?').run(roomId);
  }

  // ---- telemetry buffer -----------------------------------------------------------------------

  enqueue(event: TelemetryEvent) {
    this.db
      .prepare('INSERT INTO telemetry (at, type, room_id, data) VALUES (?, ?, ?, ?)')
      .run(event.at, event.type, event.roomId ?? null, JSON.stringify(event.data));
    // Bound the buffer: if the cloud is unreachable for a long time, drop the oldest events.
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM telemetry WHERE sent = 0').get() as { n: number };
    if (n > MAX_UNSENT)
      this.db
        .prepare(
          'DELETE FROM telemetry WHERE id IN (SELECT id FROM telemetry WHERE sent = 0 ORDER BY id LIMIT ?)',
        )
        .run(n - MAX_UNSENT);
  }

  takeBatch(limit: number): { id: number; event: TelemetryEvent }[] {
    const rows = this.db
      .prepare('SELECT id, at, type, room_id, data FROM telemetry WHERE sent = 0 ORDER BY id LIMIT ?')
      .all(limit) as { id: number; at: string; type: TelemetryEvent['type']; room_id: string | null; data: string }[];
    return rows.map((r) => ({
      id: r.id,
      event: {
        at: r.at,
        type: r.type,
        ...(r.room_id ? { roomId: r.room_id } : {}),
        data: JSON.parse(r.data) as Record<string, unknown>,
      },
    }));
  }

  markSent(ids: number[]) {
    const stmt = this.db.prepare('UPDATE telemetry SET sent = 1 WHERE id = ?');
    for (const id of ids) stmt.run(id);
  }

  /** Forget events the cloud already has. */
  pruneSent() {
    this.db.prepare('DELETE FROM telemetry WHERE sent = 1').run();
  }

  clearTelemetry() {
    this.db.prepare('DELETE FROM telemetry').run();
  }

  unsentCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM telemetry WHERE sent = 0').get() as { n: number }).n;
  }
}

/**
 * Opens the gateway's store and proves it can be read and written before anything relies on it. A
 * file that is damaged (a power cut mid-write, a disk problem) or that this account cannot write
 * (left behind by an earlier install that ran as someone else) would otherwise crash the gateway on
 * every start, for ever. It is set aside as `gateway.db.broken-<time>` and a fresh one is made: the
 * gateway then enrols or announces again, which is what wiping the folder by hand would do, without
 * anyone having to. If even that cannot be done it runs from memory, so devices are still watched.
 */
export function openStore(path: string, log: Logger): Store {
  const attempt = (): Store => {
    const store = new Store(path);
    try {
      store.selfCheck();
    } catch (e) {
      try {
        store.close();
      } catch {
        // already unusable
      }
      throw e;
    }
    return store;
  };
  try {
    return attempt();
  } catch (first) {
    log('error', 'The gateway’s saved state could not be used; setting it aside and starting fresh', {
      file: path,
      error: first instanceof Error ? first.message : String(first),
    });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const suffix of ['', '-wal', '-shm']) {
    const file = path + suffix;
    if (!existsSync(file)) continue;
    try {
      renameSync(file, `${path}.broken-${stamp}${suffix}`);
    } catch (e) {
      log('warn', 'Could not move a damaged state file aside', { file, error: String(e) });
    }
  }
  try {
    return attempt();
  } catch (second) {
    log('error', 'Could not make a new state file either; running without saving anything', {
      file: path,
      error: second instanceof Error ? second.message : String(second),
      hint: 'Check that the account the gateway runs as can write to its data folder',
    });
    return new Store(':memory:');
  }
}
