import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getProject,
  insertConversation,
  insertProject,
  upsertAgentSession,
} from '../src/db.js';
import { createHostedRuntimeStorage } from '../src/hosted-runtime-storage.js';
import {
  createHostedSnapshotStore,
  type HostedSnapshotFailpoint,
} from '../src/hosted-snapshots.js';

const execFileAsync = promisify(execFile);
const publisherFixture = fileURLToPath(
  new URL('./fixtures/hosted-snapshot-publisher.ts', import.meta.url),
);
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const tempRoots: string[] = [];
const identity = {
  storageKey: 'od1_fc95297aa4f56781f0decb7d4bf59b1447f09b3611039b80188b1c6beb03ee6a',
  userKey: 'user-a',
} as const;

const failureCases = [
  ['after-session-copy', 'baseline'],
  ['after-database-backup', 'baseline'],
  ['after-payload-copy', 'baseline'],
  ['after-manifest-write', 'baseline'],
  ['before-completion-marker', 'baseline'],
  ['after-completion-marker', 'baseline'],
  ['after-version-rename', 'candidate'],
  ['after-latest-write', 'candidate'],
  ['after-retention-prune', 'candidate'],
] as const satisfies ReadonlyArray<readonly [HostedSnapshotFailpoint, string]>;

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('hosted snapshot process-crash recovery', () => {
  it.each(failureCases)(
    'restores the newest complete version after a publisher is killed at %s',
    async (failpoint, expectedState) => {
      const runtimeRoot = mkdtempSync(path.join(tmpdir(), 'readable-hosted-snapshot-kill-'));
      tempRoots.push(runtimeRoot);
      const baselineStorage = createHostedRuntimeStorage({ identity, runtimeRoot });
      const now = Date.now();
      insertProject(baselineStorage.database, {
        createdAt: now,
        id: 'snapshot-project',
        name: 'baseline',
        updatedAt: now,
      });
      insertConversation(baselineStorage.database, {
        createdAt: now,
        id: 'snapshot-conversation',
        projectId: 'snapshot-project',
        updatedAt: now,
      });
      const projectRoot = path.join(
        baselineStorage.roots.projectsRoot,
        'snapshot-project',
      );
      const sessionPath = path.join(
        baselineStorage.roots.sessionsRoot,
        'session.jsonl',
      );
      mkdirSync(projectRoot);
      writeFileSync(
        path.join(projectRoot, 'state.txt'),
        'baseline',
        'utf8',
      );
      writeFileSync(
        sessionPath,
        `${JSON.stringify({ cwd: projectRoot, type: 'session' })}\n`,
        'utf8',
      );
      upsertAgentSession(baselineStorage.database, {
        agentId: 'pi',
        conversationId: 'snapshot-conversation',
        sessionId: sessionPath,
      });
      const snapshots = createHostedSnapshotStore({ identity, runtimeRoot });
      await snapshots.publish({ quiesce: async () => {}, storage: baselineStorage });
      baselineStorage.close();

      await expect(execFileAsync(
        process.execPath,
        [
          '--import',
          'tsx',
          publisherFixture,
          runtimeRoot,
          identity.userKey,
          identity.storageKey,
          failpoint,
        ],
        { cwd: repoRoot, timeout: 15_000 },
      )).rejects.toBeDefined();
      expect(readFileSync(path.join(runtimeRoot, '.failpoint-hit'), 'utf8')).toBe(
        failpoint,
      );
      expect(existsSync(path.join(runtimeRoot, '.publisher-completed'))).toBe(false);

      const restored = await snapshots.restore();
      expect(restored).not.toBeNull();
      if (restored == null) return;

      try {
        expect(readFileSync(
          path.join(
            restored.storage.roots.projectsRoot,
            'snapshot-project',
            'state.txt',
          ),
          'utf8',
        )).toBe(expectedState);
        expect(getProject(restored.storage.database, 'snapshot-project')?.name).toBe(
          expectedState,
        );
      } finally {
        restored.storage.close();
      }
    },
    30_000,
  );
});
