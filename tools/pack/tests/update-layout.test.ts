import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { assertUpdateLayout, prepareUpdateLayout, UPDATE_HELPER_FILES } from '../src/win/update-layout.js';
import { buildWinPortableZip } from '../src/win/zip.js';
import { winResources } from '../src/resources.js';
import type { WinPaths, WinBuiltAppManifest } from '../src/win/types.js';
import type { ToolPackConfig } from '../src/config.js';

describe('update layout inventory', () => {
  it('compiles the real launcher and ships all real helper scripts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compiled-layout-'));
    try {
      await mkdir(join(root, 'app'));
      await writeFile(join(root, 'app', 'Readable Studio.exe'), 'payload fixture');
      await prepareUpdateLayout(join(import.meta.dirname, '..', '..', '..'), root);
      expect((await stat(join(root, 'Readable Studio.exe'))).size).toBeGreaterThan(1024);
      await expect(assertUpdateLayout(root)).resolves.toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20000);
  it('archives only the stub and app payload, never user data or stale flat files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'archive-layout-'));
    const top = join(root, 'top');
    try {
      await mkdir(join(top, 'app'), { recursive: true });
      await mkdir(join(top, 'ReadableStudioData'));
      await mkdir(join(top, 'resources'));
      await writeFile(join(top, 'Readable Studio.exe'), 'stub');
      await writeFile(join(top, 'app', 'Readable Studio.exe'), 'payload');
      await writeFile(join(top, 'ReadableStudioData', 'private.txt'), 'data');
      await writeFile(join(top, 'resources', 'stale.txt'), 'old payload');
      const zip = join(root, 'portable.zip');
      await buildWinPortableZip({ signed: false } as ToolPackConfig, { setupZipPath: zip } as WinPaths, { unpackedRoot: top } as WinBuiltAppManifest);
      const extract = join(root, 'extracted');
      await promisify(execFile)(winResources.sevenZipExe, ['x', zip, `-o${extract}`, '-y'], { windowsHide: true });
      expect((await readdir(extract)).sort()).toEqual(['Readable Studio.exe', 'app']);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20000);
  it('fails closed for every missing launcher or helper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'layout-'));
    const files = ['Readable Studio.exe', 'app/Readable Studio.exe', ...UPDATE_HELPER_FILES.map((name) => `app/resources/update-helper/${name}`)];
    try {
      for (const file of files) { await mkdir(join(root, file, '..'), { recursive: true }); await writeFile(join(root, file), 'fixture'); }
      await expect(assertUpdateLayout(root)).resolves.toBeUndefined();
      for (const file of files) {
        await rm(join(root, file));
        await expect(assertUpdateLayout(root)).rejects.toThrow();
        await writeFile(join(root, file), 'fixture');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
