import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { _resetAgentDetectionCacheForTests, configureDetectionStorage, detectAgents } from '../../src/runtimes/detection.js';
import { readStoredAgentScan } from '../../src/runtimes/detection-store.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fallback-persistence-'));
  _resetAgentDetectionCacheForTests();
  configureDetectionStorage(root);
});
afterEach(async () => {
  _resetAgentDetectionCacheForTests();
  await rm(root, { recursive: true, force: true });
});

it('preserves unavailable fallback results when a completed scan is reused', async () => {
  // Given a completed Claude scan with no optional local routes.
  const env = { claude: { CLAUDE_BIN: process.execPath, MMD_MODEL_ROUTES_FILE: join(root, 'absent.json') } };
  const initial = await detectAgents(env, { enabledAgentIds: ['claude'] });
  const stored = await readStoredAgentScan(root);
  expect(stored?.results[0]).toMatchObject({ available: false, models: [] });
  _resetAgentDetectionCacheForTests();
  configureDetectionStorage(root);
  // When a new process-equivalent cache reads the persisted scan.
  const agents = await detectAgents(env, { enabledAgentIds: ['claude'] });
  // Then persistence does not promote an unverified installation on reuse.
  expect(agents[0]).toMatchObject({ available: false, modelsSource: 'fallback', models: [] });
  expect(agents[0]?.diagnostics).toEqual(initial[0]?.diagnostics);
});
