import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { assertWinDaemonRuntimeAssets, stageWinDaemonRuntimeAssets, WIN_DAEMON_RUNTIME_ASSETS } from '../src/win-prebundle.js';

const assets = ['pi-powershell-extension.js', 'pi-powershell.js'] as const;

test('stages both Pi shell assets beside the packaged daemon chunks', async () => {
  // Given: compiled daemon runtime files, independent of the packaging manifest.
  const root = await mkdtemp(join(tmpdir(), 'win-pi-assets-'));
  const source = join(root, 'apps', 'daemon', 'dist', 'runtimes');
  const output = join(root, 'resources', 'app', 'prebundled', 'daemon');
  try {
    await mkdir(source, { recursive: true });
    for (const asset of assets) await writeFile(join(source, asset), `export const asset = ${JSON.stringify(asset)};`);
    // When: the same staging operation used by the portable prebundle runs.
    await stageWinDaemonRuntimeAssets(root, output);
    // Then: neither the extension nor its imported resolver can be omitted.
    expect(WIN_DAEMON_RUNTIME_ASSETS).toEqual(assets);
    for (const asset of assets) {
      expect(await readFile(join(output, 'chunks', asset))).toEqual(await readFile(join(source, asset)));
    }
    await expect(assertWinDaemonRuntimeAssets(output)).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const missing of assets) {
  test(`rejects a packaged cache with missing ${missing}`, async () => {
    // Given: a partial packaged layout, including the other asset.
    const root = await mkdtemp(join(tmpdir(), 'win-pi-assets-missing-'));
    try {
      await mkdir(join(root, 'chunks'));
      for (const asset of assets) if (asset !== missing) await writeFile(join(root, 'chunks', asset), 'export {};');
      // When / Then: cache hits also fail with the exact missing path.
      await expect(assertWinDaemonRuntimeAssets(root)).rejects.toThrow(join(root, 'chunks', missing));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
