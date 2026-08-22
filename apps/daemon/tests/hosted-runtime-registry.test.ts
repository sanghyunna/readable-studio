import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiError } from '@readable-studio/contracts';
import { insertConversation, insertProject, upsertAgentSession } from '../src/db.js';
import {
  createHostedRuntimeRegistry,
  deriveHostedStorageKey,
  dispatchHostedRuntimeInternalOperation,
  HostedRuntimeError,
  poisonHostedRuntimeGeneration,
  readHostedRuntimeRegistryCapacity,
  type HostedRuntimeMeasurement,
  type HostedRuntimeRegistryOptions,
} from '../src/hosted-runtime-registry.js';
import { createHostedRuntimeStorage } from '../src/hosted-runtime-storage.js';
import {
  createHostedSnapshotStore,
  HostedSnapshotError,
} from '../src/hosted-snapshots.js';
import { statusForError } from '../src/http/response.js';
import { createChatRunService } from '../src/runs.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function expectHostedCode(error: unknown, code: string): boolean {
  expect(error).toBeInstanceOf(HostedRuntimeError);
  expect((error as HostedRuntimeError).code).toBe(code);
  return true;
}

function expectHostedThrow(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expectHostedCode(error, code);
    return;
  }
  throw new Error(`expected ${code}`);
}

function createRegistry(
  overrides: Partial<HostedRuntimeRegistryOptions> = {},
) {
  const runtimeRoot = overrides.runtimeRoot
    ?? mkdtempSync(join(tmpdir(), 'readable-hosted-runtime-registry-default-'));
  if (overrides.runtimeRoot === undefined) defaultRuntimeRoots.push(runtimeRoot);
  return createHostedRuntimeRegistry({
    ...overrides,
    runtimeRoot,
  });
}

