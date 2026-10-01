import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDatabase, getProjectCheckpoint, insertConversation, insertProject,
  openDatabase, upsertMessage,
} from '../src/db.js';
import { createProjectCheckpointService, ProjectCheckpointError } from '../src/project-checkpoints.js';

const roots: string[] = [];
afterEach(async () => {
  closeDatabase();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const fixtureRoot = path.resolve('../../.tmp/checkpoint-paths');
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(path.join(fixtureRoot, 'portability-'));
  roots.push(root);
  const appRoot = path.join(root, 'app-v1');
  const dataDir = path.join(appRoot, 'data');
  const projectsRoot = path.join(appRoot, 'projects');
  const projectId = 'portable-project';
  const projectDir = path.join(projectsRoot, projectId);
  await mkdir(dataDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  const db = openDatabase(dataDir, { dataDir });
  insertProject(db, { id: projectId, name: 'Portable', createdAt: 1, updatedAt: 1 });
  insertConversation(db, { id: 'conversation', projectId, title: 'C', createdAt: 1, updatedAt: 1 });
  upsertMessage(db, 'conversation', { id: 'message', role: 'assistant', content: 'checkpoint' });
  await writeFile(path.join(projectDir, 'file.txt'), 'saved');
  const service = createProjectCheckpointService({ db, dataDir, projectsRoot });
  const checkpoint = await service.captureCheckpoint({
    projectId, conversationId: 'conversation', messageId: 'message', kind: 'after_message',
  });
  const rollback = {
    projectId, conversationId: 'conversation', targetMessageId: 'message',
    targetCheckpointId: checkpoint.id, mode: 'files_only' as const, conflictPolicy: 'overwrite' as const,
  };
  return { root, appRoot, dataDir, projectsRoot, projectDir, projectId, db, service, checkpoint, rollback };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const hash = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

async function legacyManifest(f: Fixture) {
  const row = getProjectCheckpoint(f.db, f.checkpoint.id);
  if (!row) throw new Error('missing checkpoint');
  const manifestPath = path.resolve(f.dataDir, row.manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  const rootPathHash = hash(await realpath(f.projectDir));
  const text = JSON.stringify({ ...manifest, schemaVersion: 1, rootPathHash }, null, 2);
  await writeFile(manifestPath, text);
  f.db.prepare('UPDATE project_checkpoints SET manifest_path = ?, manifest_hash = ?, root_path_hash = ? WHERE id = ?')
    .run(manifestPath, hash(text), rootPathHash, f.checkpoint.id);
  return getProjectCheckpoint(f.db, f.checkpoint.id);
}

async function moveApp(f: Fixture) {
  closeDatabase();
  const movedRoot = path.join(f.root, 'relocated', 'app');
  await mkdir(path.dirname(movedRoot), { recursive: true });
  await rename(f.appRoot, movedRoot);
  const dataDir = path.join(movedRoot, 'data');
  const projectsRoot = path.join(movedRoot, 'projects');
  const db = openDatabase(dataDir, { dataDir });
  return {
    db, dataDir, projectDir: path.join(projectsRoot, f.projectId),
    service: createProjectCheckpointService({ db, dataDir, projectsRoot }),
  };
}

describe('checkpoint path portability', () => {
  it('restores after the project folder moves with the same database identity', async () => {
    const f = await fixture();
    const projectsRoot = path.join(f.root, 'moved-projects');
    await rename(f.projectsRoot, projectsRoot);
    const projectDir = path.join(projectsRoot, f.projectId);
    await writeFile(path.join(projectDir, 'file.txt'), 'changed');
    const service = createProjectCheckpointService({ db: f.db, dataDir: f.dataDir, projectsRoot });
    await expect(service.rollback(f.rollback)).resolves.toMatchObject({ restoredCheckpointId: f.checkpoint.id });
    expect(await readFile(path.join(projectDir, 'file.txt'), 'utf8')).toBe('saved');
  });

  it('restores after both the app data root and project root move', async () => {
    const f = await fixture();
    const moved = await moveApp(f);
    await writeFile(path.join(moved.projectDir, 'file.txt'), 'changed');
    await expect(moved.service.rollback(f.rollback)).resolves.toMatchObject({ restoredCheckpointId: f.checkpoint.id });
    expect(await readFile(path.join(moved.projectDir, 'file.txt'), 'utf8')).toBe('saved');
    const row = getProjectCheckpoint(moved.db, f.checkpoint.id);
    expect(row).not.toBeNull();
    expect(path.isAbsolute(row!.manifestPath)).toBe(false);
    const manifest = JSON.parse(await readFile(path.resolve(moved.dataDir, row!.manifestPath), 'utf8')) as Record<string, unknown>;
    expect(manifest.schemaVersion).toBe(2);
    expect(row!.rootPathHash).toBe(hash(`project:${f.projectId}`));
  });

  it('restores legacy absolute-path manifests in place without rewriting the row', async () => {
    const f = await fixture();
    const legacyRow = await legacyManifest(f);
    await writeFile(path.join(f.projectDir, 'file.txt'), 'changed');
    await expect(f.service.rollback(f.rollback)).resolves.toMatchObject({ restoredCheckpointId: f.checkpoint.id });
    expect(await readFile(path.join(f.projectDir, 'file.txt'), 'utf8')).toBe('saved');
    expect(getProjectCheckpoint(f.db, f.checkpoint.id)).toEqual(legacyRow);
  });

  it('reports a typed root mismatch for a moved legacy checkpoint without changing files or audit rows', async () => {
    const f = await fixture();
    const legacyRow = await legacyManifest(f);
    const moved = await moveApp(f);
    await writeFile(path.join(moved.projectDir, 'file.txt'), 'changed');
    const result = moved.service.rollback(f.rollback);
    await expect(result).rejects.toBeInstanceOf(ProjectCheckpointError);
    await expect(result).rejects.toMatchObject({
      status: 409, code: 'CHECKPOINT_ROOT_MISMATCH', message: expect.stringMatching(/legacy.*moved/i),
    });
    expect(await readFile(path.join(moved.projectDir, 'file.txt'), 'utf8')).toBe('changed');
    expect(getProjectCheckpoint(moved.db, f.checkpoint.id)).toEqual(legacyRow);
    expect(moved.db.prepare('SELECT COUNT(*) AS count FROM project_checkpoint_restores').get()).toEqual({ count: 0 });
    expect(moved.db.prepare('SELECT COUNT(*) AS count FROM project_checkpoints').get()).toEqual({ count: 1 });
  });
});
