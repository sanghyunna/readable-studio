import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getAgentSession,
  getProject,
  insertConversation,
  insertProject,
  upsertAgentSession,
} from '../src/db.js';
import { createHostedRuntimeStorage } from '../src/hosted-runtime-storage.js';
import { createHostedSnapshotStore } from '../src/hosted-snapshots.js';

const roots: string[] = [];
const identity = {
  storageKey: 'od1_fc95297aa4f56781f0decb7d4bf59b1447f09b3611039b80188b1c6beb03ee6a',
  userKey: 'user-a',
} as const;
const otherIdentity = {
  storageKey: 'od1_eb1c58aa404f0ada5e83d6c2bc60990da8e2e16b09a28c5a7fcb39e3231eabb9',
  userKey: 'user-b',
} as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'readable-hosted-snapshots-'));
  roots.push(root);
  return root;
}

function versionRoots(runtimeRoot: string): string[] {
  const root = path.join(runtimeRoot, 'snapshots', identity.storageKey, 'versions');
  return existsSync(root)
    ? readdirSync(root).filter((name) => /^\d{20}$/u.test(name)).sort()
    : [];
}

function filesBelow(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? filesBelow(file) : [file];
  });
}

describe('hosted snapshots', () => {
  it('publishes and restores the complete runtime into a fresh generation', async () => {
    const runtimeRoot = tempRoot();
    const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
    const sourceGeneration = storage.roots.liveRoot;
    const now = Date.now();
    insertProject(storage.database, {
      createdAt: now,
      id: 'project-a',
      name: 'Project A',
      updatedAt: now,
    });
    insertConversation(storage.database, {
      createdAt: now,
      id: 'conversation-a',
      projectId: 'project-a',
      updatedAt: now,
    });
    mkdirSync(path.join(storage.roots.projectsRoot, 'project-a'));
    mkdirSync(path.join(storage.roots.projectsRoot, 'project-a', 'empty'));
    writeFileSync(path.join(storage.roots.projectsRoot, 'project-a', 'index.html'), '<h1>A</h1>');
    writeFileSync(path.join(storage.roots.artifactsRoot, 'artifact.html'), 'artifact');
    writeFileSync(path.join(storage.roots.uploadsRoot, 'upload.bin'), 'upload');
    writeFileSync(path.join(storage.roots.checkpointsRoot, 'checkpoint.json'), '{}');
    writeFileSync(path.join(storage.roots.runsRoot, 'events.jsonl'), '{"event":"done"}\n');
    const credentialSentinel = 'provider-secret-must-stay-ephemeral';
    writeFileSync(path.join(storage.roots.brokerRoot, 'credential.txt'), credentialSentinel);
    const parent = path.join(storage.roots.sessionsRoot, 'parent.jsonl');
    const child = path.join(storage.roots.sessionsRoot, 'child.jsonl');
    const projectCwd = path.join(storage.roots.projectsRoot, 'project-a');
    writeFileSync(parent, `${JSON.stringify({ type: 'session', cwd: projectCwd })}\n`);
    writeFileSync(child, `${JSON.stringify({ type: 'session', cwd: projectCwd, parentSession: parent })}\n`);
    upsertAgentSession(storage.database, {
      agentId: 'pi',
      conversationId: 'conversation-a',
      sessionId: 'child.jsonl',
    });
    let quiesced = false;
    const snapshots = createHostedSnapshotStore({ identity, runtimeRoot });
    const published = await snapshots.publish({
      quiesce: async () => { quiesced = true; },
      storage,
    });
    expect(quiesced).toBe(true);
    expect(published.sequence).toBe('00000000000000000001');
    expect(readFileSync(path.join(published.versionRoot, 'manifest.json'), 'utf8')).not.toContain(sourceGeneration);
    for (const file of filesBelow(published.versionRoot)) {
      expect(readFileSync(file).includes(Buffer.from(credentialSentinel))).toBe(false);
    }
    storage.close();

    const stale = createHostedRuntimeStorage({ identity, runtimeRoot });
    writeFileSync(path.join(stale.roots.projectsRoot, 'stale.txt'), 'must not survive');
    const staleGeneration = stale.roots.liveRoot;

    let restoreYielded = false;
    const restorePromise = snapshots.restore();
    await new Promise<void>((resolve) => setImmediate(() => {
      restoreYielded = true;
      resolve();
    }));
    const restored = await restorePromise;
    expect(restoreYielded).toBe(true);
    expect(restored?.sequence).toBe(published.sequence);
    if (restored == null) {
      stale.close();
      return;
    }
    try {
      expect(restored.storage.roots.liveRoot).not.toBe(sourceGeneration);
      expect(restored.storage.roots.liveRoot).not.toBe(staleGeneration);
      expect(existsSync(path.join(restored.storage.roots.projectsRoot, 'stale.txt'))).toBe(false);
      expect(readFileSync(
        path.join(restored.storage.roots.projectsRoot, 'project-a', 'index.html'),
        'utf8',
      )).toBe('<h1>A</h1>');
      expect(readFileSync(
        path.join(restored.storage.roots.artifactsRoot, 'artifact.html'),
        'utf8',
      )).toBe('artifact');
      expect(readFileSync(
        path.join(restored.storage.roots.uploadsRoot, 'upload.bin'),
        'utf8',
      )).toBe('upload');
      expect(readFileSync(
        path.join(restored.storage.roots.checkpointsRoot, 'checkpoint.json'),
        'utf8',
      )).toBe('{}');
      expect(readFileSync(
        path.join(restored.storage.roots.runsRoot, 'events.jsonl'),
        'utf8',
      )).toBe('{"event":"done"}\n');
      expect(existsSync(path.join(
        restored.storage.roots.projectsRoot,
        'project-a',
        'empty',
      ))).toBe(true);
      expect(getProject(restored.storage.database, 'project-a')?.name).toBe('Project A');
      const restoredChild = getAgentSession(restored.storage.database, 'conversation-a', 'pi');
      expect(restoredChild).toBe(path.join(restored.storage.roots.sessionsRoot, 'child.jsonl'));
      const childHeader = JSON.parse(readFileSync(restoredChild!, 'utf8').trim()) as Record<string, unknown>;
      expect(childHeader.cwd).toBe(path.join(restored.storage.roots.projectsRoot, 'project-a'));
      expect(childHeader.parentSession).toBe(path.join(restored.storage.roots.sessionsRoot, 'parent.jsonl'));
      expect(restored.storage.database.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      restored.storage.close();
      stale.close();
    }
  });

  it('backs up uncheckpointed WAL state into the authoritative snapshot', async () => {
    const runtimeRoot = tempRoot();
    const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
    storage.database.pragma('wal_autocheckpoint = 0');
    storage.database.pragma('wal_checkpoint(TRUNCATE)');
    insertProject(storage.database, {
      createdAt: 1,
      id: 'wal-project',
      name: 'Uncheckpointed WAL',
      updatedAt: 1,
    });
    const walFile = `${storage.roots.databaseFile}-wal`;
    expect(statSync(walFile).size).toBeGreaterThan(0);
    const snapshots = createHostedSnapshotStore({ identity, runtimeRoot });
    await snapshots.publish({ quiesce: async () => {}, storage });
    storage.close();

    const restored = await snapshots.restore();
    expect(restored && getProject(restored.storage.database, 'wal-project')?.name)
      .toBe('Uncheckpointed WAL');
    restored?.storage.close();
  });

  it('retains only DB-reachable session lineage and drops every orphan shape', async () => {
    const runtimeRoot = tempRoot();
    const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
    const now = Date.now();
    insertProject(storage.database, {
      createdAt: now,
      id: 'project-a',
      name: 'Project A',
      updatedAt: now,
    });
    insertConversation(storage.database, {
      createdAt: now,
      id: 'conversation-a',
      projectId: 'project-a',
      updatedAt: now,
    });
    const projectRoot = path.join(storage.roots.projectsRoot, 'project-a');
    mkdirSync(projectRoot);
    const parent = path.join(storage.roots.sessionsRoot, 'parent.jsonl');
    const child = path.join(storage.roots.sessionsRoot, 'child.jsonl');
    writeFileSync(parent, `${JSON.stringify({ type: 'session', cwd: projectRoot })}\n`);
    writeFileSync(child, `${JSON.stringify({
      type: 'session',
      cwd: projectRoot,
      parentSession: parent,
    })}\n`);
    writeFileSync(
      path.join(storage.roots.sessionsRoot, 'orphan-absolute.jsonl'),
      `${JSON.stringify({ type: 'session', cwd: runtimeRoot, parentSession: runtimeRoot })}\n`,
    );
    writeFileSync(path.join(storage.roots.sessionsRoot, 'orphan-malformed.jsonl'), '{not-json}\n');
    writeFileSync(
      path.join(storage.roots.sessionsRoot, 'orphan-missing-parent.jsonl'),
      `${JSON.stringify({
        type: 'session',
        cwd: projectRoot,
        parentSession: path.join(storage.roots.sessionsRoot, 'missing.jsonl'),
      })}\n`,
    );
    upsertAgentSession(storage.database, {
      agentId: 'pi',
      conversationId: 'conversation-a',
      sessionId: child,
    });
    const snapshots = createHostedSnapshotStore({ identity, runtimeRoot });
    const published = await snapshots.publish({ quiesce: async () => {}, storage });
    storage.close();

    const retainedSessions = filesBelow(path.join(published.versionRoot, 'payload', 'sessions'))
      .map((file) => path.basename(file))
      .sort();
    expect(retainedSessions).toEqual(['child.jsonl', 'parent.jsonl']);
    for (const file of filesBelow(path.join(published.versionRoot, 'payload', 'sessions'))) {
      expect(readFileSync(file, 'utf8')).not.toContain(runtimeRoot);
    }

    const restored = await snapshots.restore();
    expect(restored).not.toBeNull();
    if (restored == null) return;
    try {
      expect(readdirSync(restored.storage.roots.sessionsRoot).sort())
        .toEqual(['child.jsonl', 'parent.jsonl']);
      const restoredChild = getAgentSession(restored.storage.database, 'conversation-a', 'pi');
      const header = JSON.parse(readFileSync(restoredChild!, 'utf8')) as Record<string, unknown>;
      expect(header.parentSession).toBe(path.join(restored.storage.roots.sessionsRoot, 'parent.jsonl'));
      expect(header.cwd).toBe(restored.storage.roots.projectsRoot + path.sep + 'project-a');
    } finally {
      restored.storage.close();
    }
  });

  it('case-folds Windows publication lock aliases before concurrent admission', async () => {
    const runtimeRoot = tempRoot();
    const firstStorage = createHostedRuntimeStorage({ identity, runtimeRoot });
    const secondStorage = createHostedRuntimeStorage({ identity, runtimeRoot });
    let active = 0;
    let peak = 0;
    const createStore = (canonicalPath: string) => createHostedSnapshotStore({
      identity,
      publicationLockIdentity: { canonicalPath, platform: 'win32' },
      runtimeRoot,
    });
    const upper = createStore('C:\\Snapshots\\OD1_USER');
    const lower = createStore('c:\\snapshots\\od1_user');
    const publish = async (
      snapshots: ReturnType<typeof createHostedSnapshotStore>,
      storage: ReturnType<typeof createHostedRuntimeStorage>,
    ) => snapshots.publish({
      quiesce: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
      },
      storage,
    });
    try {
      const publications = await Promise.all([
        publish(upper, firstStorage),
        publish(lower, secondStorage),
      ]);
      expect(peak).toBe(1);
      expect(publications.map((item) => item.sequence)).toEqual([
        '00000000000000000001',
        '00000000000000000002',
      ]);
    } finally {
      firstStorage.close();
      secondStorage.close();
    }
  });

  it('falls back from corrupt and incomplete newer sequences without trusting latest', async () => {
    const runtimeRoot = tempRoot();
    const snapshots = createHostedSnapshotStore({ identity, runtimeRoot });
    const first = createHostedRuntimeStorage({ identity, runtimeRoot });
    insertProject(first.database, {
      createdAt: 1,
      id: 'project-a',
      name: 'first',
      updatedAt: 1,
    });
    await snapshots.publish({ quiesce: async () => {}, storage: first });
    first.close();

    const second = createHostedRuntimeStorage({ identity, runtimeRoot });
    insertProject(second.database, {
      createdAt: 2,
      id: 'project-a',
      name: 'second',
      updatedAt: 2,
    });
    const published = await snapshots.publish({ quiesce: async () => {}, storage: second });
    second.close();
    writeFileSync(path.join(published.versionRoot, 'payload', 'projects', 'corrupt.txt'), 'unhashed');
    writeFileSync(
      path.join(runtimeRoot, 'snapshots', identity.storageKey, 'latest'),
      '99999999999999999999\n',
    );
    mkdirSync(path.join(
      runtimeRoot,
      'snapshots',
      identity.storageKey,
      'versions',
      '00000000000000000003',
    ));

    const restored = await snapshots.restore();
    expect(restored?.sequence).toBe('00000000000000000001');
    try {
      expect(restored && getProject(restored.storage.database, 'project-a')?.name).toBe('first');
    } finally {
      restored?.storage.close();
    }
  });

  it('propagates materialization failure after selecting a valid snapshot', async () => {
    const runtimeRoot = tempRoot();
    const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
    const snapshots = createHostedSnapshotStore({ identity, runtimeRoot });
    await snapshots.publish({ quiesce: async () => {}, storage });
    storage.close();
    writeFileSync(
      path.join(runtimeRoot, 'live', identity.storageKey, '.identity.json'),
      `${JSON.stringify({
        derivationVersion: 1,
        storageKey: identity.storageKey,
        userKey: 'wrong-user',
      })}\n`,
    );

    await expect(snapshots.restore()).rejects.toThrow(/identity marker does not match/u);
  });

  it('rejects links and missing session closure during publication', async () => {
    const runtimeRoot = tempRoot();
    const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
    const snapshots = createHostedSnapshotStore({ identity, runtimeRoot });
    const outside = path.join(runtimeRoot, 'outside.txt');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, path.join(storage.roots.projectsRoot, 'link.txt'), 'file');
    await expect(snapshots.publish({ quiesce: async () => {}, storage })).rejects.toThrow(/link|reparse/u);
    storage.close();

    const missing = createHostedRuntimeStorage({ identity, runtimeRoot });
    insertProject(missing.database, { createdAt: 1, id: 'p', name: 'p', updatedAt: 1 });
    insertConversation(missing.database, {
      createdAt: 1,
      id: 'c',
      projectId: 'p',
      updatedAt: 1,
    });
    upsertAgentSession(missing.database, {
      agentId: 'pi',
      conversationId: 'c',
      sessionId: path.join(missing.roots.sessionsRoot, 'missing.jsonl'),
    });
    await expect(snapshots.publish({ quiesce: async () => {}, storage: missing })).rejects.toThrow(/session/u);
    missing.close();
  });

  it('strictly rejects unknown metadata and a snapshot copied across identities', async () => {
    const runtimeRoot = tempRoot();
    const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
    const snapshots = createHostedSnapshotStore({ identity, runtimeRoot });
    const published = await snapshots.publish({ quiesce: async () => {}, storage });
    storage.close();
    const manifestFile = path.join(published.versionRoot, 'manifest.json');
    const completionFile = path.join(published.versionRoot, '.complete.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
    manifest.unknown = true;
    const manifestText = `${JSON.stringify(manifest)}\n`;
    writeFileSync(manifestFile, manifestText);
    const completion = JSON.parse(readFileSync(completionFile, 'utf8')) as Record<string, unknown>;
    completion.manifestSha256 = createHash('sha256').update(manifestText).digest('hex');
    writeFileSync(completionFile, `${JSON.stringify(completion)}\n`);
    await expect(snapshots.restore()).rejects.toMatchObject({
      code: 'HOSTED_RUNTIME_UNAVAILABLE',
    });

    const copiedRoot = tempRoot();
    const sourceStorage = createHostedRuntimeStorage({ identity, runtimeRoot: copiedRoot });
    const sourceSnapshots = createHostedSnapshotStore({ identity, runtimeRoot: copiedRoot });
    const source = await sourceSnapshots.publish({ quiesce: async () => {}, storage: sourceStorage });
    sourceStorage.close();
    const otherIdentity = {
      storageKey: 'od1_eb1c58aa404f0ada5e83d6c2bc60990da8e2e16b09a28c5a7fcb39e3231eabb9',
      userKey: 'user-b',
    } as const;
    const otherSnapshots = createHostedSnapshotStore({ identity: otherIdentity, runtimeRoot: copiedRoot });
    cpSync(
      source.versionRoot,
      path.join(copiedRoot, 'snapshots', otherIdentity.storageKey, 'versions', source.sequence),
      { errorOnExist: true, recursive: true },
    );
    await expect(otherSnapshots.restore()).rejects.toMatchObject({
      code: 'HOSTED_RUNTIME_UNAVAILABLE',
    });
  });

  it('serializes publication, retains two valid versions, and enforces quotas without advancing authority', async () => {
    const runtimeRoot = tempRoot();
    let active = 0;
    let peak = 0;
    const snapshots = createHostedSnapshotStore({
      identity,
      limits: { retainedBytesPerUser: 5_000_000 },
      runtimeRoot,
    });
    const publish = async (name: string) => {
      const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
      insertProject(storage.database, { createdAt: 1, id: name, name, updatedAt: 1 });
      try {
        return await snapshots.publish({
          quiesce: async () => {
            active += 1;
            peak = Math.max(peak, active);
            await Promise.resolve();
            active -= 1;
          },
          storage,
        });
      } finally {
        storage.close();
      }
    };

    await Promise.all([publish('one'), publish('two'), publish('three')]);
    expect(peak).toBe(1);
    expect(versionRoots(runtimeRoot)).toHaveLength(2);

    const before = versionRoots(runtimeRoot);
    const tooLarge = createHostedRuntimeStorage({ identity, runtimeRoot });
    writeFileSync(path.join(tooLarge.roots.projectsRoot, 'large.bin'), Buffer.alloc(5_000_001));
    await expect(snapshots.publish({ quiesce: async () => {}, storage: tooLarge })).rejects.toThrow(/quota/u);
    tooLarge.close();
    expect(versionRoots(runtimeRoot)).toEqual(before);
  });

  it('keeps prior authority when ENOSPC occurs before the completion marker', async () => {
    const runtimeRoot = tempRoot();
    const baselineStorage = createHostedRuntimeStorage({ identity, runtimeRoot });
    insertProject(baselineStorage.database, {
      createdAt: 1,
      id: 'baseline',
      name: 'Baseline',
      updatedAt: 1,
    });
    const baselineStore = createHostedSnapshotStore({ identity, runtimeRoot });
    const baseline = await baselineStore.publish({
      quiesce: async () => {},
      storage: baselineStorage,
    });
    baselineStorage.close();

    const nextStorage = createHostedRuntimeStorage({ identity, runtimeRoot });
    insertProject(nextStorage.database, {
      createdAt: 2,
      id: 'newer',
      name: 'Must Not Become Authoritative',
      updatedAt: 2,
    });
    const noSpace = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const failingStore = createHostedSnapshotStore({
      failpoint(stage) {
        if (stage === 'before-completion-marker') throw noSpace;
      },
      identity,
      runtimeRoot,
    });
    await expect(failingStore.publish({
      quiesce: async () => {},
      storage: nextStorage,
    })).rejects.toMatchObject({ code: 'ENOSPC' });
    nextStorage.close();

    expect(versionRoots(runtimeRoot)).toEqual([baseline.sequence]);
    const restored = await baselineStore.restore();
    expect(restored?.sequence).toBe(baseline.sequence);
    expect(restored && getProject(restored.storage.database, 'baseline')?.name).toBe('Baseline');
    expect(restored && getProject(restored.storage.database, 'newer')).toBeNull();
    restored?.storage.close();
  });

  it('includes completion metadata in exact version and retained byte boundaries', async () => {
    const measurementRoot = tempRoot();
    const measurementStore = createHostedSnapshotStore({ identity, runtimeRoot: measurementRoot });
    const publishEmpty = async (
      runtimeRoot: string,
      snapshots: ReturnType<typeof createHostedSnapshotStore>,
    ) => {
      const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
      try {
        return await snapshots.publish({ quiesce: async () => {}, storage });
      } finally {
        storage.close();
      }
    };
    const first = await publishEmpty(measurementRoot, measurementStore);
    const second = await publishEmpty(measurementRoot, measurementStore);
    expect(second.bytes).toBe(first.bytes);
    const retainedBoundary = treeBytes(path.join(
      measurementRoot,
      'snapshots',
      identity.storageKey,
    ));

    const exactRoot = tempRoot();
    const exactStore = createHostedSnapshotStore({
      identity,
      limits: {
        bytesPerVersion: first.bytes,
        retainedBytesGlobal: retainedBoundary,
        retainedBytesPerUser: retainedBoundary,
      },
      runtimeRoot: exactRoot,
    });
    await expect(publishEmpty(exactRoot, exactStore)).resolves.toMatchObject({ bytes: first.bytes });
    await expect(publishEmpty(exactRoot, exactStore)).resolves.toMatchObject({ bytes: first.bytes });
    expect(treeBytes(path.join(exactRoot, 'snapshots', identity.storageKey)))
      .toBe(retainedBoundary);
    await expect(publishEmpty(exactRoot, exactStore)).resolves.toMatchObject({ bytes: first.bytes });
    expect(versionRoots(exactRoot)).toEqual([
      '00000000000000000002',
      '00000000000000000003',
    ]);

    const underRoot = tempRoot();
    const underStore = createHostedSnapshotStore({
      identity,
      limits: {
        bytesPerVersion: first.bytes - 1,
        retainedBytesGlobal: retainedBoundary,
        retainedBytesPerUser: retainedBoundary,
      },
      runtimeRoot: underRoot,
    });
    await expect(publishEmpty(underRoot, underStore)).rejects.toMatchObject({
      code: 'HOSTED_QUOTA_EXCEEDED',
    });
    expect(versionRoots(underRoot)).toEqual([]);

    const retainedUnderRoot = tempRoot();
    const retainedUnderStore = createHostedSnapshotStore({
      identity,
      limits: {
        bytesPerVersion: first.bytes,
        retainedBytesGlobal: retainedBoundary - 1,
        retainedBytesPerUser: retainedBoundary - 1,
      },
      runtimeRoot: retainedUnderRoot,
    });
    await publishEmpty(retainedUnderRoot, retainedUnderStore);
    await expect(publishEmpty(retainedUnderRoot, retainedUnderStore)).rejects.toMatchObject({
      code: 'HOSTED_QUOTA_EXCEEDED',
    });
    expect(versionRoots(retainedUnderRoot)).toEqual(['00000000000000000001']);

    const maintenanceRoot = tempRoot();
    const maintenanceLimits = {
      bytesPerVersion: first.bytes,
      retainedBytesGlobal: retainedBoundary,
      retainedBytesPerUser: retainedBoundary,
    };
    const maintenanceStore = createHostedSnapshotStore({
      identity,
      limits: maintenanceLimits,
      runtimeRoot: maintenanceRoot,
    });
    await publishEmpty(maintenanceRoot, maintenanceStore);
    await publishEmpty(maintenanceRoot, maintenanceStore);
    const blockerName = '99999999999999999999';
    const persistentFailureStore = createHostedSnapshotStore({
      failpoint(stage) {
        if (stage === 'after-latest-write') {
          writeFileSync(path.join(
            maintenanceRoot,
            'snapshots',
            identity.storageKey,
            'versions',
            blockerName,
          ), '');
        }
      },
      identity,
      limits: maintenanceLimits,
      runtimeRoot: maintenanceRoot,
    });
    await expect(publishEmpty(maintenanceRoot, persistentFailureStore))
      .resolves.toMatchObject({ bytes: first.bytes });
    expect(treeBytes(path.join(maintenanceRoot, 'snapshots', identity.storageKey)))
      .toBeLessThanOrEqual(retainedBoundary);
    expect(versionRoots(maintenanceRoot)).toEqual([
      '00000000000000000002',
      '00000000000000000003',
    ]);
  });

  it.runIf(process.platform === 'win32')(
    'accepts ordinary Windows casing aliases without accepting reparse points',
    async () => {
      const runtimeRoot = tempRoot();
      const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
      const snapshots = createHostedSnapshotStore({
        identity,
        runtimeRoot: `\\\\?\\${runtimeRoot.toUpperCase()}`,
      });
      try {
        await expect(snapshots.publish({ quiesce: async () => {}, storage })).resolves.toBeDefined();
      } finally {
        storage.close();
      }
    },
  );

  it('rejects an over-budget manifest before hashing any payload file', async () => {
    const runtimeRoot = tempRoot();
    const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
    writeFileSync(
      path.join(storage.roots.projectsRoot, 'oversized.bin'),
      Buffer.alloc(2 * 1024 * 1024),
    );
    const publicationStore = createHostedSnapshotStore({ identity, runtimeRoot });
    await publicationStore.publish({ quiesce: async () => {}, storage });
    storage.close();

    const readStream = vi.spyOn(fs, 'createReadStream');
    const constrainedStore = createHostedSnapshotStore({
      identity,
      limits: { bytesPerVersion: 1024 * 1024 },
      runtimeRoot,
    });
    try {
      await expect(constrainedStore.restore()).rejects.toMatchObject({
        code: 'HOSTED_RUNTIME_UNAVAILABLE',
      });
      expect(readStream).not.toHaveBeenCalled();
    } finally {
      readStream.mockRestore();
    }
  });

  it('scavenges restore staging that crashed before its ownership marker was written', () => {
    const runtimeRoot = tempRoot();
    createHostedSnapshotStore({ identity, runtimeRoot });
    const owned = path.join(runtimeRoot, `.restore-${identity.storageKey}-before-marker`);
    const foreign = path.join(runtimeRoot, `.restore-${otherIdentity.storageKey}-before-marker`);
    mkdirSync(owned);
    mkdirSync(foreign);

    createHostedSnapshotStore({ identity, runtimeRoot });
    expect(existsSync(owned)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
  });

  it('distinguishes global retained capacity from per-user snapshot quota', async () => {
    const measuredRoot = tempRoot();
    createHostedSnapshotStore({ identity: otherIdentity, runtimeRoot: measuredRoot });
    const measuredStore = createHostedSnapshotStore({ identity, runtimeRoot: measuredRoot });
    const measuredStorage = createHostedRuntimeStorage({ identity, runtimeRoot: measuredRoot });
    await measuredStore.publish({ quiesce: async () => {}, storage: measuredStorage });
    measuredStorage.close();
    const globalBoundary = treeBytes(path.join(measuredRoot, 'snapshots'));

    const runtimeRoot = tempRoot();
    const limits = {
      retainedBytesGlobal: globalBoundary,
      retainedBytesPerUser: globalBoundary,
    };
    const storeA = createHostedSnapshotStore({ identity, limits, runtimeRoot });
    const storeB = createHostedSnapshotStore({
      identity: otherIdentity,
      limits,
      runtimeRoot,
    });
    const storageA = createHostedRuntimeStorage({ identity, runtimeRoot });
    const storageB = createHostedRuntimeStorage({ identity: otherIdentity, runtimeRoot });
    try {
      await expect(storeA.publish({ quiesce: async () => {}, storage: storageA }))
        .resolves.toBeDefined();
      await expect(storeB.publish({ quiesce: async () => {}, storage: storageB }))
        .rejects.toMatchObject({ code: 'HOSTED_CAPACITY_EXHAUSTED' });
    } finally {
      storageA.close();
      storageB.close();
    }
  });

  it('rejects extra version-root entries before hashing payload data', async () => {
    const runtimeRoot = tempRoot();
    const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
    const snapshots = createHostedSnapshotStore({ identity, runtimeRoot });
    const publication = await snapshots.publish({ quiesce: async () => {}, storage });
    storage.close();
    writeFileSync(path.join(publication.versionRoot, 'unexpected.zero'), '');
    const readStream = vi.spyOn(fs, 'createReadStream');
    try {
      await expect(snapshots.restore()).rejects.toMatchObject({
        code: 'HOSTED_RUNTIME_UNAVAILABLE',
      });
      expect(readStream).not.toHaveBeenCalled();
    } finally {
      readStream.mockRestore();
    }
  });

  it('bounds zero-byte quota walks and scavenges crash-stale global staging', async () => {
    const runtimeRoot = tempRoot();
    const storeA = createHostedSnapshotStore({
      identity,
      limits: { filesPerVersion: 12 },
      runtimeRoot,
    });
    createHostedSnapshotStore({
      identity: otherIdentity,
      limits: { filesPerVersion: 12 },
      runtimeRoot,
    });
    const foreignRoot = path.join(runtimeRoot, 'snapshots', otherIdentity.storageKey);
    const stale = path.join(foreignRoot, '.staging-00000000000000000001-crashed');
    mkdirSync(stale);
    writeFileSync(path.join(stale, 'partial.zero'), '');
    const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
    try {
      await expect(storeA.publish({ quiesce: async () => {}, storage })).resolves.toBeDefined();
    } finally {
      storage.close();
    }
    expect(existsSync(stale)).toBe(false);

    for (let index = 0; index < 256; index += 1) {
      writeFileSync(path.join(
        runtimeRoot,
        'snapshots',
        identity.storageKey,
        `unexpected-${index}.zero`,
      ), '');
    }
    const nextStorage = createHostedRuntimeStorage({ identity, runtimeRoot });
    try {
      await expect(storeA.publish({ quiesce: async () => {}, storage: nextStorage }))
        .rejects.toMatchObject({ code: 'HOSTED_QUOTA_EXCEEDED' });
    } finally {
      nextStorage.close();
    }
  });

  it('streams session bodies while normalizing and relocating only their headers', async () => {
    const runtimeRoot = tempRoot();
    const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
    insertProject(storage.database, {
      createdAt: 1,
      id: 'stream-project',
      name: 'Stream project',
      updatedAt: 1,
    });
    insertConversation(storage.database, {
      createdAt: 1,
      id: 'stream-conversation',
      projectId: 'stream-project',
      updatedAt: 1,
    });
    const projectRoot = path.join(storage.roots.projectsRoot, 'stream-project');
    mkdirSync(projectRoot);
    const sessionFile = path.join(storage.roots.sessionsRoot, 'stream.jsonl');
    const body = JSON.stringify({ payload: 'x'.repeat(2 * 1024 * 1024), type: 'message' });
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ cwd: projectRoot, type: 'session' })}\n${body}\n`,
    );
    upsertAgentSession(storage.database, {
      agentId: 'pi',
      conversationId: 'stream-conversation',
      sessionId: sessionFile,
    });
    const readFile = vi.spyOn(fsp, 'readFile');
    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync');
    const snapshots = createHostedSnapshotStore({ identity, runtimeRoot });
    const publication = await snapshots.publish({ quiesce: async () => {}, storage });
    storage.close();
    const restored = await snapshots.restore();
    expect(restored?.sequence).toBe(publication.sequence);
    expect(readFile.mock.calls.some(([file]) => String(file).endsWith('.jsonl'))).toBe(false);
    expect(readFileSyncSpy.mock.calls.some(([file]) => String(file).endsWith('.jsonl'))).toBe(false);
    readFile.mockRestore();
    readFileSyncSpy.mockRestore();
    const relocated = getAgentSession(restored!.storage.database, 'stream-conversation', 'pi')!;
    expect(readFileSync(relocated, 'utf8').endsWith(`${body}\n`)).toBe(true);
    restored?.storage.close();
  });

  it('keeps the event loop responsive while relocating a large restored session', async () => {
    const runtimeRoot = tempRoot();
    const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
    insertProject(storage.database, {
      createdAt: 1,
      id: 'large-session-project',
      name: 'Large session project',
      updatedAt: 1,
    });
    insertConversation(storage.database, {
      createdAt: 1,
      id: 'large-session-conversation',
      projectId: 'large-session-project',
      updatedAt: 1,
    });
    const projectRoot = path.join(storage.roots.projectsRoot, 'large-session-project');
    mkdirSync(projectRoot);
    const sessionFile = path.join(storage.roots.sessionsRoot, 'large.jsonl');
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ cwd: projectRoot, type: 'session' })}\n${JSON.stringify({
        payload: 'x'.repeat(4 * 1024 * 1024),
        type: 'message',
      })}\n`,
    );
    upsertAgentSession(storage.database, {
      agentId: 'pi',
      conversationId: 'large-session-conversation',
      sessionId: sessionFile,
    });
    const snapshots = createHostedSnapshotStore({ identity, runtimeRoot });
    await snapshots.publish({ quiesce: async () => {}, storage });
    storage.close();

    const originalOpenSync = fs.openSync.bind(fs);
    const synchronousSessionDescriptors = new Set<number>();
    const openSyncSpy = vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      const descriptor = mode === undefined
        ? originalOpenSync(file, flags)
        : originalOpenSync(file, flags, mode);
      if (String(file).endsWith('.jsonl')) synchronousSessionDescriptors.add(descriptor);
      return descriptor;
    });
    const readSyncSpy = vi.spyOn(fs, 'readSync');
    let heartbeatCount = 0;
    let maximumLagMs = 0;
    let previousHeartbeat = performance.now();
    const heartbeat = setInterval(() => {
      const now = performance.now();
      maximumLagMs = Math.max(maximumLagMs, now - previousHeartbeat);
      previousHeartbeat = now;
      heartbeatCount += 1;
    }, 10);

    let restored: Awaited<ReturnType<typeof snapshots.restore>> = null;
    let synchronousSessionReads = 0;
    try {
      restored = await snapshots.restore();
    } finally {
      clearInterval(heartbeat);
      synchronousSessionReads = readSyncSpy.mock.calls.filter(([descriptor]) =>
        synchronousSessionDescriptors.has(descriptor)).length;
      openSyncSpy.mockRestore();
      readSyncSpy.mockRestore();
    }
    try {
      expect(restored).not.toBeNull();
      expect(synchronousSessionReads).toBe(0);
      expect(heartbeatCount).toBeGreaterThan(0);
      expect(maximumLagMs).toBeLessThan(1_000);
    } finally {
      restored?.storage.close();
    }
  });

  it('aggregates restored-storage close failure without skipping staging cleanup', async () => {
    const runtimeRoot = tempRoot();
    const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
    const snapshots = createHostedSnapshotStore({ identity, runtimeRoot });
    await snapshots.publish({ quiesce: async () => {}, storage });
    storage.close();
    const originalRm = fsp.rm.bind(fsp);
    const originalClose = Database.prototype.close;
    let cleanupFailed = false;
    vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
      await originalRm(target, options);
      if (!cleanupFailed && path.basename(String(target)).startsWith('.restore-')) {
        cleanupFailed = true;
        throw new Error('injected restore cleanup failure');
      }
    });
    vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database.Database) {
      const result = originalClose.call(this);
      if (this.name.includes(`${path.sep}live${path.sep}`)) {
        throw new Error('injected restored storage close failure');
      }
      return result;
    });

    try {
      await expect(snapshots.restore()).rejects.toMatchObject({
        code: 'HOSTED_RUNTIME_UNAVAILABLE',
      });
      expect(readdirSync(runtimeRoot).some((name) => name.startsWith('.restore-'))).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('rejects oversized capture before copying the offending file and yields the event loop', async () => {
    const runtimeRoot = tempRoot();
    const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
    const oversized = path.join(storage.roots.projectsRoot, 'oversized.bin');
    writeFileSync(oversized, Buffer.alloc(2 * 1024 * 1024));
    const copiedSources: string[] = [];
    const originalCopy = fsp.copyFile.bind(fsp);
    const copySpy = vi.spyOn(fsp, 'copyFile').mockImplementation(async (...args) => {
      copiedSources.push(String(args[0]));
      return originalCopy(...args);
    });
    const snapshots = createHostedSnapshotStore({
      identity,
      limits: { bytesPerVersion: 1024 * 1024 },
      runtimeRoot,
    });
    let yielded = false;
    const eventLoopTurn = new Promise<void>((resolve) => setImmediate(() => {
      yielded = true;
      resolve();
    }));
    try {
      await expect(snapshots.publish({ quiesce: async () => {}, storage }))
        .rejects.toMatchObject({ code: 'HOSTED_QUOTA_EXCEEDED' });
      await eventLoopTurn;
      expect(yielded).toBe(true);
      expect(copiedSources).not.toContain(oversized);
      expect(versionRoots(runtimeRoot)).toEqual([]);
    } finally {
      copySpy.mockRestore();
      storage.close();
    }
  });

  it.each([
    'after-version-rename',
    'after-latest-write',
    'after-retention-prune',
  ] as const)('treats %s maintenance failure as committed success', async (failpoint) => {
    const runtimeRoot = tempRoot();
    const baselineStorage = createHostedRuntimeStorage({ identity, runtimeRoot });
    insertProject(baselineStorage.database, {
      createdAt: 1,
      id: 'state',
      name: 'baseline',
      updatedAt: 1,
    });
    const baselineStore = createHostedSnapshotStore({ identity, runtimeRoot });
    await baselineStore.publish({ quiesce: async () => {}, storage: baselineStorage });
    baselineStorage.close();

    const previousStorage = createHostedRuntimeStorage({ identity, runtimeRoot });
    insertProject(previousStorage.database, {
      createdAt: 2,
      id: 'state',
      name: 'previous',
      updatedAt: 2,
    });
    await baselineStore.publish({ quiesce: async () => {}, storage: previousStorage });
    previousStorage.close();

    const candidateStorage = createHostedRuntimeStorage({ identity, runtimeRoot });
    insertProject(candidateStorage.database, {
      createdAt: 3,
      id: 'state',
      name: 'candidate',
      updatedAt: 3,
    });
    const candidateStore = createHostedSnapshotStore({
      failpoint(stage) {
        if (stage === failpoint) throw new Error(`maintenance failed at ${stage}`);
      },
      identity,
      runtimeRoot,
    });
    const publication = await candidateStore.publish({
      quiesce: async () => {},
      storage: candidateStorage,
    });
    candidateStorage.close();
    expect(publication.sequence).toBe('00000000000000000003');
    expect(versionRoots(runtimeRoot)).toEqual([
      '00000000000000000002',
      '00000000000000000003',
    ]);
    expect(readFileSync(path.join(
      runtimeRoot,
      'snapshots',
      identity.storageKey,
      'latest',
    ), 'utf8')).toBe('00000000000000000003\n');
    const restored = await baselineStore.restore();
    expect(restored && getProject(restored.storage.database, 'state')?.name).toBe('candidate');
    restored?.storage.close();
  });

  it('returns committed success when latest-hint maintenance repeatedly fails', async () => {
    const runtimeRoot = tempRoot();
    const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
    insertProject(storage.database, {
      createdAt: 1,
      id: 'state',
      name: 'committed',
      updatedAt: 1,
    });
    const snapshotRoot = path.join(runtimeRoot, 'snapshots', identity.storageKey);
    const store = createHostedSnapshotStore({
      failpoint(stage) {
        if (stage !== 'after-version-rename') return;
        rmSync(path.join(snapshotRoot, 'latest'), { force: true });
        mkdirSync(path.join(snapshotRoot, 'latest'));
      },
      identity,
      runtimeRoot,
    });

    await expect(store.publish({ quiesce: async () => {}, storage }))
      .resolves.toMatchObject({ sequence: '00000000000000000001' });
    await expect(store.publish({ quiesce: async () => {}, storage }))
      .resolves.toMatchObject({ sequence: '00000000000000000002' });
    await expect(store.publish({ quiesce: async () => {}, storage }))
      .resolves.toMatchObject({ sequence: '00000000000000000003' });
    expect(readdirSync(snapshotRoot).some((name) => name.startsWith('.latest-'))).toBe(false);
    expect(versionRoots(runtimeRoot)).toEqual([
      '00000000000000000002',
      '00000000000000000003',
    ]);
    const restored = await store.restore();
    expect(restored && getProject(restored.storage.database, 'state')?.name).toBe('committed');
    restored?.storage.close();
    storage.close();
  });
});

function treeBytes(root: string): number {
  const info = statSync(root);
  if (info.isFile()) return info.size;
  return readdirSync(root).reduce((sum, name) => sum + treeBytes(path.join(root, name)), 0);
}