const defaultRuntimeRoots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of defaultRuntimeRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('HostedRuntimeRegistry', () => {
  it('reports current capacity and snapshot measurements without retaining them', async () => {
    const measurements: HostedRuntimeMeasurement[] = [];
    const registry = createRegistry({ onMeasurement: (measurement) => measurements.push(measurement) });
    expect(readHostedRuntimeRegistryCapacity(registry)).toEqual({
      activeChildren: 0,
      activeRuns: 0,
      eventBudget: { bufferedBytes: 0, bytes: 0, connections: 0, events: 0 },
      laneOperations: 0,
      openDatabases: 0,
      queuedMutations: 0,
      residentRuntimes: 0,
      strongLeases: 0,
      weakLeases: 0,
    });

    const lease = registry.acquire({ userKey: 'a' });
    try {
      await waitForReady(registry, lease);
      expect(readHostedRuntimeRegistryCapacity(registry)).toMatchObject({
        openDatabases: 1,
        residentRuntimes: 1,
        strongLeases: 1,
      });
      await dispatchHostedRuntimeInternalOperation(registry, lease, {
        kind: 'snapshot:publish',
        quiesce: async () => {},
      });
      const measurement = measurements.find(({ kind }) => kind === 'snapshot');
      expect(measurement).toEqual(expect.objectContaining({
        bytes: expect.any(Number),
        durationMs: expect.any(Number),
        fileCount: expect.any(Number),
        kind: 'snapshot',
        ok: true,
        userKey: 'a',
      }));
      expect(measurement?.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      lease.release();
      await registry.shutdown();
    }
    expect(readHostedRuntimeRegistryCapacity(registry)).toMatchObject({
      activeChildren: 0,
      activeRuns: 0,
      laneOperations: 0,
      openDatabases: 0,
      queuedMutations: 0,
      residentRuntimes: 0,
      strongLeases: 0,
      weakLeases: 0,
    });
  });

  it('owns isolated runtime generations and evicts only a released user', async () => {
    vi.useFakeTimers();
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-runtime-registry-storage-'));
    const registry = createRegistry({ idleEvictionMs: 25, runtimeRoot });
    try {
      const a = registry.acquire({ userKey: 'a' });
      const b = registry.acquire({ userKey: 'b' });
      await Promise.all([waitForReady(registry, a), waitForReady(registry, b)]);
      const aGeneration = generationRoot(runtimeRoot, a.storageKey);
      const bGeneration = generationRoot(runtimeRoot, b.storageKey);

      for (const root of [aGeneration, bGeneration]) {
        expect(existsSync(join(root, 'app.sqlite'))).toBe(true);
        for (const directory of [
          'projects',
          'artifacts',
          'uploads',
          'checkpoints',
          'sessions',
          'runs',
          'broker',
        ]) expect(existsSync(join(root, directory))).toBe(true);
      }
      const credentialSentinel = 'hosted-registry-provider-secret';
      await registry.replaceCredential(a, {
        provider: 'anthropic',
        key: credentialSentinel,
      });
      for (const file of filesBelow(aGeneration)) {
        expect(readFileSync(file).includes(Buffer.from(credentialSentinel))).toBe(false);
      }

      b.release();
      await vi.advanceTimersByTimeAsync(25);
      expect(existsSync(bGeneration)).toBe(false);
      expect(existsSync(aGeneration)).toBe(true);

      a.release();
      await vi.advanceTimersByTimeAsync(25);
      expect(existsSync(aGeneration)).toBe(false);
      await registry.shutdown();
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('dispatches database, checkpoint, and run state through each owned runtime', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-runtime-registry-db-'));
    const registry = createRegistry({ runtimeRoot });
    const a = registry.acquire({ userKey: 'a' });
    const b = registry.acquire({ userKey: 'b' });
    try {
      const now = Date.now();
      await Promise.all([
        dispatchHostedRuntimeInternalOperation(registry, a, {
          kind: 'project:insert',
          conversationId: 'conversation-a',
          project: { id: 'same-project', name: 'A', createdAt: now, updatedAt: now },
          runId: 'write-a',
        }),
        dispatchHostedRuntimeInternalOperation(registry, b, {
          kind: 'project:insert',
          conversationId: 'conversation-b',
          project: { id: 'same-project', name: 'B', createdAt: now, updatedAt: now },
          runId: 'write-b',
        }),
      ]);
      await expect(dispatchHostedRuntimeInternalOperation(registry, a, {
        kind: 'project:get',
        projectId: 'same-project',
      })).resolves.toEqual({ id: 'same-project', name: 'A' });
      await expect(dispatchHostedRuntimeInternalOperation(registry, b, {
        kind: 'project:get',
        projectId: 'same-project',
      })).resolves.toEqual({ id: 'same-project', name: 'B' });
      await expect(dispatchHostedRuntimeInternalOperation(registry, a, {
        kind: 'checkpoint:count',
        projectId: 'same-project',
      })).resolves.toBe(0);
      await expect(dispatchHostedRuntimeInternalOperation(registry, a, {
        kind: 'run:get',
        runId: 'write-a',
      })).resolves.toMatchObject({
        id: 'write-a',
        conversationId: 'conversation-a',
        status: 'succeeded',
      });
      await expect(dispatchHostedRuntimeInternalOperation(registry, b, {
        kind: 'run:get',
        runId: 'write-a',
      })).resolves.toBeNull();
    } finally {
      a.release();
      b.release();
      await registry.shutdown();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('restores the newest valid snapshot before admitting work to a fresh generation', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-runtime-registry-restore-'));
    const identity = {
      storageKey: deriveHostedStorageKey('a'),
      userKey: 'a',
    };
    const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
    insertProjectForTest(storage, 'persisted', 'Persisted');
    const seedSnapshots = createHostedSnapshotStore({ identity, runtimeRoot });
    await seedSnapshots.publish({ quiesce: async () => {}, storage });
    storage.close();

    const restoreStarted = deferred();
    const releaseRestore = deferred();
    const registry = createRegistry({
      runtimeRoot,
      createSnapshotStore(options) {
        const snapshots = createHostedSnapshotStore(options);
        return {
          publish: snapshots.publish,
          async restore() {
            restoreStarted.resolve();
            await releaseRestore.promise;
            return snapshots.restore();
          },
        };
      },
    });
    const lease = registry.acquire({ userKey: 'a' });
    let admitted = false;
    const read = dispatchHostedRuntimeInternalOperation(registry, lease, {
      kind: 'project:get',
      projectId: 'persisted',
    }).then((value) => {
      admitted = true;
      return value;
    });
    try {
      await restoreStarted.promise;
      await Promise.resolve();
      expect(admitted).toBe(false);
      releaseRestore.resolve();
      await expect(read).resolves.toEqual({ id: 'persisted', name: 'Persisted' });
    } finally {
      releaseRestore.resolve();
      lease.release();
      await registry.shutdown();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('hydrates the restored Pi session before the next turn', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-runtime-registry-session-'));
    const identity = { storageKey: deriveHostedStorageKey('a'), userKey: 'a' };
    const storage = createHostedRuntimeStorage({ identity, runtimeRoot });
    const now = Date.now();
    insertProjectForTest(storage, 'project-a', 'Project A');
    insertConversation(storage.database, {
      createdAt: now,
      id: 'conversation-a',
      projectId: 'project-a',
      updatedAt: now,
    });
    const projectRoot = join(storage.roots.projectsRoot, 'project-a');
    mkdirSync(projectRoot);
    const sessionPath = join(storage.roots.sessionsRoot, 'session.jsonl');
    writeFileSync(sessionPath, `${JSON.stringify({ type: 'session', cwd: projectRoot })}\n`);
    upsertAgentSession(storage.database, {
      agentId: 'pi',
      conversationId: 'conversation-a',
      sessionId: sessionPath,
    });
    await createHostedSnapshotStore({ identity, runtimeRoot }).publish({
      quiesce: async () => {},
      storage,
    });
    storage.close();

    const registry = createRegistry({ runtimeRoot });
    const lease = registry.acquire({ userKey: 'a' });
    try {
      await expect(registry.dispatch(lease, {
        conversationId: 'conversation-a',
        runId: 'resumed-run',
        execute: async ({ sessionReference }) => ({ value: sessionReference }),
      })).resolves.toBe('session.jsonl');
    } finally {
      lease.release();
      await registry.shutdown();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('serializes snapshot publication in the existing per-user mutation lane', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-runtime-registry-lane-'));
    const registry = createRegistry({ runtimeRoot });
    const lease = registry.acquire({ userKey: 'a' });
    const runStarted = deferred();
    const releaseRun = deferred();
    const quiesceStarted = deferred();
    const releaseSnapshot = deferred();
    const run = registry.dispatch(lease, {
      conversationId: 'conversation-a',
      runId: 'active-before-snapshot',
      execute: async () => {
        runStarted.resolve();
        await releaseRun.promise;
        return { value: 'done' };
      },
    });
    try {
      await runStarted.promise;
      const publication = dispatchHostedRuntimeInternalOperation(registry, lease, {
        kind: 'snapshot:publish',
        quiesce: async () => {
          quiesceStarted.resolve();
          await releaseSnapshot.promise;
        },
      });
      let quiescing = false;
      void quiesceStarted.promise.then(() => { quiescing = true; });
      await Promise.resolve();
      expect(quiescing).toBe(false);

      releaseRun.resolve();
      await quiesceStarted.promise;
      const now = Date.now();
      let writeFinished = false;
      const write = dispatchHostedRuntimeInternalOperation(registry, lease, {
        kind: 'project:insert',
        conversationId: 'conversation-a',
        project: { id: 'after-snapshot', name: 'After', createdAt: now, updatedAt: now },
        runId: 'write-after-snapshot',
      }).then((value) => {
        writeFinished = true;
        return value;
      });
      await Promise.resolve();
      expect(writeFinished).toBe(false);

      releaseSnapshot.resolve();
      await expect(Promise.all([run, publication, write])).resolves.toEqual([
        'done',
        expect.objectContaining({ sequence: expect.stringMatching(/^\d{20}$/u) }),
        { id: 'after-snapshot', name: 'After' },
      ]);
    } finally {
      releaseRun.resolve();
      releaseSnapshot.resolve();
      lease.release();
      await registry.shutdown();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('keeps async failures inside the per-user mutation lane until they settle', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-runtime-registry-async-lane-'));
    const registry = createRegistry({ runtimeRoot });
    const lease = registry.acquire({ userKey: 'a' });
    const now = Date.now();
    const started = deferred();
    const release = deferred();
    const order: string[] = [];
    try {
      await dispatchHostedRuntimeInternalOperation(registry, lease, {
        kind: 'project:insert',
        conversationId: 'conversation-a',
        project: { id: 'project-a', name: 'Project A', createdAt: now, updatedAt: now },
        runId: 'seed-project',
      });
      const first = dispatchHostedRuntimeInternalOperation(registry, lease, {
        kind: 'run:mutate',
        scope: { kind: 'project', projectId: 'project-a' },
        execute: async () => {
          order.push('first:start');
          started.resolve();
          await release.promise;
          order.push('first:reject');
          throw new Error('expected mutation failure');
        },
      });
      await started.promise;
      const second = dispatchHostedRuntimeInternalOperation(registry, lease, {
        kind: 'run:mutate',
        scope: { kind: 'project', projectId: 'project-a' },
        execute: () => {
          order.push('second');
          return 'done';
        },
      });
      await Promise.resolve();
      expect(order).toEqual(['first:start']);

      release.resolve();
      await expect(first).rejects.toThrow('expected mutation failure');
      await expect(second).resolves.toBe('done');
      expect(order).toEqual(['first:start', 'first:reject', 'second']);
    } finally {
      release.resolve();
      lease.release();
      await registry.shutdown();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('runs terminal finalization before the next queued operation can enter the lane', async () => {
    const registry = createRegistry();
    const lease = registry.acquire({ userKey: 'a' });
    const started = deferred();
    const release = deferred();
    const order: string[] = [];
    try {
      const first = registry.dispatch(lease, {
        conversationId: 'conversation-a',
        runId: 'first',
        execute: async () => {
          order.push('first:start');
          started.resolve();
          await release.promise;
          order.push('first:end');
          return { value: 'first' };
        },
        onTerminal(error) {
          expect(error).toBeNull();
          order.push('first:terminal');
        },
      });
      await started.promise;
      const second = registry.dispatch(lease, {
        conversationId: 'conversation-a',
        runId: 'second',
        execute: async () => {
          order.push('second:start');
          return { value: 'second' };
        },
      });

      release.resolve();
      await expect(first).resolves.toBe('first');
      await expect(second).resolves.toBe('second');
      expect(order).toEqual([
        'first:start',
        'first:end',
        'first:terminal',
        'second:start',
      ]);
    } finally {
      release.resolve();
      lease.release();
      await registry.shutdown();
    }
  });

  it('bounds retained terminal runs per hosted runtime', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-runtime-registry-run-bound-'));
    const registry = createRegistry({ runtimeRoot, limits: { retainedRunsPerUser: 1 } });
    const lease = registry.acquire({ userKey: 'a' });
    try {
      await expect(registry.dispatch(lease, {
        conversationId: 'conversation-a',
        runId: 'first-run',
        execute: async () => ({ value: 'done' }),
      })).resolves.toBe('done');
      await expect(registry.dispatch(lease, {
        conversationId: 'conversation-a',
        runId: 'second-run',
        execute: async () => ({ value: 'should-not-run' }),
      })).rejects.toMatchObject({ code: 'HOSTED_OVERLOADED' });
    } finally {
      lease.release();
      await registry.shutdown();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('poisons only a failed publisher and restores its last valid snapshot', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-runtime-registry-publish-fail-'));
    let failA = false;
    const registry = createRegistry({
      runtimeRoot,
      createSnapshotStore(options) {
        const snapshots = createHostedSnapshotStore(options);
        return {
          restore: snapshots.restore,
          publish: async (input) => {
            if (failA && options.identity.userKey === 'a') {
              throw new Error('simulated snapshot publication failure');
            }
            return snapshots.publish(input);
          },
        };
      },
    });
    const a = registry.acquire({ userKey: 'a' });
    const b = registry.acquire({ userKey: 'b' });
    try {
      const now = Date.now();
      await dispatchHostedRuntimeInternalOperation(registry, a, {
        kind: 'project:insert',
        conversationId: 'conversation-a',
        project: { id: 'baseline', name: 'Baseline', createdAt: now, updatedAt: now },
        runId: 'baseline-a',
      });
      await dispatchHostedRuntimeInternalOperation(registry, b, {
        kind: 'project:insert',
        conversationId: 'conversation-b',
        project: { id: 'b-project', name: 'B', createdAt: now, updatedAt: now },
        runId: 'baseline-b',
      });
      await dispatchHostedRuntimeInternalOperation(registry, a, {
        kind: 'snapshot:publish',
        quiesce: async () => {},
      });
      await dispatchHostedRuntimeInternalOperation(registry, a, {
        kind: 'project:insert',
        conversationId: 'conversation-a',
        project: { id: 'unsnapshotted', name: 'Lost', createdAt: now, updatedAt: now },
        runId: 'unsnapshotted-a',
      });

      failA = true;
      await expect(dispatchHostedRuntimeInternalOperation(registry, a, {
        kind: 'snapshot:publish',
        quiesce: async () => {},
      })).rejects.toSatisfy(
        (error: unknown) => expectHostedCode(error, 'HOSTED_RUNTIME_UNAVAILABLE'),
      );
      await expect(dispatchHostedRuntimeInternalOperation(registry, b, {
        kind: 'project:get',
        projectId: 'b-project',
      })).resolves.toEqual({ id: 'b-project', name: 'B' });

      const failedGeneration = a.generation;
      a.release();
      failA = false;
      const restoredA = registry.acquire({ userKey: 'a' });
      expect(restoredA.generation).toBeGreaterThan(failedGeneration);
      await expect(dispatchHostedRuntimeInternalOperation(registry, restoredA, {
        kind: 'project:get',
        projectId: 'baseline',
      })).resolves.toEqual({ id: 'baseline', name: 'Baseline' });
      await expect(dispatchHostedRuntimeInternalOperation(registry, restoredA, {
        kind: 'project:get',
        projectId: 'unsnapshotted',
      })).resolves.toBeNull();
      restoredA.release();
    } finally {
      a.release();
      b.release();
      await registry.shutdown();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('preserves snapshot quota failures while poisoning the generation', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-runtime-registry-quota-'));
    const registry = createRegistry({
      runtimeRoot,
      createSnapshotStore() {
        return {
          restore: async () => null,
          publish: async () => {
            throw new HostedSnapshotError(
              'HOSTED_QUOTA_EXCEEDED',
              'simulated snapshot quota failure',
            );
          },
        };
      },
    });
    const lease = registry.acquire({ userKey: 'a' });
    try {
      await waitForReady(registry, lease);
      await expect(dispatchHostedRuntimeInternalOperation(registry, lease, {
        kind: 'snapshot:publish',
        quiesce: async () => {},
      })).rejects.toSatisfy(
        (error: unknown) => expectHostedCode(error, 'HOSTED_QUOTA_EXCEEDED'),
      );
    } finally {
      lease.release();
      await registry.shutdown();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('settles failed initialization even when partial storage cleanup throws', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-runtime-registry-init-close-'));
    let first = true;
    let failCleanup = true;
    const registry = createRegistry({
      runtimeRoot,
      createRunService(options) {
        if (first) {
          first = false;
          throw new Error('simulated run service initialization failure');
        }
        return createChatRunService(options);
      },
      createSnapshotStore(options) {
        const snapshots = createHostedSnapshotStore(options);
        return {
          publish: snapshots.publish,
          async restore() {
            if (!first) return snapshots.restore();
            const storage = createHostedRuntimeStorage({
              identity: options.identity,
              runtimeRoot: options.runtimeRoot,
            });
            return {
              sequence: '00000000000000000001',
              storage: {
                ...storage,
                close() {
                  if (failCleanup) {
                    failCleanup = false;
                    throw new Error('simulated initialization cleanup failure');
                  }
                  storage.close();
                },
              },
            };
          },
        };
      },
    });
    const failed = registry.acquire({ userKey: 'a' });
    try {
      await expect(waitForReady(registry, failed)).rejects.toSatisfy(
        (error: unknown) => expectHostedCode(error, 'HOSTED_RUNTIME_UNAVAILABLE'),
      );
      const failedGeneration = generationRoot(runtimeRoot, failed.storageKey);
      failed.release();
      expect(existsSync(failedGeneration)).toBe(true);
      const recovered = registry.acquire({ userKey: 'a' });
      expect(recovered.generation).toBeGreaterThan(failed.generation);
      await expect(waitForReady(registry, recovered)).resolves.toBeNull();
      expect(existsSync(failedGeneration)).toBe(false);
      recovered.release();
    } finally {
      failed.release();
      await registry.shutdown();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('keeps an accepted owned operation alive after its caller lease releases', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-runtime-registry-accepted-'));
    const registry = createRegistry({ runtimeRoot });
    const lease = registry.acquire({ userKey: 'a' });
    const now = Date.now();
    const accepted = dispatchHostedRuntimeInternalOperation(registry, lease, {
      kind: 'project:insert',
      conversationId: 'conversation-a',
      project: { id: 'accepted', name: 'A', createdAt: now, updatedAt: now },
      runId: 'accepted-run',
    });
    lease.release();
    try {
      await expect(accepted).resolves.toEqual({ id: 'accepted', name: 'A' });
      const reader = registry.acquire({ userKey: 'a' });
      await expect(dispatchHostedRuntimeInternalOperation(registry, reader, {
        kind: 'project:get',
        projectId: 'accepted',
      })).resolves.toEqual({ id: 'accepted', name: 'A' });
      reader.release();
      await registry.shutdown();
    } finally {
      lease.release();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('does not publish a resident generation when storage initialization fails', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-runtime-registry-failed-'));
    const storageKey = deriveHostedStorageKey('b');
    const storageRoot = join(runtimeRoot, 'live', storageKey);
    mkdirSync(storageRoot, { recursive: true });
    writeFileSync(join(storageRoot, '.identity.json'), `${JSON.stringify({
      derivationVersion: 1,
      storageKey,
      userKey: 'wrong-user',
    })}\n`);
    const registry = createRegistry({ runtimeRoot });
    const a = registry.acquire({ userKey: 'a' });
    try {
      const now = Date.now();
      await dispatchHostedRuntimeInternalOperation(registry, a, {
        kind: 'project:insert',
        conversationId: 'conversation-a',
        project: { id: 'still-live', name: 'A', createdAt: now, updatedAt: now },
        runId: 'write-a',
      });
      const failed = registry.acquire({ userKey: 'b' });
      await expect(waitForReady(registry, failed)).rejects.toSatisfy(
        (error: unknown) => expectHostedCode(error, 'HOSTED_RUNTIME_UNAVAILABLE'),
      );
      failed.release();
      expect(readdirSync(storageRoot)).toEqual(['.identity.json']);
      await expect(dispatchHostedRuntimeInternalOperation(registry, a, {
        kind: 'project:get',
        projectId: 'still-live',
      })).resolves.toEqual({ id: 'still-live', name: 'A' });

      writeFileSync(join(storageRoot, '.identity.json'), `${JSON.stringify({
        derivationVersion: 1,
        storageKey,
        userKey: 'b',
      })}\n`);
      const recovered = registry.acquire({ userKey: 'b' });
      expect(recovered.generation).toBeGreaterThan(failed.generation);
      await waitForReady(registry, recovered);
      recovered.release();
      a.release();
      await registry.shutdown();
    } finally {
      a.release();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('contains an idle cleanup failure and only replaces the failed generation after cleanup', async () => {
    vi.useFakeTimers();
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-runtime-registry-close-failure-'));
    let failFirstBClose = true;
    const registry = createRegistry({
      idleEvictionMs: 25,
      runtimeRoot,
      createStorage(options) {
        const storage = createHostedRuntimeStorage(options);
        if (options.identity.userKey !== 'b') return storage;
        return {
          ...storage,
          close() {
            if (failFirstBClose) {
              failFirstBClose = false;
              throw new Error('simulated B close failure');
            }
            storage.close();
          },
        };
      },
    });
    const a = registry.acquire({ userKey: 'a' });
    const b = registry.acquire({ userKey: 'b' });
    await Promise.all([waitForReady(registry, a), waitForReady(registry, b)]);
    const aGeneration = generationRoot(runtimeRoot, a.storageKey);
    const bGeneration = generationRoot(runtimeRoot, b.storageKey);
    const firstBGeneration = b.generation;
    try {
      const now = Date.now();
      await dispatchHostedRuntimeInternalOperation(registry, a, {
        kind: 'project:insert',
        conversationId: 'conversation-a',
        project: { id: 'sentinel', name: 'A', createdAt: now, updatedAt: now },
        runId: 'write-a',
      });
      b.release();
      await vi.advanceTimersByTimeAsync(25);

      expect(existsSync(aGeneration)).toBe(true);
      expect(existsSync(bGeneration)).toBe(true);
      await expect(dispatchHostedRuntimeInternalOperation(registry, a, {
        kind: 'project:get',
        projectId: 'sentinel',
      })).resolves.toEqual({ id: 'sentinel', name: 'A' });
      const bRecreated = registry.acquire({ userKey: 'b' });
      expect(bRecreated.generation).toBeGreaterThan(firstBGeneration);
      await waitForReady(registry, bRecreated);
      expect(existsSync(bGeneration)).toBe(false);
      expect(generationRoot(runtimeRoot, b.storageKey)).not.toBe(bGeneration);
      expect(existsSync(aGeneration)).toBe(true);
      bRecreated.release();
      a.release();
      await registry.shutdown();
    } finally {
      a.release();
      b.release();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('poisons only the addressed generation, drains it, and recreates it fresh', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-runtime-registry-poison-'));
    const registry = createRegistry({ runtimeRoot });
    const a = registry.acquire({ userKey: 'a' });
    const b = registry.acquire({ userKey: 'b' });
    await Promise.all([waitForReady(registry, a), waitForReady(registry, b)]);
    const aGeneration = generationRoot(runtimeRoot, a.storageKey);
    const bGeneration = generationRoot(runtimeRoot, b.storageKey);
    const bStarted = deferred();
    const activeB = registry.dispatch(b, {
      conversationId: 'conversation-b',
      runId: 'active-b',
      execute: ({ signal }) => new Promise<{ value: string }>((resolve) => {
        bStarted.resolve();
        signal.addEventListener('abort', () => resolve({ value: 'ignored' }), { once: true });
      }),
    });
    await bStarted.promise;
    const queuedB = registry.dispatch(b, {
      conversationId: 'conversation-b',
      runId: 'queued-b',
      execute: async () => ({ value: 'never' }),
    });
    try {
      expect(poisonHostedRuntimeGeneration(registry, {
        generation: b.generation,
        userKey: b.userKey,
      })).toBe(true);
      await expect(activeB).rejects.toSatisfy(
        (error: unknown) => expectHostedCode(error, 'HOSTED_RUNTIME_UNAVAILABLE'),
      );
      await expect(queuedB).rejects.toSatisfy(
        (error: unknown) => expectHostedCode(error, 'HOSTED_RUNTIME_UNAVAILABLE'),
      );
      await expect(registry.dispatch(b, {
        conversationId: 'conversation-b',
        runId: 'after-poison',
        execute: async () => ({ value: 'never' }),
      })).rejects.toSatisfy(
        (error: unknown) => expectHostedCode(error, 'HOSTED_RUNTIME_UNAVAILABLE'),
      );
      await expect(registry.dispatch(a, {
        conversationId: 'conversation-a',
        runId: 'a-still-live',
        execute: async () => ({ value: 'A' }),
      })).resolves.toBe('A');
      expect(poisonHostedRuntimeGeneration(registry, {
        generation: b.generation + 1,
        userKey: b.userKey,
      })).toBe(false);

      const poisonedGeneration = b.generation;
      b.release();
      const recreatedB = registry.acquire({ userKey: 'b' });
      expect(recreatedB.generation).toBeGreaterThan(poisonedGeneration);
      expect(existsSync(aGeneration)).toBe(true);
      expect(existsSync(bGeneration)).toBe(false);
      recreatedB.release();
      a.release();
      await registry.shutdown();
    } finally {
      a.release();
      b.release();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('never acknowledges success when owned run finalization fails', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-runtime-registry-run-failure-'));
    let failTerminalization = true;
    const registry = createRegistry({
      runtimeRoot,
      createRunService(options) {
        const service = createChatRunService(options);
        return {
          ...service,
          finish(...args: Parameters<typeof service.finish>) {
            if (failTerminalization) {
              failTerminalization = false;
              throw new Error('simulated run finalization failure');
            }
            return service.finish(...args);
          },
        };
      },
    });
    const lease = registry.acquire({ userKey: 'a' });
    const poisonedGeneration = lease.generation;
    try {
      await expect(registry.dispatch(lease, {
        conversationId: 'conversation-a',
        runId: 'run-a',
        execute: async () => ({ value: 'must-not-acknowledge' }),
      })).rejects.toSatisfy(
        (error: unknown) => expectHostedCode(error, 'HOSTED_RUNTIME_UNAVAILABLE'),
      );
      await expect(registry.dispatch(lease, {
        conversationId: 'conversation-a',
        runId: 'blocked',
        execute: async () => ({ value: 'never' }),
      })).rejects.toSatisfy(
        (error: unknown) => expectHostedCode(error, 'HOSTED_RUNTIME_UNAVAILABLE'),
      );

      lease.release();
      const recreated = registry.acquire({ userKey: 'a' });
      expect(recreated.generation).toBeGreaterThan(poisonedGeneration);
      await expect(registry.dispatch(recreated, {
        conversationId: 'conversation-a',
        runId: 'recovered',
        execute: async () => ({ value: 'recovered' }),
      })).resolves.toBe('recovered');
      recreated.release();
      await registry.shutdown();
    } finally {
      lease.release();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('keeps storage live during shutdown until the last strong lease releases', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-runtime-registry-shutdown-'));
    const registry = createRegistry({ runtimeRoot });
    const lease = registry.acquire({ userKey: 'a' });
    await waitForReady(registry, lease);
    const generation = generationRoot(runtimeRoot, lease.storageKey);
    try {
      let finished = false;
      const shutdown = registry.shutdown().then(() => { finished = true; });
      await Promise.resolve();
      expect(finished).toBe(false);
      expect(existsSync(generation)).toBe(true);
      lease.release();
      await shutdown;
      expect(existsSync(generation)).toBe(false);
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('serializes one user FIFO while different users overlap', async () => {
    const registry = createRegistry();
    const a = registry.acquire({ userKey: 'a' });
    const b = registry.acquire({ userKey: 'b' });
    const a1Started = deferred();
    const a2Started = deferred();
    const b1Started = deferred();
    const releaseA1 = deferred();
    const releaseB1 = deferred();
    const order: string[] = [];

    const a1 = registry.dispatch(a, {
      conversationId: 'conversation-a',
      runId: 'a1',
      execute: async () => {
        order.push('a1:start');
        a1Started.resolve();
        await releaseA1.promise;
        order.push('a1:end');
        return { value: 'a1' };
      },
    });
    const a2 = registry.dispatch(a, {
      conversationId: 'conversation-a',
      runId: 'a2',
      execute: async () => {
        order.push('a2:start');
        a2Started.resolve();
        return { value: 'a2' };
      },
    });
    const b1 = registry.dispatch(b, {
      conversationId: 'conversation-b',
      runId: 'b1',
      execute: async () => {
        order.push('b1:start');
        b1Started.resolve();
        await releaseB1.promise;
        return { value: 'b1' };
      },
    });

    await Promise.all([a1Started.promise, b1Started.promise]);
    expect(order).not.toContain('a2:start');
    releaseA1.resolve();
    await a2Started.promise;
    releaseB1.resolve();
    await expect(Promise.all([a1, a2, b1])).resolves.toEqual(['a1', 'a2', 'b1']);
    expect(order.indexOf('a1:end')).toBeLessThan(order.indexOf('a2:start'));

    a.release();
    b.release();
    await registry.shutdown();
  });

  it('returns deterministic typed errors for per-user and global admission limits', async () => {
    const registry = createRegistry({
      limits: { queuedMutationsPerUser: 1, residentRuntimes: 1 },
    });
    const a = registry.acquire({ userKey: 'a' });
    const release = deferred();
    const started = deferred();
    const a1 = registry.dispatch(a, {
      conversationId: 'c',
      runId: 'a1',
      execute: async () => {
        started.resolve();
        await release.promise;
        return { value: undefined };
      },
    });
    await started.promise;
    const a2 = registry.dispatch(a, {
      conversationId: 'c',
      runId: 'a2',
      execute: async () => ({ value: undefined }),
    });

    await expect(registry.dispatch(a, {
      conversationId: 'c',
      runId: 'a3',
      execute: async () => ({ value: undefined }),
    })).rejects.toSatisfy((error: unknown) => expectHostedCode(error, 'HOSTED_OVERLOADED'));
    expectHostedThrow(
      () => registry.acquire({ userKey: 'b' }),
      'HOSTED_CAPACITY_EXHAUSTED',
    );

    release.resolve();
    await Promise.all([a1, a2]);
    a.release();
    await registry.shutdown();

    vi.useFakeTimers();
    const childLimited = createRegistry({
      admissionTimeoutMs: 20,
      limits: { activeChildren: 1 },
    });
    const childA = childLimited.acquire({ userKey: 'a' });
    const childB = childLimited.acquire({ userKey: 'b' });
    const childStarted = deferred();
    const releaseChild = deferred();
    const active = childLimited.dispatch(childA, {
      conversationId: 'c',
      runId: 'active',
      execute: async () => {
        childStarted.resolve();
        await releaseChild.promise;
        return { value: undefined };
      },
    });
    await childStarted.promise;
    const waiting = childLimited.dispatch(childB, {
      conversationId: 'c',
      runId: 'waiting',
      execute: async () => ({ value: undefined }),
    });
    const waitingExpectation = expect(waiting).rejects.toSatisfy(
      (error: unknown) => expectHostedCode(error, 'HOSTED_CAPACITY_EXHAUSTED'),
    );
    await vi.advanceTimersByTimeAsync(20);
    await waitingExpectation;
    releaseChild.resolve();
    await active;
    childA.release();
    childB.release();
    await childLimited.shutdown();

    const bindingLimited = createRegistry({
      idleEvictionMs: 1,
      limits: { identityBindings: 1 },
    });
    const bound = bindingLimited.acquire({ userKey: 'a' });
    bound.release();
    await vi.advanceTimersByTimeAsync(1);
    expectHostedThrow(
      () => bindingLimited.acquire({ userKey: 'b' }),
      'HOSTED_CAPACITY_EXHAUSTED',
    );
    await bindingLimited.shutdown();
  });

  it('does not allow test or composition options to raise frozen limits', () => {
    expect(() => createRegistry({
      limits: { activeChildren: 33 },
    })).toThrow(/fixed maximum/u);
    expect(() => createRegistry({
      runTimeoutMs: 30 * 60_000 + 1,
    })).toThrow(/fixed maximum/u);
    expect(() => createRegistry({
      limits: { metadataProjectsPerUser: 101 },
    })).toThrow(/fixed maximum/u);
  });

  it('admits bounded per-user metadata growth while allowing updates at the ceiling', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-runtime-registry-metadata-limits-'));
    const counters = { conversation: 0, message: 0, project: 0 };
    const registry = createRegistry({
      runtimeRoot,
      createEntityId(kind) {
        counters[kind] += 1;
        return `${kind}-${counters[kind]}`;
      },
      limits: {
        metadataCommentsPerUser: 1,
        metadataConversationsPerUser: 2,
        metadataMessagesPerUser: 1,
        metadataProjectsPerUser: 1,
        metadataTabsPerUser: 2,
      },
    });
    const a = registry.acquire({ userKey: 'a' });
    const b = registry.acquire({ userKey: 'b' });
    const mutate = (lease: typeof a, operation: Extract<
      Parameters<typeof dispatchHostedRuntimeInternalOperation>[2],
      { kind: 'metadata:mutate' }
    >['operation']) => dispatchHostedRuntimeInternalOperation(registry, lease, {
      kind: 'metadata:mutate',
      operation,
    });
    const target = {
      filePath: 'src/index.html',
      elementId: 'hero',
      selector: '#hero',
      label: 'Hero',
      text: 'Hello',
      position: { x: 0, y: 0, width: 100, height: 100 },
      htmlHint: '<section id="hero">',
    };
    try {
      await expect(mutate(a, {
        kind: 'project.create',
        body: { title: 'A' },
      })).resolves.toHaveProperty('project.id', 'project-1');
      await expect(mutate(a, {
        kind: 'project.create',
        body: { title: 'A2' },
      })).rejects.toSatisfy((error: unknown) => expectHostedCode(error, 'HOSTED_QUOTA_EXCEEDED'));
      await expect(mutate(b, {
        kind: 'project.create',
        body: { title: 'B' },
      })).resolves.toHaveProperty('project.id', 'project-2');

      await expect(mutate(a, {
        kind: 'conversation.create',
        projectId: 'project-1',
        body: {},
      })).resolves.toHaveProperty('conversation.id', 'conversation-1');
      await expect(mutate(a, {
        kind: 'conversation.create',
        projectId: 'project-1',
        body: {},
      })).resolves.toHaveProperty('conversation.id', 'conversation-2');
      await expect(mutate(a, {
        kind: 'conversation.create',
        projectId: 'project-1',
        body: {},
      })).rejects.toSatisfy((error: unknown) => expectHostedCode(error, 'HOSTED_QUOTA_EXCEEDED'));

      const firstMessage = {
        kind: 'message.upsert' as const,
        projectId: 'project-1',
        conversationId: 'conversation-1',
        messageId: 'message-client-1',
        body: { role: 'user' as const, content: 'first' },
      };
      await expect(mutate(a, firstMessage)).resolves.toHaveProperty('message.id', 'message-client-1');
      await expect(mutate(a, {
        ...firstMessage,
        messageId: 'message-client-2',
      })).rejects.toSatisfy((error: unknown) => expectHostedCode(error, 'HOSTED_QUOTA_EXCEEDED'));
      await expect(mutate(a, {
        ...firstMessage,
        body: { role: 'user', content: 'updated' },
      })).resolves.toHaveProperty('message.content', 'updated');

      const firstComment = {
        kind: 'comment.create' as const,
        projectId: 'project-1',
        conversationId: 'conversation-1',
        body: { target, note: 'first' },
      };
      await expect(mutate(a, firstComment)).resolves.toHaveProperty('comment.note', 'first');
      await expect(mutate(a, {
        ...firstComment,
        body: { target: { ...target, elementId: 'other' }, note: 'second' },
      })).rejects.toSatisfy((error: unknown) => expectHostedCode(error, 'HOSTED_QUOTA_EXCEEDED'));
      await expect(mutate(a, {
        ...firstComment,
        body: { target, note: 'updated' },
      })).resolves.toHaveProperty('comment.note', 'updated');

      await expect(mutate(a, {
        kind: 'tabs.put',
        projectId: 'project-1',
        body: {
          tabs: ['src/index.html'],
          active: 'src/index.html',
          browserTabs: [{ id: 'preview-1', label: 'Preview' }],
        },
      })).resolves.toMatchObject({ tabs: ['src/index.html'] });
      await expect(mutate(a, {
        kind: 'tabs.put',
        projectId: 'project-1',
        body: {
          tabs: ['src/index.html', 'src/other.html'],
          active: 'src/index.html',
          browserTabs: [{ id: 'preview-1', label: 'Preview' }],
        },
      })).rejects.toSatisfy((error: unknown) => expectHostedCode(error, 'HOSTED_QUOTA_EXCEEDED'));
    } finally {
      a.release();
      b.release();
      await registry.shutdown();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('charges copied seed messages before creating a conversation', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-runtime-registry-seed-limits-'));
    const counters = { conversation: 0, message: 0, project: 0 };
    const registry = createRegistry({
      runtimeRoot,
      createEntityId(kind) {
        counters[kind] += 1;
        return `${kind}-${counters[kind]}`;
      },
      limits: {
        metadataConversationsPerUser: 2,
        metadataMessagesPerUser: 1,
      },
    });
    const lease = registry.acquire({ userKey: 'a' });
    const mutate = (operation: Extract<
      Parameters<typeof dispatchHostedRuntimeInternalOperation>[2],
      { kind: 'metadata:mutate' }
    >['operation']) => dispatchHostedRuntimeInternalOperation(registry, lease, {
      kind: 'metadata:mutate',
      operation,
    });
    try {
      await mutate({ kind: 'project.create', body: { title: 'A' } });
      await mutate({ kind: 'conversation.create', projectId: 'project-1', body: {} });
      await mutate({
        kind: 'message.upsert',
        projectId: 'project-1',
        conversationId: 'conversation-1',
        messageId: 'message-client-1',
        body: { role: 'user', content: 'seed' },
      });

      await expect(mutate({
        kind: 'conversation.create',
        projectId: 'project-1',
        body: { seedFromConversationId: 'conversation-1' },
      })).rejects.toSatisfy((error: unknown) => expectHostedCode(error, 'HOSTED_QUOTA_EXCEEDED'));
      await expect(dispatchHostedRuntimeInternalOperation(registry, lease, {
        kind: 'metadata:read',
        operation: { kind: 'conversations.list', projectId: 'project-1' },
      })).resolves.toMatchObject({ conversations: [{ id: 'conversation-1' }] });
    } finally {
      lease.release();
      await registry.shutdown();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('refuses to materialize metadata lists already beyond their fixed ceiling', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-runtime-registry-list-limits-'));
    const registry = createRegistry({
      runtimeRoot,
      limits: { metadataProjectsPerUser: 1 },
    });
    const lease = registry.acquire({ userKey: 'a' });
    try {
      const now = Date.now();
      for (const id of ['project-1', 'project-2']) {
        await dispatchHostedRuntimeInternalOperation(registry, lease, {
          kind: 'project:insert',
          conversationId: 'conversation-1',
          project: { id, name: id, createdAt: now, updatedAt: now },
          runId: `insert-${id}`,
        });
      }

      await expect(dispatchHostedRuntimeInternalOperation(registry, lease, {
        kind: 'metadata:read',
        operation: { kind: 'projects.list' },
      })).rejects.toSatisfy((error: unknown) => expectHostedCode(error, 'HOSTED_QUOTA_EXCEEDED'));
    } finally {
      lease.release();
      await registry.shutdown();
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['HOSTED_OVERLOADED', 429],
    ['HOSTED_CAPACITY_EXHAUSTED', 503],
    ['HOSTED_QUOTA_EXCEEDED', 413],
    ['HOSTED_RUNTIME_UNAVAILABLE', 503],
    ['HOSTED_RUN_CANCELED', 409],
    ['HOSTED_RUN_TIMED_OUT', 504],
    ['RETRY_KEY_REUSED', 409],
    ['HOSTED_SHUTDOWN_TIMEOUT', 504],
  ] as const)('maps %s to HTTP %i', (code, status) => {
    expect(statusForError(createApiError(code, 'test'))).toBe(status);
  });

  it('keeps verified session references distinct by conversation', async () => {
    const registry = createRegistry();
    const lease = registry.acquire({ userKey: 'a' });
    const seen: Array<string | null> = [];
    const run = (runId: string, conversationId: string, sessionReference: string) =>
      registry.dispatch(lease, {
        conversationId,
        runId,
        execute: async ({ sessionReference: previous }) => {
          seen.push(previous);
          return { sessionReference, value: runId };
        },
      });

    await run('a1', 'conversation-1', 'session-1');
    await run('a2', 'conversation-2', 'session-2');
    await run('a3', 'conversation-1', 'session-1-next');
    await run('a4', 'conversation-2', 'session-2-next');
    expect(seen).toEqual([null, null, 'session-1', 'session-2']);

    lease.release();
    await registry.shutdown();
  });

  it('rotates provider credentials in the user FIFO and captures them when a run starts', async () => {
    const registry = createRegistry();
    const a = registry.acquire({ userKey: 'a' });
    const b = registry.acquire({ userKey: 'b' });
    await registry.replaceCredential(a, { provider: 'anthropic', key: 'a-old' });
    await registry.replaceCredential(b, { provider: 'vercel-ai-gateway', key: 'b-key' });
    const activeStarted = deferred();
    const releaseActive = deferred();

    const active = registry.dispatch(a, {
      conversationId: 'c',
      runId: 'a-old',
      execute: async ({ credential }) => {
        activeStarted.resolve();
        await releaseActive.promise;
        return { value: credential };
      },
    });
    await activeStarted.promise;
    const rotated = registry.replaceCredential(a, {
      provider: 'vercel-ai-gateway',
      key: 'a-new',
    });
    const afterRotation = registry.dispatch(a, {
      conversationId: 'c',
      runId: 'a-new',
      execute: async ({ credential }) => ({ value: credential }),
    });
    await expect(registry.dispatch(b, {
      conversationId: 'c',
      runId: 'b',
      execute: async ({ credential }) => ({ value: credential }),
    })).resolves.toEqual({ provider: 'vercel-ai-gateway', key: 'b-key' });
    expect(registry.credentialStatus(a)).toEqual({ configured: true, provider: 'anthropic' });

    releaseActive.resolve();
    await expect(active).resolves.toEqual({ provider: 'anthropic', key: 'a-old' });
    await expect(rotated).resolves.toEqual({ configured: true, provider: 'vercel-ai-gateway' });
    await expect(afterRotation).resolves.toEqual({ provider: 'vercel-ai-gateway', key: 'a-new' });

    a.release();
    b.release();
    await registry.shutdown();
  });

  it('rejects malformed credentials and clears them on execution failure and eviction', async () => {
    vi.useFakeTimers();
    const registry = createRegistry({ idleEvictionMs: 25 });
    const lease = registry.acquire({ userKey: 'a' });
    for (const key of ['', 'line\nbreak', 'nul\0key', 'x'.repeat(16 * 1024 + 1)]) {
      await expect(registry.replaceCredential(lease, {
        provider: 'anthropic',
        key,
      })).rejects.toThrow(/credential/u);
    }
    await registry.replaceCredential(lease, { provider: 'anthropic', key: 'secret' });
    await expect(registry.dispatch(lease, {
      conversationId: 'c',
      runId: 'crash',
      execute: async () => { throw new Error('worker failed'); },
    })).rejects.toThrow('worker failed');
    expect(registry.credentialStatus(lease)).toEqual({ configured: false, provider: null });

    await registry.replaceCredential(lease, { provider: 'anthropic', key: 'secret' });
    lease.release();
    await vi.advanceTimersByTimeAsync(25);
    const recreated = registry.acquire({ userKey: 'a' });
    expect(registry.credentialStatus(recreated)).toEqual({ configured: false, provider: null });
    recreated.release();
    await registry.shutdown();
  });

  it('retires server-owned generation resources on idle eviction', async () => {
    vi.useFakeTimers();
    const retired: Array<{ generation: number; userKey: string }> = [];
    const registry = createRegistry({
      idleEvictionMs: 25,
      onGenerationRetired: (binding) => retired.push(binding),
    });
    const lease = registry.acquire({ userKey: 'a' });
    await waitForReady(registry, lease);
    const generation = lease.generation;
    lease.release();

    await vi.advanceTimersByTimeAsync(25);

    expect(retired).toEqual([{ generation, userKey: 'a' }]);
    await registry.shutdown();
  });

  it('bounds retained session references before admitting another conversation', async () => {
    const registry = createRegistry({
      limits: {
        sessionReferenceBytesPerUser: 4,
        sessionReferencesPerUser: 1,
      },
    });
    const lease = registry.acquire({ userKey: 'a' });
    await registry.dispatch(lease, {
      conversationId: 'conversation-1',
      runId: 'a1',
      execute: async () => ({ sessionReference: '1234', value: undefined }),
    });
    let executed = false;
    await expect(registry.dispatch(lease, {
      conversationId: 'conversation-2',
      runId: 'a2',
      execute: async () => {
        executed = true;
        return { sessionReference: 'x', value: undefined };
      },
    })).rejects.toSatisfy(
      (error: unknown) => expectHostedCode(error, 'HOSTED_QUOTA_EXCEEDED'),
    );
    expect(executed).toBe(false);
    await expect(registry.dispatch(lease, {
      conversationId: 'conversation-1',
      runId: 'a3',
      execute: async () => ({ sessionReference: '12345', value: undefined }),
    })).rejects.toSatisfy(
      (error: unknown) => expectHostedCode(error, 'HOSTED_QUOTA_EXCEEDED'),
    );
    await expect(registry.dispatch(lease, {
      conversationId: 'conversation-1',
      runId: 'a4',
      execute: async ({ sessionReference }) => ({ value: sessionReference }),
    })).resolves.toBe('1234');

    lease.release();
    await registry.shutdown();
  });

  it('releases the lane after cancellation, timeout, and child crash', async () => {
    vi.useFakeTimers();
    const registry = createRegistry({ runTimeoutMs: 50 });
    const lease = registry.acquire({ userKey: 'a' });
    await registry.replaceCredential(lease, { provider: 'anthropic', key: 'secret' });
    const cancelStarted = deferred();
    const cancelRun = registry.dispatch(lease, {
      conversationId: 'c',
      runId: 'cancel',
      execute: ({ signal }) => new Promise<{ value: string }>((resolve) => {
        cancelStarted.resolve();
        signal.addEventListener('abort', () => resolve({ value: 'ignored' }), { once: true });
      }),
    });
    await cancelStarted.promise;
    expect(registry.cancel({
      generation: lease.generation,
      runId: 'cancel',
      userKey: lease.userKey,
    }, 'user_requested')).toBe(true);
    await expect(cancelRun).rejects.toSatisfy(
      (error: unknown) => expectHostedCode(error, 'HOSTED_RUN_CANCELED'),
    );
    expect(registry.credentialStatus(lease)).toEqual({ configured: true, provider: 'anthropic' });
    await expect(registry.dispatch(lease, {
      conversationId: 'c',
      runId: 'after-cancel',
      execute: async () => ({ value: 'after-cancel' }),
    })).resolves.toBe('after-cancel');

    const timeoutRun = registry.dispatch(lease, {
      conversationId: 'c',
      runId: 'timeout',
      execute: ({ signal }) => new Promise<{ value: string }>((resolve) => {
        signal.addEventListener('abort', () => resolve({ value: 'ignored' }), { once: true });
      }),
    });
    const timeoutExpectation = expect(timeoutRun).rejects.toSatisfy(
      (error: unknown) => expectHostedCode(error, 'HOSTED_RUN_TIMED_OUT'),
    );
    await vi.advanceTimersByTimeAsync(50);
    await timeoutExpectation;
    expect(registry.credentialStatus(lease)).toEqual({ configured: false, provider: null });

    await expect(registry.dispatch(lease, {
      conversationId: 'c',
      runId: 'crash',
      execute: async () => { throw new Error('child crashed'); },
    })).rejects.toThrow('child crashed');
    await expect(registry.dispatch(lease, {
      conversationId: 'c',
      runId: 'after-crash',
      execute: async () => ({ value: 'after-crash' }),
    })).resolves.toBe('after-crash');

    lease.release();
    await registry.shutdown();
  });

  it('binds identities injectively and derives path-safe storage keys', async () => {
    const registry = createRegistry();
    const first = registry.acquire({ userKey: 'issuer\u0000subject/../A' });
    expect(first.storageKey).toMatch(/^od1_[0-9a-f]{64}$/u);
    first.release();
    await registry.shutdown();

    const colliding = createRegistry({ deriveStorageKey: () => `od1_${'0'.repeat(64)}` });
    const a = colliding.acquire({ userKey: 'a' });
    expectHostedThrow(
      () => colliding.acquire({ userKey: 'b' }),
      'HOSTED_AUTH_INVALID',
    );
    a.release();
    await colliding.shutdown();
  });

  it('strong leases block eviction, weak leases do not, and stale controls miss recreated runtimes', async () => {
    vi.useFakeTimers();
    const registry = createRegistry({ idleEvictionMs: 25 });
    const strong = registry.acquire({ userKey: 'a' });
    const weak = registry.acquire({ userKey: 'a' }, 'weak');
    const firstGeneration = strong.generation;

    await vi.advanceTimersByTimeAsync(100);
    const stillLive = registry.acquire({ userKey: 'a' });
    expect(stillLive.generation).toBe(firstGeneration);
    strong.release();
    stillLive.release();
    await vi.advanceTimersByTimeAsync(25);

    const recreated = registry.acquire({ userKey: 'a' });
    expect(recreated.generation).toBeGreaterThan(firstGeneration);
    expect(registry.cancel({
      generation: firstGeneration,
      runId: 'same-run-id',
      userKey: 'a',
    })).toBe(false);

    weak.release();
    recreated.release();
    await registry.shutdown();
  });

  it('allows a weak lease to own an attached event stream', async () => {
    const registry = createRegistry();
    const strong = registry.acquire({ userKey: 'a' });
    await waitForReady(registry, strong);
    const weak = registry.acquire({ userKey: 'a' }, 'weak');
    strong.release();
    try {
      const attached = await dispatchHostedRuntimeInternalOperation(registry, weak, {
        kind: 'journal:attach',
        channel: { kind: 'owner' },
        response: new PassThrough(),
      });
      expect(attached).toMatchObject({ kind: 'attached' });
      if (
        attached != null
        && typeof attached === 'object'
        && 'close' in attached
        && typeof attached.close === 'function'
      ) attached.close();
    } finally {
      weak.release();
      await registry.shutdown();
    }
  });

  it('shutdown cancels work, rejects queued turns, and waits for strong leases', async () => {
    const registry = createRegistry();
    const lease = registry.acquire({ userKey: 'a' });
    await registry.replaceCredential(lease, { provider: 'anthropic', key: 'secret' });
    const started = deferred();
    const active = registry.dispatch(lease, {
      conversationId: 'c',
      runId: 'active',
      execute: ({ signal }) => new Promise<{ value: string }>((resolve) => {
        started.resolve();
        signal.addEventListener('abort', () => resolve({ value: 'ignored' }), { once: true });
      }),
    });
    await started.promise;
    const queued = registry.dispatch(lease, {
      conversationId: 'c',
      runId: 'queued',
      execute: async () => ({ value: 'never' }),
    });
    let shutdownFinished = false;
    const shutdown = registry.shutdown().then(() => { shutdownFinished = true; });
    expect(registry.credentialStatus(lease)).toEqual({ configured: false, provider: null });

    await expect(active).rejects.toSatisfy(
      (error: unknown) => expectHostedCode(error, 'HOSTED_RUN_CANCELED'),
    );
    await expect(queued).rejects.toSatisfy(
      (error: unknown) => expectHostedCode(error, 'HOSTED_RUN_CANCELED'),
    );
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    lease.release();
    await shutdown;
    expectHostedThrow(
      () => registry.acquire({ userKey: 'a' }),
      'HOSTED_RUNTIME_UNAVAILABLE',
    );
  });
});

function generationRoot(runtimeRoot: string, storageKey: string): string {
  const storageRoot = join(runtimeRoot, 'live', storageKey);
  const generations = readdirSync(storageRoot).filter((name) => name.startsWith('generation-'));
  expect(generations).toHaveLength(1);
  return join(storageRoot, generations[0]!);
}

function waitForReady(
  registry: ReturnType<typeof createHostedRuntimeRegistry>,
  lease: Parameters<typeof dispatchHostedRuntimeInternalOperation>[1],
): Promise<unknown> {
  return dispatchHostedRuntimeInternalOperation(registry, lease, {
    kind: 'project:get',
    projectId: '__readiness__',
  });
}

function insertProjectForTest(
  storage: ReturnType<typeof createHostedRuntimeStorage>,
  id: string,
  name: string,
): void {
  const now = Date.now();
  insertProject(storage.database, { id, name, createdAt: now, updatedAt: now });
}

function filesBelow(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = join(root, entry.name);
    return entry.isDirectory() ? filesBelow(file) : [file];
  });
}
