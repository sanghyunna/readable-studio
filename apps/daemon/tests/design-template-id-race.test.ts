import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Lets a test plant a foreign directory at the rename target after the id was
// allocated (another process, an unsynced OneDrive folder, ...), or fail the
// next `locked` renames with EPERM like a handle held by antivirus/indexer.
const hooks = vi.hoisted(() => ({
  beforeRename: undefined as undefined | ((to: string) => void),
  locked: 0,
  targets: [] as string[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      hooks.targets.push(path.basename(to));
      const hook = hooks.beforeRename;
      hooks.beforeRename = undefined;
      hook?.(to);
      if (hooks.locked > 0) {
        hooks.locked -= 1;
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
      }
      return actual.rename(from, to);
    },
  };
});

vi.mock('../src/design-template-thumbnails.js', () => ({
  requestTemplateThumbnails: vi.fn(async () => undefined),
}));

import {
  DesignTemplateImportError,
  finalizeDesignTemplateDir,
  prepareDesignTemplateZip,
  writePreparedTemplateFiles,
} from '../src/design-template-import.js';
import { buildTemplateZip, validTemplateEntries } from './helpers/template-zip.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'rs-template-id-race-'));
});
afterEach(() => {
  hooks.beforeRename = undefined;
  hooks.locked = 0;
  hooks.targets = [];
  rmSync(root, { recursive: true, force: true });
});

async function stage(name: string) {
  const prepared = prepareDesignTemplateZip(buildTemplateZip(validTemplateEntries()), 'deck.zip');
  const stagingDir = path.join(root, `.stage-${name}`);
  await writePreparedTemplateFiles(stagingDir, prepared);
  return {
    root,
    stagingDir,
    type: 'deck' as const,
    name: 'Same Name',
    cover: prepared.suggestedCover,
    pages: prepared.pages,
    originalFileName: 'deck.zip',
    sha256: prepared.sha256,
    thumbnail: { status: 'pending' as const, source: null, updatedAt: '2026-01-01T00:00:00.000Z' },
  };
}

describe('finalizeDesignTemplateDir id allocation', () => {
  it('gives two concurrent same-named templates distinct ids and completes both', async () => {
    const [a, b] = await Promise.all([stage('a'), stage('b')]);
    const [first, second] = await Promise.all([finalizeDesignTemplateDir(a), finalizeDesignTemplateDir(b)]);
    // Who gets the bare id depends on I/O timing before the lock; only distinctness matters.
    expect([first.id, second.id].sort()).toEqual(['user-same-name', 'user-same-name-2']);
    for (const result of [first, second]) {
      expect(JSON.parse(readFileSync(path.join(result.dir, 'import.json'), 'utf8')).id).toBe(result.id);
      expect(readFileSync(path.join(result.dir, 'SKILL.md'), 'utf8')).toContain(`name: ${result.id}`);
    }
    expect(existsSync(a.stagingDir)).toBe(false);
    expect(existsSync(b.stagingDir)).toBe(false);
  });

  it('moves on to the next suffix when the rename target appears after allocation', async () => {
    const input = await stage('a');
    hooks.beforeRename = (to) => {
      mkdirSync(to);
      writeFileSync(path.join(to, 'foreign.txt'), 'keep me');
    };
    const result = await finalizeDesignTemplateDir(input);
    expect(result.id).toBe('user-same-name-2');
    expect(JSON.parse(readFileSync(path.join(result.dir, 'import.json'), 'utf8')).id).toBe('user-same-name-2');
    expect(readFileSync(path.join(root, 'user-same-name', 'foreign.txt'), 'utf8')).toBe('keep me');
    expect(existsSync(path.join(root, 'user-same-name', 'import.json'))).toBe(false);
  });

  it('retries the same id while a transient lock (EPERM, target absent) clears', async () => {
    const input = await stage('a');
    hooks.locked = 2;
    const result = await finalizeDesignTemplateDir(input);
    expect(result.id).toBe('user-same-name');
    expect(hooks.targets).toEqual(['user-same-name', 'user-same-name', 'user-same-name']);
    expect(JSON.parse(readFileSync(path.join(result.dir, 'import.json'), 'utf8')).id).toBe('user-same-name');
    expect(existsSync(input.stagingDir)).toBe(false);
  });

  it('still takes the next suffix when EPERM comes with an existing target', async () => {
    const input = await stage('a');
    hooks.beforeRename = (to) => mkdirSync(to);
    hooks.locked = 1;
    const result = await finalizeDesignTemplateDir(input);
    expect(result.id).toBe('user-same-name-2');
    expect(hooks.targets).toEqual(['user-same-name', 'user-same-name-2']);
  });

  it('surfaces a clear error once a lock outlasts the bounded retries', async () => {
    const input = await stage('a');
    hooks.locked = Number.POSITIVE_INFINITY;
    const err = await finalizeDesignTemplateDir(input).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(DesignTemplateImportError);
    expect((err as DesignTemplateImportError).status).toBe(500);
    expect((err as Error).message).toMatch(/could not save template: .*locked.*EPERM/);
    expect(hooks.targets).toEqual(Array(5).fill('user-same-name'));
    expect(existsSync(path.join(root, 'user-same-name'))).toBe(false);
    // Staging stays for a retry, minus the generated files.
    expect(existsSync(path.join(input.stagingDir, 'PROMPT.md'))).toBe(true);
    expect(existsSync(path.join(input.stagingDir, 'import.json'))).toBe(false);
    expect(existsSync(path.join(input.stagingDir, 'SKILL.md'))).toBe(false);
  });
});
