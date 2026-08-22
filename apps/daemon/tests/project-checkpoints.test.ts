import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  closeDatabase,
  getProjectCheckpoint,
  insertConversation,
  insertProject,
  listMessages,
  openDatabase,
  updateProject,
  upsertMessage,
} from '../src/db.js';
import { createProjectCheckpointService } from '../src/project-checkpoints.js';

const tempRoots: string[] = [];

afterEach(async () => {
  closeDatabase();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'readable-project-checkpoints-'));
  tempRoots.push(root);
  const dataDir = path.join(root, 'data');
  const projectsRoot = path.join(root, 'projects');
  const projectId = 'project-1';
  const projectDir = path.join(projectsRoot, projectId);
  await mkdir(projectDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const db = openDatabase(dataDir, { dataDir });
  const now = Date.now();
  insertProject(db, { id: projectId, name: 'P', createdAt: now, updatedAt: now });
  insertConversation(db, {
    id: 'conv-1',
    projectId,
    title: 'C',
    createdAt: now,
    updatedAt: now,
  });
  const service = createProjectCheckpointService({ db, dataDir, projectsRoot });
  return { db, service, dataDir, projectsRoot, projectId, projectDir };
}

async function writeFixtureFile(projectDir: string, relativePath: string, content: string | Buffer) {
  const target = path.join(projectDir, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function listTree(root: string): Promise<string[]> {
  return readdir(root, { recursive: true }).then((entries) => entries.sort(), () => []);
}

function seedConversationMessages(db: ReturnType<typeof openDatabase>) {
  for (const message of [
    { id: 'user-1', role: 'user', content: 'first' },
    { id: 'assistant-1', role: 'assistant', content: 'first answer' },
    { id: 'user-2', role: 'user', content: 'second' },
    { id: 'assistant-2', role: 'assistant', content: 'second answer' },
  ]) {
    upsertMessage(db, 'conv-1', message);
  }
}

async function readManifest(db: ReturnType<typeof openDatabase>, checkpointId: string) {
  const row = getProjectCheckpoint(db, checkpointId);
  if (!row) throw new Error(`missing checkpoint ${checkpointId}`);
  return JSON.parse(await readFile(row.manifestPath, 'utf8')) as {
    schemaVersion: 1;
    projectId: string;
    checkpointId: string;
    files: Array<{ path: string; hash: string; blob: string }>;
  };
}

describe('project checkpoint capture', () => {
  it('captures hashes and content-addressed blobs, includes .live-artifacts, and excludes ignored dirs', async () => {
    const { db, service, dataDir, projectId, projectDir } = await makeFixture();
    await writeFixtureFile(projectDir, 'src/app.ts', 'same bytes');
    await writeFixtureFile(projectDir, 'docs/copy.txt', 'same bytes');
    await writeFixtureFile(projectDir, '.live-artifacts/la-1/artifact.json', '{"title":"Live"}\n');
    await writeFixtureFile(projectDir, 'node_modules/pkg/index.js', 'ignored');
    await writeFixtureFile(projectDir, '.git/config', '[core]\n');
    await writeFixtureFile(projectDir, '.readable-studio/app.sqlite', 'ignored daemon data');
    await writeFixtureFile(projectDir, 'dist/bundle.js', 'ignored build output');

    const checkpoint = await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      runId: 'run-1',
      kind: 'after_message',
    });
    const manifest = await readManifest(db, checkpoint.id);

    expect(checkpoint).toMatchObject({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      runId: 'run-1',
      kind: 'after_message',
      fileCount: 3,
    });
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      projectId,
      checkpointId: checkpoint.id,
    });
    expect(manifest.files.map((file) => file.path).sort()).toEqual([
      '.live-artifacts/la-1/artifact.json',
      'docs/copy.txt',
      'src/app.ts',
    ]);
    expect(manifest.files.map((file) => file.path).join('\n')).not.toContain('node_modules');
    expect(manifest.files.map((file) => file.path).join('\n')).not.toContain('.git');
    expect(manifest.files.map((file) => file.path).join('\n')).not.toContain('.readable-studio');
    expect(manifest.files.map((file) => file.path).join('\n')).not.toContain('dist');

    const duplicateHashes = manifest.files
      .filter((file) => file.path === 'src/app.ts' || file.path === 'docs/copy.txt')
      .map((file) => file.hash);
    expect(new Set(duplicateHashes).size).toBe(1);
    const blobPath = manifest.files.find((file) => file.path === 'src/app.ts')?.blob;
    expect(blobPath).toBeTruthy();
    await expect(stat(path.join(dataDir, 'checkpoints', 'blobs', blobPath!))).resolves.toMatchObject({});
  });

  it('does not follow a symlinked directory outside the project root', async () => {
    const { db, service, projectId, projectDir } = await makeFixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'readable-checkpoint-outside-'));
    tempRoots.push(outside);
    await writeFixtureFile(outside, 'secret.txt', 'outside');
    await fsSymlinkDir(outside, path.join(projectDir, 'linked-outside'));
    await writeFixtureFile(projectDir, 'safe.txt', 'inside');

    const checkpoint = await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      kind: 'after_message',
    });
    const manifest = await readManifest(db, checkpoint.id);

    expect(manifest.files.map((file) => file.path)).toEqual(['safe.txt']);
  });
});

