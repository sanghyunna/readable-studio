import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { assertNoDatabricksIdentityLeaks } from './privacy-fixture.js';

const identities = ['dapi_LEAK_TEST_TOKEN', 'https://leak-test.azuredatabricks.net', 'private_catalog.private_schema.model_service'];
for (const sink of ['daemon.log', 'diagnostics.json', 'analytics.json', 'app-config.json', 'models.json', 'settings.json']) {
  it.each(identities)(`UI identity allowance still catches %s written to the forbidden ${sink} sink`, async (secret) => {
    const root = await mkdtemp(join(tmpdir(), 'databricks-leak-check-'));
    try {
      const file = join(root, sink);
      await writeFile(file, JSON.stringify({ value: secret }));
      const bytes = await readFile(file, 'utf8');
      expect(() => assertNoDatabricksIdentityLeaks({ [sink]: bytes }, identities)).toThrow(`Databricks identity leaked into ${sink}`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
