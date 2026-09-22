import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_ENABLED_AGENT_IDS, readAppConfig, writeAppConfig } from '../src/app-config.js';
import { AGENT_DEFS } from '../src/runtimes/registry.js';
import { LEGACY_ENABLED_AGENT_IDS } from './app-config-agents.fixture.js';

let dataDir: string;
let file: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'readable-agent-migration-'));
  file = path.join(dataDir, 'app-config.json');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(dataDir, { recursive: true, force: true });
});

it('returns the complete registry selection when config is fresh', async () => {
  // Given an empty data directory, when config is read, then every adapter is enabled.
  const config = await readAppConfig(dataDir);
  expect(config.enabledAgentIds).toEqual(AGENT_DEFS.map((agent) => agent.id));
});

it.each([{ enabledAgentIds: ['claude'] }, { enabledAgentIds: [] }])('preserves an explicit persisted selection $enabledAgentIds without history', async ({ enabledAgentIds }) => {
  // Given an explicit selection with neither default agent and no offered history.
  await writeFile(file, JSON.stringify({ enabledAgentIds }));
  // When the config is read.
  const config = await readAppConfig(dataDir);
  // Then no default or newly offered adapter is added.
  expect(config.enabledAgentIds).toEqual(enabledAgentIds);
});

it.each(['agent', 'cursor'])('normalizes the persisted %s alias without adding other agents', async (alias) => {
  // Given a legacy Cursor alias on disk.
  await writeFile(file, JSON.stringify({ enabledAgentIds: [alias] }));
  // When the config is read.
  const config = await readAppConfig(dataDir);
  // Then only the canonical Cursor adapter is enabled.
  expect(config.enabledAgentIds).toEqual(['cursor-agent']);
});

it('allows opting in to every catalog adapter through preference writes', async () => {
  // Given the full catalog available to Settings.
  const enabledAgentIds = AGENT_DEFS.map((agent) => agent.id);
  // When Settings saves that explicit selection.
  await writeAppConfig(dataDir, { enabledAgentIds });
  // Then all adapters remain enableable.
  expect((await readAppConfig(dataDir)).enabledAgentIds).toEqual(enabledAgentIds);
});

it('preserves the measured 22-id legacy selection without adding newly shipped agents', async () => {
  expect(LEGACY_ENABLED_AGENT_IDS).toHaveLength(22);
  expect(LEGACY_ENABLED_AGENT_IDS).toContain('pi');
  expect(LEGACY_ENABLED_AGENT_IDS).not.toContain('databricks');
  await writeFile(file, JSON.stringify({ enabledAgentIds: LEGACY_ENABLED_AGENT_IDS }));

  const config = await readAppConfig(dataDir);

  expect(config.enabledAgentIds).toEqual(LEGACY_ENABLED_AGENT_IDS);
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  expect(persisted.enabledAgentIds).toEqual(config.enabledAgentIds);
  expect(persisted.offeredAgentIds).toEqual(expect.arrayContaining(LEGACY_ENABLED_AGENT_IDS));
});

it('keeps an explicitly disabled offered agent off across subsequent reads and a restart', async () => {
  await writeFile(file, JSON.stringify({ enabledAgentIds: LEGACY_ENABLED_AGENT_IDS }));
  const offered = await readAppConfig(dataDir);
  expect(offered.offeredAgentIds).toContain('databricks');

  const enabledAgentIds = LEGACY_ENABLED_AGENT_IDS.filter((id) => id !== 'codex');
  await writeAppConfig(dataDir, { enabledAgentIds });
  expect((await readAppConfig(dataDir)).enabledAgentIds).toEqual(enabledAgentIds);

  // Reload the module so no in-memory state can preserve the opt-out for us.
  vi.resetModules();
  const restarted = await import('../src/app-config.js');
  const config = await restarted.readAppConfig(dataDir);
  expect(config.enabledAgentIds).toEqual(enabledAgentIds);
  expect(config.offeredAgentIds).toContain('databricks');
});

