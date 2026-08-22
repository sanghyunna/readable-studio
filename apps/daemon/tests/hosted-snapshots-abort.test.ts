import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getProject, insertProject } from '../src/db.js';
import { createHostedRuntimeStorage } from '../src/hosted-runtime-storage.js';
import {
  createHostedSnapshotStore,
  type HostedSnapshotFailpoint,
} from '../src/hosted-snapshots.js';

const identity = {
  storageKey: 'od1_fc95297aa4f56781f0decb7d4bf59b1447f09b3611039b80188b1c6beb03ee6a',
  userKey: 'user-a',
} as const;
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'readable-hosted-snapshot-abort-'));
  tempRoots.push(root);
  return root;
}

function versionSequences(runtimeRoot: string): string[] {
  return readdirSync(path.join(
    runtimeRoot,
    'snapshots',
    identity.storageKey,
    'versions',
  )).filter((entry) => /^\d{20}$/u.test(entry)).sort();
}

describe('hosted snapshot abort authority', () => {
  it.each([
    'before-completion-marker',
    'after-completion-marker',
    'after-version-rename',
    'after-latest-write',
    'after-retention-prune',
  ] as const)(
    'keeps the prior version and latest hint when aborted at %s',
    async (abortAt: HostedSnapshotFailpoint) => {
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
      const latestFile = path.join(
        runtimeRoot,
        'snapshots',
        identity.storageKey,
        'latest',
      );
      const priorLatest = readFileSync(latestFile, 'utf8');

      const candidateStorage = createHostedRuntimeStorage({ identity, runtimeRoot });
      insertProject(candidateStorage.database, {
        createdAt: 2,
        id: 'candidate',
        name: 'Must Not Become Authoritative',
        updatedAt: 2,
      });
      const abort = new AbortController();
      const candidateStore = createHostedSnapshotStore({
        failpoint(stage) {
          if (stage === abortAt) abort.abort(new Error(`abort at ${stage}`));
        },
        identity,
        runtimeRoot,
      });

      await expect(candidateStore.publish({
        quiesce: async () => {},
        signal: abort.signal,
        storage: candidateStorage,
      })).rejects.toMatchObject({
        code: 'HOSTED_RUNTIME_UNAVAILABLE',
      });
      candidateStorage.close();

      expect(readFileSync(latestFile, 'utf8')).toBe(priorLatest);
      expect(versionSequences(runtimeRoot)).toEqual([baseline.sequence]);
      const restored = await baselineStore.restore();
      expect(restored?.sequence).toBe(baseline.sequence);
      expect(restored && getProject(restored.storage.database, 'baseline')?.name).toBe('Baseline');
      expect(restored && getProject(restored.storage.database, 'candidate')).toBeNull();
      restored?.storage.close();
    },
  );

  it('keeps both prior valid versions when the newest prior corrupts at abort', async () => {
    const runtimeRoot = tempRoot();
    const store = createHostedSnapshotStore({ identity, runtimeRoot });
    const publish = async (name: string, createdAt: number) => {
      const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
      insertProject(storage.database, {
        createdAt,
        id: 'state',
        name,
        updatedAt: createdAt,
      });
      const publication = await store.publish({ quiesce: async () => {}, storage });
      storage.close();
      return publication;
    };
    const fallback = await publish('fallback', 1);
    const previous = await publish('previous', 2);

    const candidateStorage = createHostedRuntimeStorage({ identity, runtimeRoot });
    insertProject(candidateStorage.database, {
      createdAt: 3,
      id: 'state',
      name: 'candidate',
      updatedAt: 3,
    });
    const abort = new AbortController();
    const candidateStore = createHostedSnapshotStore({
      failpoint(stage) {
        if (stage !== 'after-retention-prune') return;
        writeFileSync(path.join(previous.versionRoot, 'payload', 'corrupt.txt'), 'corrupt');
        abort.abort(new Error('abort after retention prune'));
      },
      identity,
      runtimeRoot,
    });

    await expect(candidateStore.publish({
      quiesce: async () => {},
      signal: abort.signal,
      storage: candidateStorage,
    })).rejects.toMatchObject({ code: 'HOSTED_RUNTIME_UNAVAILABLE' });
    candidateStorage.close();

    expect(versionSequences(runtimeRoot)).toEqual([fallback.sequence, previous.sequence]);
    const restored = await store.restore();
    expect(restored?.sequence).toBe(fallback.sequence);
    expect(restored && getProject(restored.storage.database, 'state')?.name).toBe('fallback');
    restored?.storage.close();
  });

  it('treats a malformed latest hint as non-authoritative during abort cleanup', async () => {
    const runtimeRoot = tempRoot();
    const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
    insertProject(storage.database, {
      createdAt: 1,
      id: 'baseline',
      name: 'Baseline',
      updatedAt: 1,
    });
    const store = createHostedSnapshotStore({ identity, runtimeRoot });
    const baseline = await store.publish({ quiesce: async () => {}, storage });
    storage.close();
    const latest = path.join(runtimeRoot, 'snapshots', identity.storageKey, 'latest');
    rmSync(latest);
    mkdirSync(latest);

    const candidateStorage = createHostedRuntimeStorage({ identity, runtimeRoot });
    const abort = new AbortController();
    const candidateStore = createHostedSnapshotStore({
      failpoint(stage) {
        if (stage === 'after-retention-prune') abort.abort(new Error('abort'));
      },
      identity,
      runtimeRoot,
    });
    await expect(candidateStore.publish({
      quiesce: async () => {},
      signal: abort.signal,
      storage: candidateStorage,
    })).rejects.toMatchObject({
      code: 'HOSTED_RUNTIME_UNAVAILABLE',
      message: 'hosted snapshot publication was aborted before becoming authoritative',
    });
    candidateStorage.close();

    expect(versionSequences(runtimeRoot)).toEqual([baseline.sequence]);
    const restored = await store.restore();
    expect(restored?.sequence).toBe(baseline.sequence);
    restored?.storage.close();
  });

  it('joins a slow phase after abort without allowing late authority', async () => {
    const runtimeRoot = tempRoot();
    const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
    const abort = new AbortController();
    let release!: () => void;
    const slowPhase = new Promise<void>((resolve) => { release = resolve; });
    const publication = createHostedSnapshotStore({ identity, runtimeRoot }).publish({
      quiesce: () => slowPhase,
      signal: abort.signal,
      storage,
    });
    let settled = false;
    void publication.finally(() => { settled = true; }).catch(() => {});

    abort.abort(new Error('deadline'));
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(publication).rejects.toMatchObject({ code: 'HOSTED_RUNTIME_UNAVAILABLE' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(versionSequences(runtimeRoot)).toEqual([]);
    storage.close();
  });

  it('keeps an aborted candidate non-authoritative when pending cleanup fails', async () => {
    const runtimeRoot = tempRoot();
    const baselineStorage = createHostedRuntimeStorage({ identity, runtimeRoot });
    insertProject(baselineStorage.database, {
      createdAt: 1,
      id: 'baseline',
      name: 'Baseline',
      updatedAt: 1,
    });
    const store = createHostedSnapshotStore({ identity, runtimeRoot });
    const baseline = await store.publish({ quiesce: async () => {}, storage: baselineStorage });
    baselineStorage.close();

    const candidateStorage = createHostedRuntimeStorage({ identity, runtimeRoot });
    const abort = new AbortController();
    const candidateStore = createHostedSnapshotStore({
      failpoint(stage) {
        if (stage === 'after-version-rename') abort.abort(new Error('abort'));
      },
      identity,
      runtimeRoot,
    });
    const originalRm = fsp.rm.bind(fsp);
    let injected = false;
    vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
      if (!injected && path.basename(String(target)).startsWith('.retired-pending-')) {
        injected = true;
        throw new Error('injected pending cleanup failure');
      }
      await originalRm(target, options);
    });

    try {
      await expect(candidateStore.publish({
        quiesce: async () => {},
        signal: abort.signal,
        storage: candidateStorage,
      })).rejects.toMatchObject({
        code: 'HOSTED_RUNTIME_UNAVAILABLE',
        message: 'hosted snapshot abort cleanup failed',
      });
      candidateStorage.close();
      expect(versionSequences(runtimeRoot)).toEqual([baseline.sequence]);
      const versionsRoot = path.join(
        runtimeRoot,
        'snapshots',
        identity.storageKey,
        'versions',
      );
      expect(readdirSync(versionsRoot).some((name) => name.startsWith('.retired-pending-')))
        .toBe(true);

      const restored = await store.restore();
      expect(restored?.sequence).toBe(baseline.sequence);
      expect(restored && getProject(restored.storage.database, 'baseline')?.name).toBe('Baseline');
      restored?.storage.close();
      expect(readdirSync(versionsRoot)).toEqual([baseline.sequence]);
    } finally {
      candidateStorage.close();
      vi.restoreAllMocks();
    }
  });
});
