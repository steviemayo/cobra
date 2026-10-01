import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store, openStore } from './store';
import { silentLogger } from './log';

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('the gateway store', () => {
  it('keeps what it holds', () => {
    root = mkdtempSync(join(tmpdir(), 'kestrel-store-'));
    const store = new Store(join(root, 'data', 'gateway.db'));
    store.set('credential', 'secret');
    expect(store.get('credential')).toBe('secret');
    store.close();
  });

  // Windows has no file modes; the installer sets an ACL on the folder instead (windows/protect-data.ps1).
  it.skipIf(process.platform === 'win32')('is readable by its own account only', () => {
    root = mkdtempSync(join(tmpdir(), 'kestrel-store-'));
    const file = join(root, 'data', 'gateway.db');
    const store = new Store(file);
    store.set('credential', 'secret');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'data')).mode & 0o777).toBe(0o700);
    store.close();
  });
});

describe('openStore', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'kestrel-store-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('opens a good file and keeps what was in it', () => {
    const path = join(tmp(), 'gateway.db');
    const a = openStore(path, silentLogger);
    a.set('credential', 'abc');
    a.close();
    const b = openStore(path, silentLogger);
    expect(b.get('credential')).toBe('abc');
    b.close();
  });

  it('sets a damaged file aside and starts fresh instead of failing on every start', () => {
    const dir = tmp();
    const path = join(dir, 'gateway.db');
    writeFileSync(path, 'this is not a database, a power cut left this behind'.repeat(50));
    const logs: string[] = [];
    const store = openStore(path, (_l, m) => logs.push(m));
    expect(store.get('credential')).toBeNull();
    store.set('credential', 'new');
    expect(store.get('credential')).toBe('new');
    store.close();
    expect(readdirSync(dir).some((f) => f.startsWith('gateway.db.broken-'))).toBe(true);
    expect(logs.join(' ')).toContain('setting it aside');
  });
});