describe('project checkpoint restore', () => {
  it('requires a valid approved revision before an agent restore can mutate state', async () => {
    const { db, service, projectId, projectDir } = await makeFixture();
    seedConversationMessages(db);
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: 'first answer',
      runId: 'run-1',
    });
    await writeFixtureFile(projectDir, 'index.html', 'target');
    const target = await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      runId: 'run-1',
      kind: 'before_run',
    });
    await writeFixtureFile(projectDir, 'index.html', 'current');
    const checkpointCount = (db.prepare('SELECT COUNT(*) AS count FROM project_checkpoints').get() as { count: number }).count;

    await expect(service.rollback({
      projectId,
      conversationId: 'conv-1',
      targetMessageId: 'assistant-1',
      targetCheckpointId: target.id,
      mode: 'files_only',
      conflictPolicy: 'overwrite',
      runId: 'run-1',
      actor: 'agent',
    })).rejects.toMatchObject({ status: 400, code: 'BAD_REQUEST' });
    await expect(service.rollback({
      projectId,
      conversationId: 'conv-1',
      targetMessageId: 'assistant-1',
      targetCheckpointId: target.id,
      mode: 'files_only',
      conflictPolicy: 'overwrite',
      runId: 'run-1',
      actor: 'agent',
      expectedRevision: 'not-a-revision',
    })).rejects.toMatchObject({ status: 400, code: 'BAD_REQUEST' });
    expect(await readFile(path.join(projectDir, 'index.html'), 'utf8')).toBe('current');
    expect((db.prepare('SELECT COUNT(*) AS count FROM project_checkpoints').get() as { count: number }).count).toBe(checkpointCount);
    expect((db.prepare('SELECT COUNT(*) AS count FROM project_checkpoint_restores').get() as { count: number }).count).toBe(0);
  });

  it('atomically rejects an approved agent plan when the working tree revision changes', async () => {
    const { db, service, dataDir, projectId, projectDir } = await makeFixture();
    seedConversationMessages(db);
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: 'first answer',
      runId: 'run-1',
    });
    await writeFixtureFile(projectDir, 'index.html', 'target');
    const target = await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      runId: 'run-1',
      kind: 'before_run',
    });
    await writeFixtureFile(projectDir, 'index.html', 'approved current');
    const prepared = await service.prepareAgentRollback({
      projectId,
      conversationId: 'conv-1',
      targetMessageId: 'assistant-1',
      targetCheckpointId: target.id,
      runId: 'run-1',
    });
    expect(prepared).toMatchObject({
      targetCheckpointId: target.id,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      fileChanges: { added: 0, modified: 1, deleted: 0, unchanged: 0 },
    });

    await writeFixtureFile(projectDir, 'index.html', 'changed after approval');
    const blobTree = await listTree(path.join(dataDir, 'checkpoints', 'blobs'));
    const checkpointCount = (db.prepare('SELECT COUNT(*) AS count FROM project_checkpoints').get() as { count: number }).count;
    const restoreCount = (db.prepare('SELECT COUNT(*) AS count FROM project_checkpoint_restores').get() as { count: number }).count;
    await expect(service.rollback({
      projectId,
      conversationId: 'conv-1',
      targetMessageId: 'assistant-1',
      targetCheckpointId: target.id,
      mode: 'files_only',
      conflictPolicy: 'overwrite',
      runId: 'run-1',
      actor: 'agent',
      approvalRequestId: 'approval-1',
      expectedRevision: prepared.revision,
    })).rejects.toMatchObject({ status: 409, code: 'ROLLBACK_PLAN_CHANGED' });
    expect(await readFile(path.join(projectDir, 'index.html'), 'utf8')).toBe('changed after approval');
    expect((db.prepare('SELECT COUNT(*) AS count FROM project_checkpoints').get() as { count: number }).count).toBe(checkpointCount);
    expect((db.prepare('SELECT COUNT(*) AS count FROM project_checkpoint_restores').get() as { count: number }).count).toBe(restoreCount);
    expect(await listTree(path.join(dataDir, 'checkpoints', 'blobs'))).toEqual(blobTree);

    const retry = await service.prepareAgentRollback({
      projectId,
      conversationId: 'conv-1',
      targetMessageId: 'assistant-1',
      targetCheckpointId: target.id,
      runId: 'run-1',
    });
    const restored = await service.rollback({
      projectId,
      conversationId: 'conv-1',
      targetMessageId: 'assistant-1',
      targetCheckpointId: target.id,
      mode: 'files_only',
      conflictPolicy: 'overwrite',
      runId: 'run-1',
      actor: 'agent',
      approvalRequestId: 'approval-2',
      expectedRevision: retry.revision,
    });
    expect(restored).toMatchObject({ actor: 'agent', safetyCheckpointId: expect.any(String) });
    expect(await readFile(path.join(projectDir, 'index.html'), 'utf8')).toBe('target');
    const safetyManifest = await readManifest(db, restored.safetyCheckpointId!);
    const safetyFile = safetyManifest.files.find((file) => file.path === 'index.html');
    expect(await readFile(path.join(dataDir, 'checkpoints', 'blobs', safetyFile!.blob), 'utf8'))
      .toBe('changed after approval');
  });

  it.each(['chat_only', 'files_and_chat'] as const)(
    'rejects agent %s rollback without deleting chat',
    async (mode) => {
      const { db, service, projectId } = await makeFixture();
      seedConversationMessages(db);
      upsertMessage(db, 'conv-1', {
        id: 'assistant-1',
        role: 'assistant',
        content: 'first answer',
        runId: 'run-1',
      });

      await expect(service.rollback({
        projectId,
        conversationId: 'conv-1',
        targetMessageId: 'assistant-1',
        mode,
        actor: 'agent',
        runId: 'run-1',
      })).rejects.toMatchObject({
        status: 400,
        code: 'BAD_REQUEST',
      });
      expect(listMessages(db, 'conv-1').map((message) => message.id)).toEqual([
        'user-1',
        'assistant-1',
        'user-2',
        'assistant-2',
      ]);
    },
  );

  it('uses only the run before_run checkpoint for agent rollback while user inference stays unchanged', async () => {
    const { db, service, projectId, projectDir } = await makeFixture();
    seedConversationMessages(db);
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: 'first answer',
      runId: 'run-1',
    });

    await writeFixtureFile(projectDir, 'index.html', 'before run');
    const beforeRun = await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      runId: 'run-1',
      kind: 'before_run',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFixtureFile(projectDir, 'index.html', 'after message');
    await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      runId: 'run-1',
      kind: 'after_message',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFixtureFile(projectDir, 'index.html', 'after run');
    const afterRun = await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      runId: 'run-1',
      kind: 'after_run_unfinalized',
    });
    await writeFixtureFile(projectDir, 'index.html', 'current');

    const prepared = await service.prepareAgentRollback({
      projectId,
      conversationId: 'conv-1',
      targetMessageId: 'assistant-1',
      targetCheckpointId: beforeRun.id,
      runId: 'run-1',
    });

    const agentRestore = await service.rollback({
      projectId,
      conversationId: 'conv-1',
      targetMessageId: 'assistant-1',
      mode: 'files_only',
      conflictPolicy: 'overwrite',
      actor: 'agent',
      runId: 'run-1',
      expectedRevision: prepared.revision,
    });
    expect(agentRestore.restoredCheckpointId).toBe(beforeRun.id);
    expect(await readFile(path.join(projectDir, 'index.html'), 'utf8')).toBe('before run');

    await writeFixtureFile(projectDir, 'index.html', 'current again');
    const userRestore = await service.rollback({
      projectId,
      conversationId: 'conv-1',
      targetMessageId: 'assistant-1',
      mode: 'files_only',
      conflictPolicy: 'overwrite',
    });
    expect(userRestore.restoredCheckpointId).toBe(afterRun.id);
    expect(await readFile(path.join(projectDir, 'index.html'), 'utf8')).toBe('after run');
  });

  it.each(['after_message', 'after_run_unfinalized'] as const)(
    'rejects an explicit same-run %s checkpoint for agent rollback',
    async (kind) => {
      const { db, service, projectId, projectDir } = await makeFixture();
      seedConversationMessages(db);
      upsertMessage(db, 'conv-1', {
        id: 'assistant-1',
        role: 'assistant',
        content: 'first answer',
        runId: 'run-1',
      });
      await writeFixtureFile(projectDir, 'index.html', 'post-edit');
      const checkpoint = await service.captureCheckpoint({
        projectId,
        conversationId: 'conv-1',
        messageId: 'assistant-1',
        runId: 'run-1',
        kind,
      });
      await writeFixtureFile(projectDir, 'index.html', 'current');

      await expect(service.rollback({
        projectId,
        conversationId: 'conv-1',
        targetMessageId: 'assistant-1',
        targetCheckpointId: checkpoint.id,
        mode: 'files_only',
        conflictPolicy: 'overwrite',
        actor: 'agent',
        runId: 'run-1',
      })).rejects.toMatchObject({
        status: 404,
        code: 'CHECKPOINT_NOT_FOUND',
      });
      expect(await readFile(path.join(projectDir, 'index.html'), 'utf8')).toBe('current');
    },
  );

  it('rejects a before_restore safety checkpoint as an agent restore target', async () => {
    const { db, service, projectId, projectDir } = await makeFixture();
    seedConversationMessages(db);
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: 'first answer',
      runId: 'run-1',
    });
    await writeFixtureFile(projectDir, 'index.html', 'before');
    const target = await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      runId: 'run-1',
      kind: 'after_message',
    });
    await writeFixtureFile(projectDir, 'index.html', 'after');
    const manual = await service.rollback({
      projectId,
      conversationId: 'conv-1',
      targetMessageId: 'assistant-1',
      targetCheckpointId: target.id,
      mode: 'files_only',
      conflictPolicy: 'overwrite',
    });

    await expect(service.rollback({
      projectId,
      conversationId: 'conv-1',
      targetMessageId: 'assistant-1',
      targetCheckpointId: manual.safetyCheckpointId!,
      mode: 'files_only',
      conflictPolicy: 'overwrite',
      actor: 'agent',
      runId: 'run-1',
    })).rejects.toMatchObject({
      status: 404,
      code: 'CHECKPOINT_NOT_FOUND',
    });
  });

  it('rejects an agent checkpoint from a different run', async () => {
    const { db, service, projectId, projectDir } = await makeFixture();
    seedConversationMessages(db);
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: 'first answer',
      runId: 'run-1',
    });
    await writeFixtureFile(projectDir, 'index.html', 'before');
    const checkpoint = await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      runId: 'other-run',
      kind: 'after_message',
    });

    await expect(service.rollback({
      projectId,
      conversationId: 'conv-1',
      targetMessageId: 'assistant-1',
      targetCheckpointId: checkpoint.id,
      mode: 'files_only',
      actor: 'agent',
      runId: 'run-1',
    })).rejects.toMatchObject({
      status: 403,
      code: 'ROLLBACK_RUN_MISMATCH',
    });
  });

  it('rejects an explicit checkpoint id that does not belong to the target message', async () => {
    const { db, service, projectId, projectDir } = await makeFixture();
    seedConversationMessages(db);
    await writeFixtureFile(projectDir, 'index.html', '<h1>first</h1>');
    const first = await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      kind: 'after_message',
    });
    await writeFixtureFile(projectDir, 'index.html', '<h1>second</h1>');

    await expect(
      service.rollback({
        projectId,
        conversationId: 'conv-1',
        targetMessageId: 'assistant-2',
        targetCheckpointId: first.id,
        mode: 'files_only',
        conflictPolicy: 'overwrite',
        createSafetyCheckpoint: true,
      }),
    ).rejects.toMatchObject({
      code: 'CHECKPOINT_MESSAGE_MISMATCH',
    });
    expect(await readFile(path.join(projectDir, 'index.html'), 'utf8')).toBe('<h1>second</h1>');
  });

  it('validates explicit checkpoint ids for chat_only rollback before pruning messages', async () => {
    const { db, service, projectId, projectDir } = await makeFixture();
    seedConversationMessages(db);
    await writeFixtureFile(projectDir, 'index.html', '<h1>second</h1>');
    const second = await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-2',
      kind: 'after_message',
    });

    await expect(
      service.rollback({
        projectId,
        conversationId: 'conv-1',
        targetMessageId: 'assistant-1',
        targetCheckpointId: second.id,
        mode: 'chat_only',
        conflictPolicy: 'fail',
        createSafetyCheckpoint: true,
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'CHECKPOINT_MESSAGE_MISMATCH',
    });
    expect(listMessages(db, 'conv-1').map((message) => message.id)).toEqual([
      'user-1',
      'assistant-1',
      'user-2',
      'assistant-2',
    ]);
  });

  it('restores modified and deleted files, removes files added after the checkpoint, and creates a safety checkpoint first', async () => {
    const { db, service, projectId, projectDir } = await makeFixture();
    seedConversationMessages(db);
    await writeFixtureFile(projectDir, 'src/app.ts', 'before');
    await writeFixtureFile(projectDir, '.live-artifacts/la-1/artifact.json', '{"title":"Before"}\n');

    const target = await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      runId: 'run-1',
      kind: 'after_message',
    });

    await writeFixtureFile(projectDir, 'src/app.ts', 'after');
    await writeFixtureFile(projectDir, 'generated.html', '<h1>new</h1>');
    await rm(path.join(projectDir, '.live-artifacts', 'la-1', 'artifact.json'));

    const restored = await service.rollback({
      projectId,
      conversationId: 'conv-1',
      targetMessageId: 'assistant-1',
      targetCheckpointId: target.id,
      mode: 'files_only',
      conflictPolicy: 'overwrite',
      createSafetyCheckpoint: true,
    });

    expect(restored).toMatchObject({
      projectId,
      conversationId: 'conv-1',
      safetyCheckpointId: expect.any(String),
      restoredCheckpointId: target.id,
      fileChanges: {
        modified: 1,
        added: 1,
        deleted: 1,
      },
    });
    expect(restored.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/app.ts' }),
        expect.objectContaining({ path: 'generated.html' }),
        expect.objectContaining({ path: '.live-artifacts/la-1/artifact.json' }),
      ]),
    );
    expect(await readFile(path.join(projectDir, 'src', 'app.ts'), 'utf8')).toBe('before');
    expect(await readFile(path.join(projectDir, '.live-artifacts', 'la-1', 'artifact.json'), 'utf8')).toBe(
      '{"title":"Before"}\n',
    );
    await expect(stat(path.join(projectDir, 'generated.html'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports conflicts without writing when current files diverged from the latest checkpoint lineage', async () => {
    const { db, service, projectId, projectDir } = await makeFixture();
    seedConversationMessages(db);
    await writeFixtureFile(projectDir, 'index.html', '<h1>target</h1>');
    const target = await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      kind: 'after_message',
    });

    await writeFixtureFile(projectDir, 'index.html', '<h1>agent change</h1>');
    await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-2',
      kind: 'after_message',
    });
    await writeFixtureFile(projectDir, 'index.html', '<h1>human edit</h1>');

    await expect(
      service.rollback({
        projectId,
        conversationId: 'conv-1',
        targetMessageId: 'assistant-1',
        targetCheckpointId: target.id,
        mode: 'files_only',
        conflictPolicy: 'fail',
        createSafetyCheckpoint: true,
      }),
    ).rejects.toMatchObject({
      code: 'ROLLBACK_CONFLICT',
      conflicts: [
        expect.objectContaining({
          path: 'index.html',
          reason: 'current_changed_since_checkpoint',
        }),
      ],
    });
    expect(await readFile(path.join(projectDir, 'index.html'), 'utf8')).toBe('<h1>human edit</h1>');
  });

  it('reports conflicts instead of overwriting dirty edits when no baseline checkpoint exists', async () => {
    const { db, service, projectId, projectDir } = await makeFixture();
    seedConversationMessages(db);
    await writeFixtureFile(projectDir, 'index.html', '<h1>target</h1>');
    const target = await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      kind: 'after_message',
    });
    await writeFixtureFile(projectDir, 'index.html', '<h1>dirty current</h1>');

    await expect(
      service.rollback({
        projectId,
        conversationId: 'conv-1',
        targetMessageId: 'assistant-1',
        targetCheckpointId: target.id,
        mode: 'files_only',
        conflictPolicy: 'fail',
        createSafetyCheckpoint: true,
      }),
    ).rejects.toMatchObject({
      code: 'ROLLBACK_CONFLICT',
      conflicts: [
        expect.objectContaining({
          path: 'index.html',
          reason: 'current_changed_since_checkpoint',
        }),
      ],
      safetyCheckpointId: expect.any(String),
    });
    expect(await readFile(path.join(projectDir, 'index.html'), 'utf8')).toBe('<h1>dirty current</h1>');
  });

  it('creates a safety checkpoint for file restore even when callers pass createSafetyCheckpoint false', async () => {
    const { db, service, projectId, projectDir } = await makeFixture();
    seedConversationMessages(db);
    await writeFixtureFile(projectDir, 'index.html', '<h1>target</h1>');
    const target = await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      kind: 'after_message',
    });
    await writeFixtureFile(projectDir, 'index.html', '<h1>current</h1>');

    const restored = await service.rollback({
      projectId,
      conversationId: 'conv-1',
      targetMessageId: 'assistant-1',
      targetCheckpointId: target.id,
      mode: 'files_only',
      conflictPolicy: 'overwrite',
      createSafetyCheckpoint: false,
    });

    expect(restored.safetyCheckpointId).toEqual(expect.any(String));
    expect(await readFile(path.join(projectDir, 'index.html'), 'utf8')).toBe('<h1>target</h1>');
  });

  it('creates a safety checkpoint before chat_only rollback prunes messages', async () => {
    const { db, service, projectId } = await makeFixture();
    seedConversationMessages(db);

    const restored = await service.rollback({
      projectId,
      conversationId: 'conv-1',
      targetMessageId: 'assistant-1',
      mode: 'chat_only',
      conflictPolicy: 'fail',
      createSafetyCheckpoint: false,
    });

    expect(restored).toMatchObject({
      safetyCheckpointId: expect.any(String),
      deletedMessageIds: ['user-2', 'assistant-2'],
      clearedAgentSessions: true,
    });
    const safety = getProjectCheckpoint(db, restored.safetyCheckpointId!);
    expect(safety).toMatchObject({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      kind: 'before_restore',
    });
  });

  it('refuses to restore when the manifest hash no longer matches checkpoint metadata', async () => {
    const { db, service, projectId, projectDir } = await makeFixture();
    seedConversationMessages(db);
    await writeFixtureFile(projectDir, 'index.html', '<h1>target</h1>');
    const target = await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      kind: 'after_message',
    });
    const row = getProjectCheckpoint(db, target.id);
    if (!row) throw new Error('missing checkpoint row');
    await writeFile(row.manifestPath, `${await readFile(row.manifestPath, 'utf8')}\n`);
    await writeFixtureFile(projectDir, 'index.html', '<h1>current</h1>');

    await expect(
      service.rollback({
        projectId,
        conversationId: 'conv-1',
        targetMessageId: 'assistant-1',
        targetCheckpointId: target.id,
        mode: 'files_only',
        conflictPolicy: 'overwrite',
        createSafetyCheckpoint: true,
      }),
    ).rejects.toMatchObject({
      code: 'CHECKPOINT_UNAVAILABLE',
    });
    expect(await readFile(path.join(projectDir, 'index.html'), 'utf8')).toBe('<h1>current</h1>');
  });

  it('verifies every target blob before copying any restore file', async () => {
    const { db, service, dataDir, projectId, projectDir } = await makeFixture();
    seedConversationMessages(db);
    await writeFixtureFile(projectDir, 'a.txt', 'target a');
    await writeFixtureFile(projectDir, 'z.txt', 'target z');
    const target = await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      kind: 'after_message',
    });
    const manifest = await readManifest(db, target.id);
    const blob = manifest.files.find((file) => file.path === 'z.txt')?.blob;
    if (!blob) throw new Error('missing checkpoint blob');
    await writeFile(path.join(dataDir, 'checkpoints', 'blobs', blob), 'corrupt blob');
    await writeFixtureFile(projectDir, 'a.txt', 'current a');
    await writeFixtureFile(projectDir, 'z.txt', 'current z');

    await expect(
      service.rollback({
        projectId,
        conversationId: 'conv-1',
        targetMessageId: 'assistant-1',
        targetCheckpointId: target.id,
        mode: 'files_only',
        conflictPolicy: 'overwrite',
        createSafetyCheckpoint: true,
      }),
    ).rejects.toMatchObject({
      code: 'CHECKPOINT_UNAVAILABLE',
    });
    expect(await readFile(path.join(projectDir, 'a.txt'), 'utf8')).toBe('current a');
    expect(await readFile(path.join(projectDir, 'z.txt'), 'utf8')).toBe('current z');
  });

  it('preflights a later target file blocked by a current directory before writing earlier files', async () => {
    const { db, service, projectId, projectDir } = await makeFixture();
    seedConversationMessages(db);
    await writeFixtureFile(projectDir, 'a.txt', 'target a');
    await writeFixtureFile(projectDir, 'z.txt', 'target z');
    const target = await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      kind: 'after_message',
    });

    await writeFixtureFile(projectDir, 'a.txt', 'current a');
    await rm(path.join(projectDir, 'z.txt'));
    await writeFixtureFile(projectDir, 'z.txt/nested.txt', 'current nested');
    await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-2',
      kind: 'after_message',
    });

    await expect(
      service.rollback({
        projectId,
        conversationId: 'conv-1',
        targetMessageId: 'assistant-1',
        targetCheckpointId: target.id,
        mode: 'files_only',
        conflictPolicy: 'fail',
        createSafetyCheckpoint: true,
      }),
    ).rejects.toMatchObject({
      code: 'ROLLBACK_CONFLICT',
      conflicts: [
        expect.objectContaining({
          path: 'z.txt',
          reason: 'target_path_blocked',
        }),
      ],
      safetyCheckpointId: expect.any(String),
    });
    expect(await readFile(path.join(projectDir, 'a.txt'), 'utf8')).toBe('current a');
    expect(await readFile(path.join(projectDir, 'z.txt', 'nested.txt'), 'utf8')).toBe('current nested');
  });

  it('preflights a later target file blocked by a current parent file before writing earlier files', async () => {
    const { db, service, projectId, projectDir } = await makeFixture();
    seedConversationMessages(db);
    await writeFixtureFile(projectDir, 'a.txt', 'target a');
    await writeFixtureFile(projectDir, 'z-dir/file.txt', 'target nested');
    const target = await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      kind: 'after_message',
    });

    await writeFixtureFile(projectDir, 'a.txt', 'current a');
    await rm(path.join(projectDir, 'z-dir'), { recursive: true, force: true });
    await writeFixtureFile(projectDir, 'z-dir', 'current parent file');
    await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-2',
      kind: 'after_message',
    });

    await expect(
      service.rollback({
        projectId,
        conversationId: 'conv-1',
        targetMessageId: 'assistant-1',
        targetCheckpointId: target.id,
        mode: 'files_only',
        conflictPolicy: 'fail',
        createSafetyCheckpoint: true,
      }),
    ).rejects.toMatchObject({
      code: 'ROLLBACK_CONFLICT',
      conflicts: [
        expect.objectContaining({
          path: 'z-dir',
          reason: 'target_path_blocked',
        }),
      ],
      safetyCheckpointId: expect.any(String),
    });
    expect(await readFile(path.join(projectDir, 'a.txt'), 'utf8')).toBe('current a');
    expect(await readFile(path.join(projectDir, 'z-dir'), 'utf8')).toBe('current parent file');
  });

  it('rejects restore when the checkpoint root hash does not match the current project root', async () => {
    const { db, service, projectId, projectDir } = await makeFixture();
    seedConversationMessages(db);
    await writeFixtureFile(projectDir, 'index.html', '<h1>target</h1>');
    const target = await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      kind: 'after_message',
    });
    await writeFixtureFile(projectDir, 'index.html', '<h1>old root current</h1>');
    const otherRoot = await mkdtemp(path.join(tmpdir(), 'readable-checkpoint-other-root-'));
    tempRoots.push(otherRoot);
    await writeFixtureFile(otherRoot, 'index.html', '<h1>other root current</h1>');
    updateProject(db, projectId, { metadata: { baseDir: otherRoot } });

    await expect(
      service.rollback({
        projectId,
        conversationId: 'conv-1',
        targetMessageId: 'assistant-1',
        targetCheckpointId: target.id,
        mode: 'files_only',
        conflictPolicy: 'overwrite',
        createSafetyCheckpoint: true,
      }),
    ).rejects.toMatchObject({
      code: 'CHECKPOINT_ROOT_MISMATCH',
    });
    expect(await readFile(path.join(projectDir, 'index.html'), 'utf8')).toBe('<h1>old root current</h1>');
    expect(await readFile(path.join(otherRoot, 'index.html'), 'utf8')).toBe('<h1>other root current</h1>');
  });

  it('computes added, modified, and deleted paths for rollback preview', async () => {
    const { service, projectId, projectDir } = await makeFixture();
    await writeFixtureFile(projectDir, 'keep.txt', 'same');
    await writeFixtureFile(projectDir, 'modify.txt', 'before');
    await writeFixtureFile(projectDir, 'delete.txt', 'present in checkpoint');
    const target = await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      kind: 'after_message',
    });

    await writeFixtureFile(projectDir, 'keep.txt', 'same');
    await writeFixtureFile(projectDir, 'modify.txt', 'after');
    await rm(path.join(projectDir, 'delete.txt'));
    await writeFixtureFile(projectDir, 'added.txt', 'new');

    const diff = await service.diffCheckpoint(projectId, target.id);

    expect(diff.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'added.txt', status: 'added' }),
        expect.objectContaining({ path: 'modify.txt', status: 'modified' }),
        expect.objectContaining({ path: 'delete.txt', status: 'deleted' }),
      ]),
    );
    expect(diff.files.filter((file) => file.status === 'unchanged')).toHaveLength(1);
  });

  it('uses the target checkpoint as the conflict baseline when no newer checkpoint exists (latest message)', async () => {
    const { db, service, projectId, projectDir } = await makeFixture();
    seedConversationMessages(db);

    // Agent state captured at the first assistant turn.
    await writeFixtureFile(projectDir, 'A.txt', 'a1');
    await writeFixtureFile(projectDir, 'B.txt', 'b1');
    await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-1',
      kind: 'after_message',
    });

    // The agent changes A.txt at the latest assistant turn; this is the most
    // recent checkpoint, so nothing is strictly newer than it.
    await writeFixtureFile(projectDir, 'A.txt', 'a2');
    const latest = await service.captureCheckpoint({
      projectId,
      conversationId: 'conv-1',
      messageId: 'assistant-2',
      kind: 'after_message',
    });

    // The user then manually edits B.txt only (working tree has drifted).
    await writeFixtureFile(projectDir, 'B.txt', 'b2-manual');

    const diff = await service.diffCheckpoint(projectId, latest.id);

    // When no checkpoint is newer than the target, the baseline falls back to
    // the target itself (the agent's last recorded state for these files),
    // instead of being null.
    expect(diff.baseCheckpoint?.id).toBe(latest.id);

    // Only the file the working tree genuinely drifted from the checkpoint is a
    // conflict. A.txt (changed by the agent but untouched by the user) matches
    // the target and must NOT be reported as a conflict / data loss.
    expect(diff.conflicts.map((conflict) => conflict.path)).toEqual(['B.txt']);

    // The genuine conflict reports the target's recorded content as the expected
    // baseline (so consumers can describe the drift), rather than a null
    // baseline that erases the reference point.
    const conflict = diff.conflicts.find((item) => item.path === 'B.txt');
    expect(conflict).toBeTruthy();
    expect(conflict?.expectedHash).not.toBeNull();
    expect(conflict?.expectedHash).toBe(conflict?.targetHash);
  });
});

async function fsSymlinkDir(target: string, linkPath: string) {
  const { symlink } = await import('node:fs/promises');
  await symlink(target, linkPath, 'dir');
}
