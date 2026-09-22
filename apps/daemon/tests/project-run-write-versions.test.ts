import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  captureProjectFileVersions, listFiles, ProjectFileContentConflictError,
  readProjectFile, writeProjectFile, type ProjectFileWriteGuard,
} from '../src/projects.js';
import { createChatRunService } from '../src/runs.js';

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const manifest = { schema: 'readable-studio.artifact-manifest.v1', kind: 'html',
  entry: 'index.html', renderer: 'html', status: 'complete', exports: ['html'] };

async function fixture() {
  root = await mkdtemp(path.join(tmpdir(), 'readable-run-versions-'));
  await writeProjectFile(root, 'project', 'index.html', '<h1>Original</h1>', { artifactManifest: manifest });
  const versions = await captureProjectFileVersions(root, 'project', await listFiles(root, 'project'));
  const onConflict = vi.fn();
  const guard: ProjectFileWriteGuard = { versions, onConflict };
  return { guard, write: (name: string, content: string, options = {}) => writeProjectFile(root, 'project', name, content, { ...options, writeGuards: [guard] }) };
}

it('serializes concurrent run writes and advances the version after each successful write', async () => {
  const { write, guard } = await fixture();
  const contents = ['<h1>First</h1>', '<h1>Second</h1>'];
  await Promise.all(contents.map(content => write('index.html', content)));
  // Path resolution is asynchronous: either request may enter the lock first.
  // Both must succeed, and the final bytes must be one complete write, not a mix.
  expect(contents).toContain((await readProjectFile(root, 'project', 'index.html')).buffer.toString());
  await write('index.html', '<h1>Third</h1>');
  expect((await readProjectFile(root, 'project', 'index.html')).buffer.toString()).toBe('<h1>Third</h1>');
  expect(guard.onConflict).not.toHaveBeenCalled();
});

it('keeps both saved content and its manifest when a run write conflicts', async () => {
  const { write, guard } = await fixture();
  await writeProjectFile(root, 'project', 'index.html', '<h1>User</h1>', {
    expectedContentSha256: hash('<h1>Original</h1>'), artifactManifest: { ...manifest, title: 'User title' },
  });
  await expect(write('index.html', '<h1>Agent</h1>', { artifactManifest: { ...manifest, title: 'Agent title' } })).rejects.toBeInstanceOf(ProjectFileContentConflictError);
  const file = await readProjectFile(root, 'project', 'index.html');
  expect(file.buffer.toString()).toBe('<h1>User</h1>');
  expect(file.artifactManifest?.title).toBe('User title');
  expect(guard.onConflict).toHaveBeenCalledOnce();
});

it('rejects creation races and external writes instead of treating a missing baseline as permission to overwrite', async () => {
  const { write } = await fixture();
  await writeFile(path.join(root!, 'project', 'new.html'), '<h1>User new file</h1>');
  await expect(write('new.html', '<h1>Agent</h1>')).rejects.toMatchObject({ code: 'CONFLICT', expectedContentSha256: null });
  expect(await readFile(path.join(root!, 'project', 'new.html'), 'utf8')).toBe('<h1>User new file</h1>');
  await writeFile(path.join(root!, 'project', 'index.html'), '<h1>External editor</h1>');
  await expect(write('index.html', '<h1>Agent</h1>')).rejects.toMatchObject({ code: 'CONFLICT' });
});

it('tracks create-only artifact writes so the same run can subsequently update them', async () => {
  const { write, guard } = await fixture();
  await write('new.html', '<h1>Created</h1>', { overwrite: false });
  await write('new.html', '<h1>Updated</h1>');
  expect((await readProjectFile(root, 'project', 'new.html')).buffer.toString()).toBe('<h1>Updated</h1>');
  expect(guard.onConflict).not.toHaveBeenCalled();
});

it('uses canonical Windows case-insensitive versions for a saved target', async () => {
  const { write } = await fixture();
  await writeProjectFile(root, 'project', 'index.html', '<h1>User</h1>', { expectedContentSha256: hash('<h1>Original</h1>') });
  await expect(write(process.platform === 'win32' ? 'INDEX.HTML' : 'index.html', '<h1>Agent</h1>')).rejects.toMatchObject({ code: 'CONFLICT' });
});

for (const canceled of [false, true]) {
  it(`retains conflict status beyond bounded history and ${canceled ? 'preserves cancellation' : 'never reports success'}`, async () => {
    const runs = createChatRunService({ maxEvents: 2,
      createSseResponse: () => { throw new Error('No HTTP stream in this test'); },
      createSseErrorPayload: (code, message, init) => ({ error: { code, message, ...init } }),
    });
    try {
      const run = runs.create({ projectId: 'project' });
      run.projectFileVersions = new Map();
      runs.noteFileWriteConflict(run, new ProjectFileContentConflictError('index.html', hash('old'), hash('user')));
      for (let i = 0; i < 8; i++) runs.emit(run, 'diagnostic', { sequence: i });
      expect(run.events).toHaveLength(2);
      runs.finish(run, canceled ? 'canceled' : 'succeeded', canceled ? null : 0);
      expect(runs.statusBody(run)).toMatchObject({ status: canceled ? 'canceled' : 'failed', errorCode: 'CONFLICT' });
      expect(run.events.at(-1)).toMatchObject({ data: { status: canceled ? 'canceled' : 'failed' } });
      expect(run.projectFileVersions).toBeNull();
    } finally { runs.dispose(); }
  });
}
