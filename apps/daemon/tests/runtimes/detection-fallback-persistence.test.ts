import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../src/runtimes/registry.js', async () => {
  const { claudeAgentDef } = await import('../../src/runtimes/defs/claude.js');
  return { AGENT_DEFS: [claudeAgentDef], DEFAULT_ENABLED_AGENT_IDS: ['claude'] };
});
vi.mock('../../src/runtimes/invocation.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/runtimes/invocation.js')>(),
  execAgentFile: vi.fn(async (_command: string, args: string[]) => {
    if (args.includes('--version')) return { stdout: 'test-version', stderr: '' };
    if (args.includes('--help')) return { stdout: '', stderr: '' };
    throw new Error('Test CLI is not authenticated');
  }),
}));
vi.mock('../../src/runtimes/defs/claude-model-discovery.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/runtimes/defs/claude-model-discovery.js')>(),
  discoverClaudeCatalog: vi.fn(async () => { throw new Error('Test catalogue discovery failed'); }),
}));
import { _resetAgentDetectionCacheForTests, configureDetectionStorage, detectAgents } from '../../src/runtimes/detection.js';
import { readStoredAgentScan } from '../../src/runtimes/detection-store.js';
import { execAgentFile } from '../../src/runtimes/invocation.js';
import { discoverClaudeCatalog } from '../../src/runtimes/defs/claude-model-discovery.js';

let root: string;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), 'fallback-persistence-'));
  _resetAgentDetectionCacheForTests();
  configureDetectionStorage(root);
});
afterEach(async () => {
  _resetAgentDetectionCacheForTests();
  await rm(root, { recursive: true, force: true });
});

it('preserves unavailable fallback results when a completed scan is reused', async () => {
  // Given an isolated Claude inventory with no routes and failed CLI discovery.
  // Keep the real probe, fallback decision, and persistence; fake only external CLI calls.
  const env = { claude: { CLAUDE_BIN: process.execPath, MMD_MODEL_ROUTES_FILE: join(root, 'absent.json') } };
  const initial = await detectAgents(env, { enabledAgentIds: ['claude'] });
  const stored = await readStoredAgentScan(root);
  expect(stored?.results[0]).toMatchObject({ id: 'claude', available: false, modelsSource: 'fallback', models: [] });
  expect(discoverClaudeCatalog).toHaveBeenCalledTimes(1);
  expect(execAgentFile).toHaveBeenCalledTimes(3);
  _resetAgentDetectionCacheForTests();
  configureDetectionStorage(root);
  vi.clearAllMocks();
  // When a new process-equivalent cache reads the persisted scan.
  const agents = await detectAgents(env, { enabledAgentIds: ['claude'] });
  // Then persistence does not promote an unverified installation on reuse or reprobe it.
  expect(agents[0]).toMatchObject({ available: false, modelsSource: 'fallback', models: [] });
  expect(agents[0]?.diagnostics).toEqual(initial[0]?.diagnostics);
  expect(discoverClaudeCatalog).not.toHaveBeenCalled();
  expect(execAgentFile).not.toHaveBeenCalled();
});
