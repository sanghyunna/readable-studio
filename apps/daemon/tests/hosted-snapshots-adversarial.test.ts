import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHostedRuntimeStorage } from '../src/hosted-runtime-storage.js';
import {
  createHostedSnapshotStore,
  type HostedSnapshotFailpoint,
  type HostedSnapshotStore,
} from '../src/hosted-snapshots.js';

const identityA = {
  storageKey: 'od1_fc95297aa4f56781f0decb7d4bf59b1447f09b3611039b80188b1c6beb03ee6a',
  userKey: 'user-a',
} as const;
const identityB = {
  storageKey: 'od1_eb1c58aa404f0ada5e83d6c2bc60990da8e2e16b09a28c5a7fcb39e3231eabb9',
  userKey: 'user-b',
} as const;
const roots: string[] = [];
const storages: Array<ReturnType<typeof createHostedRuntimeStorage>> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const storage of storages.splice(0)) storage.close();
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { force: true, recursive: true });
    } catch {
      // A red leaked-handle regression must not prevent the remaining cases.
    }
  }
});

function tempRoot(prefix = 'readable-hosted-snapshot-adversarial-'): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function storageFor(
  runtimeRoot: string,
  identity: typeof identityA | typeof identityB = identityA,
) {
  const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
  storages.push(storage);
  return storage;
}

async function publishEmpty(
  store: HostedSnapshotStore,
  runtimeRoot: string,
  identity: typeof identityA | typeof identityB = identityA,
) {
  const storage = storageFor(runtimeRoot, identity);
  try {
    return await store.publish({ quiesce: async () => {}, storage });
  } finally {
    storage.close();
  }
}

function versionNames(
  runtimeRoot: string,
  identity: typeof identityA | typeof identityB = identityA,
): string[] {
  const versions = path.join(runtimeRoot, 'snapshots', identity.storageKey, 'versions');
  return existsSync(versions)
    ? readdirSync(versions).filter((name) => /^\d{20}$/u.test(name)).sort()
    : [];
}

function fileCount(root: string): number {
  const info = statSync(root);
  if (info.isFile()) return 1;
  return readdirSync(root).reduce((count, name) => count + fileCount(path.join(root, name)), 0);
}

function treeBytes(root: string): number {
  if (!existsSync(root)) return 0;
  const info = statSync(root);
  if (info.isFile()) return info.size;
  return readdirSync(root).reduce((bytes, name) => bytes + treeBytes(path.join(root, name)), 0);
}

