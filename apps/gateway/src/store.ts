import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SignedManifest, TelemetryEvent } from '@kestrel/model';

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
