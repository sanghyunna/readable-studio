import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  getProject,
  insertProject,
  listProjects,
  openDatabase,
} from '../src/db.js';

const roots: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'readable-data-identity-'));
  roots.push(root);
  return root;
}

function fixtureHashes(root: string): Readonly<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else {
        const relativePath = path.relative(root, absolutePath).replaceAll('\\', '/');
        hashes[relativePath] = createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
      }
    }
  };
  visit(root);
  return hashes;
}

afterEach(async () => {
  closeDatabase();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Readable Studio data identity', () => {
  it('rejects old data without mutation', async () => {
    // Given: a complete old Readable Studio root with SQLite, project, and artifact payloads.
    const projectRoot = await fixtureRoot();
    const retiredDataDirName = ['.', 'od'].join('');
    const oldDataRoot = path.join(projectRoot, retiredDataDirName);
    await mkdir(oldDataRoot, { recursive: true });
    const oldDb = new Database(path.join(oldDataRoot, 'app.sqlite'));
    oldDb.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
    oldDb.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run('old-project', 'Old project');
    oldDb.close();
    await mkdir(path.join(oldDataRoot, 'projects', 'old-project'), { recursive: true });
    await mkdir(path.join(oldDataRoot, 'artifacts'), { recursive: true });
    writeFileSync(path.join(oldDataRoot, 'projects', 'old-project', 'index.html'), '<h1>old</h1>');
    writeFileSync(path.join(oldDataRoot, 'artifacts', 'old.html'), '<h1>artifact</h1>');
    const before = fixtureHashes(oldDataRoot);

    // When: Readable Studio is pointed at the old store, then opens its default store.
    expect(() => openDatabase(projectRoot, { dataDir: oldDataRoot })).toThrow(
      'database does not belong to Readable Studio',
    );
    const readableDb = openDatabase(projectRoot);

    // Then: the old format is rejected, the default starts empty, and every old fixture byte is untouched.
    expect(listProjects(readableDb)).toEqual([]);
    expect(readFileSync(path.join(projectRoot, '.readable-studio', 'app.sqlite')).byteLength).toBeGreaterThan(0);
    expect(fixtureHashes(oldDataRoot)).toEqual(before);
  });

  it('reopens fresh SQLite projects and artifacts', async () => {
    // Given: a fresh Readable Studio project root.
    const projectRoot = await fixtureRoot();
    const dataRoot = path.join(projectRoot, '.readable-studio');
    const projectDir = path.join(dataRoot, 'projects', 'fresh-project');
    const artifactDir = path.join(dataRoot, 'artifacts');

    // When: project metadata and artifact files are persisted, then SQLite is reopened.
    const first = openDatabase(projectRoot);
    insertProject(first, {
      id: 'fresh-project',
      name: 'Fresh project',
      createdAt: 1,
      updatedAt: 1,
    });
    await mkdir(projectDir, { recursive: true });
    await mkdir(artifactDir, { recursive: true });
    writeFileSync(path.join(projectDir, 'index.html'), '<h1>fresh</h1>');
    writeFileSync(path.join(artifactDir, 'render.html'), '<h1>render</h1>');
    closeDatabase();
    const reopened = openDatabase(projectRoot);

    // Then: the new identity reopens all fresh state from its own root.
    expect(getProject(reopened, 'fresh-project')?.name).toBe('Fresh project');
    await expect(access(path.join(dataRoot, 'app.sqlite'))).resolves.toBeUndefined();
    expect(readFileSync(path.join(projectDir, 'index.html'), 'utf8')).toBe('<h1>fresh</h1>');
    expect(readFileSync(path.join(artifactDir, 'render.html'), 'utf8')).toBe('<h1>render</h1>');
  });
});
