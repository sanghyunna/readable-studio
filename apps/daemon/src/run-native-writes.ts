import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { ProjectCheckpointService } from './project-checkpoints.js';
import { subscribe } from './project-watchers.js';
import { projectFileWriteKey, resolveProjectDir, resolveSafeReal, withProjectFileWriteLock, type ProjectFileWriteGuard } from './projects.js';

export interface NativeWriteConflict {
  readonly path: string;
  readonly kind: 'native-overwrite';
  readonly userSha: string;
  readonly observedSha: string | null;
  readonly sidecar?: string;
  readonly checkpointId?: string;
}
interface UserSave {
  readonly path: string;
  readonly sha: string;
  readonly blobRef: string;
  readonly at: number;
}
export interface NativeWriteRun {
  readonly id: string;
  readonly projectId: string;
  readonly conversationId: string | null;
  readonly assistantMessageId: string | null;
  readonly projectMetadata: unknown;
  readonly projectFileVersions: Map<string, string>;
  readonly writerLedger: Map<string, Set<string>>;
  readonly userSaves: Map<string, UserSave[]>;
  readonly nativeConflicts: Map<string, NativeWriteConflict>;
  conflict: NativeWriteConflict | null;
}
const hash = (body: Buffer) => createHash('sha256').update(body).digest('hex');
async function diskHash(target: string): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    try { return hash(await readFile(target)); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error)) throw error;
      if (error.code === 'ENOENT') return null;
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(String(error.code)) || attempt === 4) throw error;
      await setImmediate();
    }
  }
}

// The run's mutable ledger is independent of its bounded SSE event history.
export async function protectNativeWrites(input: {
  readonly run: NativeWriteRun;
  readonly projectsRoot: string;
  readonly checkpoints: ProjectCheckpointService;
  readonly onConflict: (conflict: NativeWriteConflict) => void;
  readonly onError: (error: unknown) => void;
}) {
  const { run, checkpoints } = input;
  const dir = resolveProjectDir(input.projectsRoot, run.projectId, run.projectMetadata);
  let pending = Promise.resolve();
  let stopped = false;

  const inspect = async (name: string) => {
    const target = await resolveSafeReal(dir, name);
    const key = projectFileWriteKey(target);
    if (!run.projectFileVersions.has(key)) return;
    await withProjectFileWriteLock(key, async () => {
      const save = run.userSaves.get(key)?.at(-1);
      if (!save) return;
      const observedSha = await diskHash(target);
      if (observedSha !== null && run.writerLedger.get(key)?.has(observedSha)) return;
      const previous = run.nativeConflicts.get(key);
      if (previous?.observedSha === observedSha && previous.userSha === save.sha) return;
      const conflict: NativeWriteConflict = { path: save.path, kind: 'native-overwrite', userSha: save.sha, observedSha };
      run.nativeConflicts.set(key, conflict);
      run.conflict = conflict;
      input.onConflict(conflict);
    });
  };
  const watcher = subscribe(input.projectsRoot, run.projectId, event => {
    if (stopped) return;
    pending = pending.then(() => inspect(event.path)).catch(input.onError);
  }, { metadata: run.projectMetadata });

  const onWrite: NonNullable<ProjectFileWriteGuard['onWrite']> = async write => {
    if (!run.projectFileVersions.has(write.key)) return;
    const sha = hash(write.body);
    if (write.userSave) {
      const blobRef = await checkpoints.storeUserSave(write.body);
      const saves = run.userSaves.get(write.key) ?? [];
      saves.push({ path: write.path, sha, blobRef, at: Date.now() });
      run.userSaves.set(write.key, saves);
    }
    const ledger = run.writerLedger.get(write.key) ?? new Set<string>();
    ledger.add(sha);
    run.writerLedger.set(write.key, ledger);
  };
  const dispose = async () => {
    stopped = true;
    await watcher.unsubscribe();
    await pending;
  };
  const finish = async () => {
    await dispose();
    // Chokidar coalesces writes. An immediate adapter exit must not evade detection.
    for (const saves of run.userSaves.values()) {
      const save = saves.at(-1);
      if (save) await inspect(save.path);
    }
    for (const [key, conflict] of run.nativeConflicts) {
      await withProjectFileWriteLock(key, async () => {
        const target = await resolveSafeReal(dir, conflict.path);
        const current = await diskHash(target);
        if (current !== null && run.writerLedger.get(key)?.has(current)) return;
        if (current !== conflict.observedSha) return;
        const save = run.userSaves.get(key)?.at(-1);
        if (!save || save.sha !== conflict.userSha) return;
        const body = await checkpoints.readUserSave(save.blobRef, save.sha);
        const ext = path.extname(conflict.path);
        const sidecar = `${conflict.path.slice(0, ext ? -ext.length : undefined)}.agent-${run.id.slice(0, 8)}${ext}`;
        if (current !== null) await rename(target, await resolveSafeReal(dir, sidecar));
        await writeFile(target, body);
        run.writerLedger.get(key)?.add(save.sha);
        const recovered = { ...conflict, ...(current !== null ? { sidecar } : {}) };
        run.nativeConflicts.set(key, recovered);
        run.conflict = recovered;
      });
    }
    if (run.nativeConflicts.size > 0) {
      const checkpoint = await checkpoints.captureCheckpoint({ projectId: run.projectId,
        conversationId: run.conversationId, messageId: run.assistantMessageId, runId: run.id, kind: 'after_run_unfinalized' });
      for (const [key, conflict] of run.nativeConflicts) {
        const finalized = { ...conflict, checkpointId: checkpoint.id };
        run.nativeConflicts.set(key, finalized);
        run.conflict = finalized;
        input.onConflict(finalized);
      }
    }
    run.userSaves.clear();
    run.writerLedger.clear();
  };
  return { onWrite, finish, dispose, ready: watcher.ready };
}
