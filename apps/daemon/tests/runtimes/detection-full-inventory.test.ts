import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentScanProgress } from '@readable-studio/contracts';
import type { RuntimeAgentDef } from '../../src/runtimes/types.js';

vi.mock('node:os', async (original) => ({
  ...await original<typeof import('node:os')>(), availableParallelism: () => 2,
}));
vi.mock('../../src/runtimes/detection-probe.js', async (original) => ({
  ...await original<typeof import('../../src/runtimes/detection-probe.js')>(), safeProbe: vi.fn(),
}));

let root: string | undefined;
afterEach(async () => {
  const detection = await import('../../src/runtimes/detection.js');
  detection._resetAgentDetectionCacheForTests();
  vi.unstubAllEnvs();
  vi.resetModules();
  if (root) await rm(root, { recursive: true, force: true });
});

it.each([false, true])('scans every registered agent exactly once with legacy selection and local profile=%s', async (localProfile) => {
  // Given a real persisted old default and a startup-loaded profile file.
  root = await mkdtemp(path.join(tmpdir(), 'full-agent-inventory-'));
  const profileId = 'local-startup-agent';
  const profilesFile = path.join(root, 'agents.local.json');
  await writeFile(profilesFile, JSON.stringify({ agents: localProfile ? [
    { id: profileId, baseAgent: 'claude' },
    { id: profileId, baseAgent: 'claude' },
    { id: 'codex', baseAgent: 'claude' },
    { id: 'invalid profile', baseAgent: 'claude' },
  ] : [] }));
  await writeFile(path.join(root, 'app-config.json'), JSON.stringify({ enabledAgentIds: ['codex', 'cursor-agent'] }));
  vi.stubEnv('READABLE_AGENT_PROFILES_CONFIG', profilesFile);
  vi.stubEnv('READABLE_SANDBOX_MODE', '0');
  vi.resetModules();
  const { AGENT_DEFS } = await import('../../src/runtimes/registry.js');
  const { readAppConfig } = await import('../../src/app-config.js');
  const detection = await import('../../src/runtimes/detection.js');
  const { safeProbe } = await import('../../src/runtimes/detection-probe.js');
  const expectedIds = AGENT_DEFS.map(({ id }) => id);
  const visits: string[] = [];
  const progress: Array<AgentScanProgress | null> = [];
  vi.mocked(safeProbe).mockImplementation(async (def: RuntimeAgentDef) => {
    visits.push(def.id);
    progress.push(detection.getStartupScanProgress());
    return { ...def, available: false, models: [], modelsSource: 'live' };
  });
  detection.configureDetectionStorage(root);
  const config = await readAppConfig(root);

  // When startup uses the persisted selection at the shared detection boundary.
  const agents = await detection.detectAgents(config.agentCliEnv, { enabledAgentIds: config.enabledAgentIds ?? [] });

  // Then scan inventory/progress/storage are exhaustive, while capability output is restrictive.
  expect(expectedIds).toHaveLength(localProfile ? 24 : 23);
  expect(new Set(expectedIds).size).toBe(expectedIds.length);
  expect(visits).toEqual(expectedIds);
  expect(progress.map((entry) => entry?.currentAgentId)).toEqual(expectedIds);
  expect(progress.map((entry) => entry?.completed)).toEqual(expectedIds.map((_, index) => index));
  expect(progress.map((entry) => entry?.total)).toEqual(expectedIds.map(() => expectedIds.length));
  expect(detection.getStartupScanProgress()).toMatchObject({ phase: 'done', completed: expectedIds.length, total: expectedIds.length });
  expect(agents.map(({ id }) => id)).toEqual(['codex', 'cursor-agent']);
  expect(config.enabledAgentIds).toEqual(['codex', 'cursor-agent']);
  const stored = JSON.parse(await readFile(path.join(root, 'agent-scan.json'), 'utf8'));
  expect(stored.agentIds).toEqual(expectedIds);
  expect(stored.results.map((agent: { readonly id: string }) => agent.id)).toEqual(AGENT_DEFS.filter((def) => def.modelManagement !== 'databricks').map(({ id }) => id));
  process.stdout.write(`${JSON.stringify({ localProfile, expectedIds, visits, progress, terminal: detection.getStartupScanProgress(), enabledIds: agents.map(({ id }) => id) })}\n`);
});