async function within<T>(promise: Promise<T>, milliseconds = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('snapshot operation exceeded its test bound')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('hosted snapshot adversarial boundaries', () => {
  it('rotates on the third publication when the projected newest two fit exactly', async () => {
    const measuredRoot = tempRoot();
    const measuredStore = createHostedSnapshotStore({ identity: identityA, runtimeRoot: measuredRoot });
    await publishEmpty(measuredStore, measuredRoot);
    await publishEmpty(measuredStore, measuredRoot);
    const retainedBoundary = treeBytes(path.join(
      measuredRoot,
      'snapshots',
      identityA.storageKey,
    ));

    const runtimeRoot = tempRoot();
    const store = createHostedSnapshotStore({
      identity: identityA,
      limits: {
        retainedBytesGlobal: retainedBoundary,
        retainedBytesPerUser: retainedBoundary,
      },
      runtimeRoot,
    });
    await publishEmpty(store, runtimeRoot);
    await publishEmpty(store, runtimeRoot);
    await expect(publishEmpty(store, runtimeRoot)).resolves.toMatchObject({
      sequence: '00000000000000000003',
    });
    expect(versionNames(runtimeRoot)).toEqual([
      '00000000000000000002',
      '00000000000000000003',
    ]);
    expect(treeBytes(path.join(runtimeRoot, 'snapshots', identityA.storageKey)))
      .toBeLessThanOrEqual(retainedBoundary);
  });

  it('counts checksums, manifest, and completion at the exact file limit', async () => {
    const measuredRoot = tempRoot();
    const measuredStorage = storageFor(measuredRoot);
    for (let index = 0; index < 7; index += 1) {
      writeFileSync(path.join(measuredStorage.roots.projectsRoot, `file-${index}.txt`), `${index}`);
    }
    const measured = await createHostedSnapshotStore({
      identity: identityA,
      runtimeRoot: measuredRoot,
    }).publish({ quiesce: async () => {}, storage: measuredStorage });
    measuredStorage.close();
    const exactLimit = fileCount(measured.versionRoot);
    expect(exactLimit - measured.fileCount).toBe(3);

    const publishAt = async (limit: number) => {
      const runtimeRoot = tempRoot();
      const storage = storageFor(runtimeRoot);
      for (let index = 0; index < 7; index += 1) {
        writeFileSync(path.join(storage.roots.projectsRoot, `file-${index}.txt`), `${index}`);
      }
      return createHostedSnapshotStore({
        identity: identityA,
        limits: { filesPerVersion: limit },
        runtimeRoot,
      }).publish({ quiesce: async () => {}, storage });
    };

    await expect(publishAt(exactLimit)).resolves.toBeDefined();
    await expect(publishAt(exactLimit - 1)).rejects.toMatchObject({
      code: 'HOSTED_QUOTA_EXCEEDED',
    });
  });

  it('bounds restore and garbage collection of an oversized corrupt tree', async () => {
    const runtimeRoot = tempRoot();
    const store = createHostedSnapshotStore({
      identity: identityA,
      limits: { filesPerVersion: 12 },
      runtimeRoot,
    });
    const corrupt = await publishEmpty(store, runtimeRoot);
    const projects = path.join(corrupt.versionRoot, 'payload', 'projects');
    for (let index = 0; index < 128; index += 1) {
      writeFileSync(path.join(projects, `corrupt-${index}.txt`), 'x');
    }

    await expect(within(store.restore())).rejects.toMatchObject({
      code: 'HOSTED_RUNTIME_UNAVAILABLE',
    });
    const replacement = await within(publishEmpty(store, runtimeRoot));
    expect(versionNames(runtimeRoot)).toEqual([replacement.sequence]);
  });

  it('rejects an oversized SQLite input before backup creates staging output', async () => {
    const runtimeRoot = tempRoot();
    const storage = storageFor(runtimeRoot);
    storage.database.exec('CREATE TABLE oversized_snapshot_input (payload BLOB NOT NULL)');
    storage.database.prepare(
      'INSERT INTO oversized_snapshot_input (payload) VALUES (zeroblob(?))',
    ).run(2 * 1024 * 1024);
    const backup = vi.spyOn(storage.database, 'backup');
    const store = createHostedSnapshotStore({
      identity: identityA,
      limits: { bytesPerVersion: 1024 * 1024 },
      runtimeRoot,
    });

    await expect(store.publish({ quiesce: async () => {}, storage })).rejects.toMatchObject({
      code: 'HOSTED_QUOTA_EXCEEDED',
    });
    expect(backup).not.toHaveBeenCalled();
    expect(readdirSync(path.join(runtimeRoot, 'snapshots', identityA.storageKey)))
      .not.toContainEqual(expect.stringMatching(/^\.staging-/u));
  });

  it.each(['regular file', 'directory link'] as const)(
    'treats a numeric 20-digit %s as corrupt history',
    async (shape) => {
      const runtimeRoot = tempRoot();
      const store = createHostedSnapshotStore({ identity: identityA, runtimeRoot });
      const versions = path.join(runtimeRoot, 'snapshots', identityA.storageKey, 'versions');
      const numeric = path.join(versions, '00000000000000000001');
      if (shape === 'regular file') {
        writeFileSync(numeric, 'not a snapshot');
      } else {
        const outside = path.join(runtimeRoot, 'outside-version');
        mkdirSync(outside);
        symlinkSync(outside, numeric, process.platform === 'win32' ? 'junction' : 'dir');
      }

      await expect(store.restore()).rejects.toMatchObject({
        code: 'HOSTED_RUNTIME_UNAVAILABLE',
      });
    },
  );

  it('removes stale restore staging left by a prior killed process', async () => {
    const runtimeRoot = tempRoot();
    const initial = createHostedSnapshotStore({ identity: identityA, runtimeRoot });
    await publishEmpty(initial, runtimeRoot);
    const stale = path.join(runtimeRoot, '.restore-killed-publisher');
    mkdirSync(stale);
    writeFileSync(path.join(stale, 'partial.bin'), 'partial');

    const restarted = createHostedSnapshotStore({ identity: identityA, runtimeRoot });
    const restored = await restarted.restore();
    storages.push(restored!.storage);
    expect(existsSync(stale)).toBe(false);
  });

  it('closes restored live storage when restore-staging cleanup fails', async () => {
    const runtimeRoot = tempRoot();
    const store = createHostedSnapshotStore({ identity: identityA, runtimeRoot });
    await publishEmpty(store, runtimeRoot);
    const originalRm = fsp.rm.bind(fsp);
    const closedLiveDatabases: string[] = [];
    const originalClose = Database.prototype.close;
    vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database.Database) {
      if (this.name.includes(`${path.sep}live${path.sep}`)) closedLiveDatabases.push(this.name);
      return originalClose.call(this);
    });
    vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
      await originalRm(target, options);
      if (path.basename(String(target)).startsWith('.restore-')) {
        throw new Error('injected restore staging cleanup failure');
      }
    });

    await expect(store.restore()).rejects.toThrow('injected restore staging cleanup failure');
    const liveRoot = path.join(runtimeRoot, 'live', identityA.storageKey);
    const generations = readdirSync(liveRoot).filter((name) => name.startsWith('generation-'));
    // Readable Studio identity validation opens and closes a read-only probe
    // before the restored live handle; cleanup must close both handles.
    expect(closedLiveDatabases.length).toBe(2);
    expect(generations).toEqual([]);
  });

  it('does not prune immutable versions when temporary validation cleanup fails', async () => {
    const runtimeRoot = tempRoot();
    const store = createHostedSnapshotStore({ identity: identityA, runtimeRoot });
    const first = await publishEmpty(store, runtimeRoot);
    const second = await publishEmpty(store, runtimeRoot);
    const originalRm = fsp.rm.bind(fsp);
    vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
      await originalRm(target, options);
      if (path.basename(String(target)).startsWith('readable-hosted-snapshot-db-')) {
        throw new Error('injected validation temp cleanup failure');
      }
    });

    await expect(publishEmpty(store, runtimeRoot)).rejects.toBeDefined();
    expect(existsSync(first.versionRoot)).toBe(true);
    expect(existsSync(second.versionRoot)).toBe(true);
  });

  it('does not oversubscribe the global retained quota across concurrent users', async () => {
    const measuredRoot = tempRoot();
    createHostedSnapshotStore({ identity: identityB, runtimeRoot: measuredRoot });
    const measuredA = createHostedSnapshotStore({ identity: identityA, runtimeRoot: measuredRoot });
    await publishEmpty(measuredA, measuredRoot);
    const globalBoundary = treeBytes(path.join(measuredRoot, 'snapshots'));

    const runtimeRoot = tempRoot();
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const failpoint = async (stage: HostedSnapshotFailpoint) => {
      if (stage !== 'after-manifest-write') return;
      arrivals += 1;
      if (arrivals === 2) release();
      await gate;
    };
    const limits = {
      retainedBytesGlobal: globalBoundary,
      retainedBytesPerUser: globalBoundary,
    };
    const storeA = createHostedSnapshotStore({
      failpoint,
      identity: identityA,
      limits,
      runtimeRoot,
    });
    const storeB = createHostedSnapshotStore({
      failpoint,
      identity: identityB,
      limits,
      runtimeRoot,
    });
    const storageA = storageFor(runtimeRoot, identityA);
    const storageB = storageFor(runtimeRoot, identityB);
    const results = await within(Promise.allSettled([
      storeA.publish({ quiesce: async () => {}, storage: storageA }),
      storeB.publish({ quiesce: async () => {}, storage: storageB }),
    ]));
    const fulfilled = results.filter((result) => result.status === 'fulfilled').length;

    expect(fulfilled).toBeLessThanOrEqual(1);
    expect(treeBytes(path.join(runtimeRoot, 'snapshots'))).toBeLessThanOrEqual(globalBoundary);
  });
});
