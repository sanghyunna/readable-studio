import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  getProject,
  insertProject,
  openDatabase,
  openHostedDatabaseAtPath,
} from '../src/db.js';
import {
  createHostedRuntimeStorage,
  type HostedStorageIdentity,
} from '../src/hosted-runtime-storage.js';

const tempRoots: string[] = [];

afterEach(() => {
  closeDatabase();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'readable-hosted-storage-'));
  tempRoots.push(root);
  return root;
}

const USER_A_STORAGE_KEY =
  'od1_fc95297aa4f56781f0decb7d4bf59b1447f09b3611039b80188b1c6beb03ee6a';
const USER_B_STORAGE_KEY =
  'od1_eb1c58aa404f0ada5e83d6c2bc60990da8e2e16b09a28c5a7fcb39e3231eabb9';

function filesBelow(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? filesBelow(file) : [file];
  });
}

describe('hosted runtime storage', () => {
  it('keeps exact-path database handles independent', () => {
    const root = tempRoot();
    const aDir = path.join(root, 'a');
    const bDir = path.join(root, 'b');
    mkdirSync(aDir);
    mkdirSync(bDir);
    const a = openHostedDatabaseAtPath(path.join(aDir, 'app.sqlite'));
    const b = openHostedDatabaseAtPath(path.join(bDir, 'app.sqlite'));

    try {
      const now = Date.now();
      insertProject(a, { id: 'same-project', name: 'A', createdAt: now, updatedAt: now });
      insertProject(b, { id: 'same-project', name: 'B', createdAt: now, updatedAt: now });

      expect(getProject(a, 'same-project')?.name).toBe('A');
      expect(getProject(b, 'same-project')?.name).toBe('B');
      expect(a.pragma('busy_timeout', { simple: true })).toBe(30_000);
      b.close();
      expect(getProject(a, 'same-project')?.name).toBe('A');
    } finally {
      if (a.open) a.close();
      if (b.open) b.close();
    }
  });

  it('does not consult or replace the local database singleton', () => {
    const root = tempRoot();
    const localDir = path.join(root, 'local');
    const hostedDir = path.join(root, 'hosted');
    mkdirSync(localDir);
    mkdirSync(hostedDir);
    const local = openDatabase(root, { dataDir: localDir });
    const hosted = openHostedDatabaseAtPath(path.join(hostedDir, 'app.sqlite'));

    try {
      const now = Date.now();
      insertProject(local, { id: 'local-project', name: 'local', createdAt: now, updatedAt: now });
      insertProject(hosted, { id: 'hosted-project', name: 'hosted', createdAt: now, updatedAt: now });
      expect(getProject(local, 'local-project')?.name).toBe('local');
      closeDatabase();
      expect(getProject(hosted, 'hosted-project')?.name).toBe('hosted');
    } finally {
      if (hosted.open) hosted.close();
    }
  });

  it('closes its local handle when migration fails', () => {
    const root = tempRoot();
    const file = path.join(root, 'app.sqlite');
    const incompatible = new Database(file);
    incompatible.exec('CREATE VIEW projects AS SELECT 1 AS id');
    incompatible.close();

    expect(() => openHostedDatabaseAtPath(file)).toThrow();
    expect(() => {
      rmSync(file);
      const reopened = new Database(file);
      reopened.close();
    }).not.toThrow();
  });

  it('creates one fresh owned generation with the fixed runtime roots', () => {
    const runtimeRoot = path.join(tempRoot(), 'nested', 'hosted');
    const storageKey = USER_A_STORAGE_KEY;
    const storage = createHostedRuntimeStorage({
      identity: { storageKey, userKey: 'user-a' },
      runtimeRoot,
    });

    try {
      expect(path.dirname(storage.roots.liveRoot)).toBe(
        path.join(runtimeRoot, 'live', storageKey),
      );
      expect(path.basename(storage.roots.liveRoot)).toMatch(/^generation-/u);
      expect(storage.roots.databaseFile).toBe(path.join(storage.roots.liveRoot, 'app.sqlite'));
      for (const dir of [
        storage.roots.projectsRoot,
        storage.roots.artifactsRoot,
        storage.roots.uploadsRoot,
        storage.roots.checkpointsRoot,
        storage.roots.sessionsRoot,
        storage.roots.runsRoot,
        storage.roots.brokerRoot,
      ]) {
        expect(statSync(dir).isDirectory()).toBe(true);
      }
      expect(JSON.parse(readFileSync(
        path.join(storage.roots.liveRoot, '.identity.json'),
        'utf8',
      ))).toEqual({ derivationVersion: 1, userKey: 'user-a', storageKey });
    } finally {
      storage.close();
    }

    expect(existsSync(storage.roots.liveRoot)).toBe(false);
    expect(existsSync(path.join(runtimeRoot, 'live', storageKey, '.identity.json'))).toBe(true);
  });

  it('rejects an identity-marker collision before creating another generation', () => {
    const runtimeRoot = tempRoot();
    const first = createHostedRuntimeStorage({
      identity: { storageKey: USER_A_STORAGE_KEY, userKey: 'user-a' },
      runtimeRoot,
    });
    first.close();
    const storageRoot = path.join(runtimeRoot, 'live', USER_A_STORAGE_KEY);

    expect(() => createHostedRuntimeStorage({
      identity: { storageKey: USER_A_STORAGE_KEY, userKey: 'user-b' },
      runtimeRoot,
    })).toThrow('hosted runtime identity marker does not match');
    expect(readdirSync(storageRoot)).toEqual(['.identity.json']);
  });

  it('rejects a symlink or Windows junction in the derived root path', () => {
    const runtimeRoot = tempRoot();
    const outside = path.join(runtimeRoot, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, path.join(runtimeRoot, 'live'), process.platform === 'win32' ? 'junction' : 'dir');

    expect(() => createHostedRuntimeStorage({
      identity: { storageKey: USER_A_STORAGE_KEY, userKey: 'user-a' },
      runtimeRoot,
    })).toThrow(/real directory|link or reparse point/u);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('cleans only the failed generation and leaves another user database open', () => {
    const runtimeRoot = tempRoot();
    const a = createHostedRuntimeStorage({
      identity: { storageKey: USER_A_STORAGE_KEY, userKey: 'user-a' },
      runtimeRoot,
    });
    const now = Date.now();
    insertProject(a.database, { id: 'same-project', name: 'A', createdAt: now, updatedAt: now });
    let failedGeneration = '';

    try {
      expect(() => createHostedRuntimeStorage({
        databaseOpener(file) {
          failedGeneration = path.dirname(file);
          const database = openHostedDatabaseAtPath(file);
          database.close();
          throw new Error('simulated migration failure');
        },
        identity: { storageKey: USER_B_STORAGE_KEY, userKey: 'user-b' },
        runtimeRoot,
      })).toThrow('simulated migration failure');
      expect(existsSync(failedGeneration)).toBe(false);
      expect(getProject(a.database, 'same-project')?.name).toBe('A');
      expect(existsSync(path.join(runtimeRoot, 'live', USER_B_STORAGE_KEY, '.identity.json'))).toBe(true);
    } finally {
      a.close();
    }
  });

  it('persists only the closed identity marker shape, not credential-like input', () => {
    const runtimeRoot = tempRoot();
    const sentinel = 'hosted-provider-secret-sentinel';
    const identity: HostedStorageIdentity & { credential: string } = {
      credential: sentinel,
      storageKey: USER_A_STORAGE_KEY,
      userKey: 'user-a',
    };
    const storage = createHostedRuntimeStorage({ identity, runtimeRoot });

    try {
      for (const file of filesBelow(storage.roots.liveRoot)) {
        expect(readFileSync(file).includes(Buffer.from(sentinel))).toBe(false);
      }
      expect(JSON.parse(readFileSync(
        path.join(storage.roots.liveRoot, '.identity.json'),
        'utf8',
      ))).toEqual({
        derivationVersion: 1,
        storageKey: USER_A_STORAGE_KEY,
        userKey: 'user-a',
      });
    } finally {
      storage.close();
    }
  });
});
