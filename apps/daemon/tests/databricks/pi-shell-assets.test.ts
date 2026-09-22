import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import { databricksFailure } from '../../src/databricks-routes.js';
import { createDatabricksPiRuntime } from '../../src/runtimes/pi-databricks.js';
import { runtimeServiceFixture } from './runtime-fixture.js';

for (const asset of ['pi-powershell-extension', 'pi-powershell']) {
  test(`reports missing ${asset} paths before starting Pi`, async () => {
    // Given: a damaged runtime is missing a required managed shell asset.
    const root = await mkdtemp(path.join(tmpdir(), 'pi-shell-assets-'));
    const exists = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation(candidate => {
      const name = path.basename(String(candidate));
      return name === `${asset}.js` || name === `${asset}.ts` ? false : exists(candidate);
    });
    syncBuiltinESMExports();
    try {
      const { service } = runtimeServiceFixture();
      // When: preparing the real managed invocation (before spawn/RPC).
      const result = await createDatabricksPiRuntime({
        dataRoot: root, cwd: root, sessionKey: 'missing-asset', model: 'dbm_opaque_model', service,
      }).then(async runtime => { await runtime.close(); return null; }, error => error);
      // Then: the user-visible failure retains the missing absolute path.
      assert.ok(result instanceof Error, 'missing shell asset must reject invocation before Pi is spawned');
      const failure = databricksFailure(result);
      expect(failure.error.message).toContain(fileURLToPath(new URL(`../../src/runtimes/${asset}.ts`, import.meta.url)));
      expect(failure.error.retryable).toBe(false);
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });
}
