import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { PiShellAssetError, resolvePiShellExtension } from '../../src/runtimes/pi-shell-assets.js';

for (const layout of [
  { directory: 'src/runtimes', entry: 'pi-databricks.ts', suffix: '.ts' },
  { directory: 'dist/runtimes', entry: 'pi-databricks.js', suffix: '.js' },
  { directory: 'resources/app/prebundled/daemon/chunks', entry: 'server-EZMUCW3N.mjs', suffix: '.js' },
]) {
  test(`resolves the shell extension from ${layout.directory}`, async () => {
    // Given: source, tsc, or the observed unpacked chunk layout, including spaces.
    const root = await mkdtemp(path.join(tmpdir(), 'pi shell layout '));
    const directory = path.join(root, layout.directory);
    const extension = path.join(directory, `pi-powershell-extension${layout.suffix}`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(extension, 'export default function register() {}');
      await writeFile(path.join(directory, `pi-powershell${layout.suffix}`), 'export {};');
      // When: resolving relative to the actual caller module, never cwd.
      const resolved = resolvePiShellExtension(pathToFileURL(path.join(directory, layout.entry)).href);
      // Then: the matching extension and resolver pair is selected.
      expect(resolved).toBe(extension);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('reports both packaged extension candidates when the payload is absent', async () => {
  // Given: an unpacked daemon chunk without its dynamic assets.
  const root = await mkdtemp(path.join(tmpdir(), 'pi-shell-empty-'));
  try {
    const moduleUrl = pathToFileURL(path.join(root, 'server.mjs')).href;
    // When / Then: a typed startup error identifies all attempted paths.
    expect(() => resolvePiShellExtension(moduleUrl)).toThrow(PiShellAssetError);
    expect(() => resolvePiShellExtension(moduleUrl)).toThrow(path.join(root, 'pi-powershell-extension.js'));
    expect(() => resolvePiShellExtension(moduleUrl)).toThrow(path.join(root, 'pi-powershell-extension.ts'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
