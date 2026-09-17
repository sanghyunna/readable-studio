import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { _resetAgentDetectionCacheForTests, configureDetectionStorage, detectAgents } from '../../src/runtimes/detection.js';
import { claudeAgentDef } from '../../src/runtimes/defs/claude.js';

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

it('preserves available fallback models when a completed scan is reused', async () => {
  // Given a completed Claude scan with no optional local routes.
  const env = { claude: { CLAUDE_BIN: process.execPath, MMD_MODEL_ROUTES_FILE: join(root, 'absent.json') } };
  await detectAgents(env, { enabledAgentIds: ['claude'] });
  _resetAgentDetectionCacheForTests();
  configureDetectionStorage(root);
  // When a new process-equivalent cache reads the persisted scan.
  const agents = await detectAgents(env, { enabledAgentIds: ['claude'] });
  // Then fallback availability is not silently revoked on the next request.
  expect(agents[0]).toMatchObject({ available: true, modelsSource: 'fallback', models: claudeAgentDef.fallbackModels });
});