it('keeps unseen and explicitly disabled ids out of the selection', async () => {
  await writeFile(file, JSON.stringify({
    enabledAgentIds: LEGACY_ENABLED_AGENT_IDS.filter((id) => id !== 'codex'),
    offeredAgentIds: LEGACY_ENABLED_AGENT_IDS,
  }));

  const config = await readAppConfig(dataDir);
  expect(config.enabledAgentIds).toEqual(LEGACY_ENABLED_AGENT_IDS.filter((id) => id !== 'codex'));
  expect((await readAppConfig(dataDir)).enabledAgentIds).toEqual(config.enabledAgentIds);
});

it('records the offered catalog on the first explicit selection, including an empty selection', async () => {
  await writeAppConfig(dataDir, { enabledAgentIds: [] });
  const config = await readAppConfig(dataDir);
  expect(config.enabledAgentIds).toEqual([]);
  expect(config.offeredAgentIds).toEqual(AGENT_DEFS.map((agent) => agent.id));
});

it('does not let preference updates erase offered history and resurrect disabled agents', async () => {
  await writeAppConfig(dataDir, { enabledAgentIds: ['codex'] });
  await writeAppConfig(dataDir, { offeredAgentIds: [], skillId: 'coder' });
  await writeAppConfig(dataDir, { offeredAgentIds: null });
  const config = await readAppConfig(dataDir);
  expect(config.enabledAgentIds).toEqual(['codex']);
  expect(config.offeredAgentIds).toEqual(AGENT_DEFS.map((agent) => agent.id));
  expect(config.skillId).toBe('coder');
});

it('does not rewrite or grow persisted state on consecutive reads after migration', async () => {
  await writeFile(file, JSON.stringify({ enabledAgentIds: LEGACY_ENABLED_AGENT_IDS }));
  const first = await readAppConfig(dataDir);
  const persisted = await readFile(file, 'utf8');
  // A fixed filesystem marker detects a rewrite without waiting for a clock tick.
  await utimes(file, 1, 1);
  const before = await stat(file);

  expect(await readAppConfig(dataDir)).toEqual(first);
  expect(await readFile(file, 'utf8')).toBe(persisted);
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
});

it('retains disabled history while an adapter is absent and after it returns', async () => {
  const profileId = 'returning-local-agent';
  await writeFile(file, JSON.stringify({
    enabledAgentIds: ['codex'],
    offeredAgentIds: [...DEFAULT_ENABLED_AGENT_IDS, profileId],
  }));
  await readAppConfig(dataDir);
  await writeAppConfig(dataDir, { skillId: 'coder' });
  expect(JSON.parse(await readFile(file, 'utf8')).offeredAgentIds).toContain(profileId);

  const profilesFile = path.join(dataDir, 'agents.local.json');
  await writeFile(profilesFile, JSON.stringify({
    agents: [{ id: profileId, baseAgent: 'claude' }],
  }));
  vi.stubEnv('READABLE_AGENT_PROFILES_CONFIG', profilesFile);
  vi.resetModules();
  const restarted = await import('../src/app-config.js');
  expect(restarted.DEFAULT_ENABLED_AGENT_IDS).toContain(profileId);
  const config = await restarted.readAppConfig(dataDir);
  expect(config.enabledAgentIds).toEqual(['codex']);
  expect(config.offeredAgentIds).toContain(profileId);
});

it('offers a future local adapter without widening the existing selection', async () => {
  await writeAppConfig(dataDir, { enabledAgentIds: ['codex'] });
  const profileId = 'new-release-agent';
  const profilesFile = path.join(dataDir, 'agents.local.json');
  await writeFile(profilesFile, JSON.stringify({
    agents: [{ id: profileId, baseAgent: 'claude' }],
  }));
  vi.stubEnv('READABLE_AGENT_PROFILES_CONFIG', profilesFile);
  vi.resetModules();
  const restarted = await import('../src/app-config.js');

  const config = await restarted.readAppConfig(dataDir);
  expect(config.enabledAgentIds).toEqual(['codex']);
  expect(config.offeredAgentIds).toContain(profileId);
});
