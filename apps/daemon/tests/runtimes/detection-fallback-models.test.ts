import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { claudeAgentDef } from '../../src/runtimes/defs/claude.js';
import { createDatabricksAgentDef } from '../../src/runtimes/defs/databricks.js';
import { fetchModels } from '../../src/runtimes/detection-model-fetch.js';
import { safeProbe } from '../../src/runtimes/detection-probe.js';
import { runtimeServiceFixture } from '../databricks/runtime-fixture.js';
import type { RuntimeAgentDef } from '../../src/runtimes/types.js';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'fallback-models-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

it('makes Claude available with nine fallback models when optional routes are absent', async () => {
  // Given the real Claude adapter with an isolated absent routes file and an invocable version command.
  const env = { CLAUDE_BIN: process.execPath, MMD_MODEL_ROUTES_FILE: join(home, 'absent.json') };
  // When detection runs through the real model-fetch and probe seams.
  const agent = await safeProbe(claudeAgentDef, env);
  // Then the declared catalogue is available without an unverified diagnostic.
  expect(agent).toMatchObject({ available: true, modelsSource: 'fallback', models: claudeAgentDef.fallbackModels });
  expect(agent.models).toHaveLength(9);
  expect(agent.diagnostics).toBeUndefined();
});

it.each([null, [], [{ id: 'default', label: 'Default' }]])('stays unverified without concrete fallback when discovery returns %j', async (models) => {
  // Given an invocable adapter without usable fallback models.
  const def: RuntimeAgentDef = { ...claudeAgentDef, fallbackModels: [], fetchModels: async () => models };
  // When discovery runs.
  const result = await fetchModels(def, process.execPath, {});
  const agent = await safeProbe(def, { CLAUDE_BIN: process.execPath });
  // Then the failure is preserved through the public diagnostic rather than fabricated models.
  expect(result).toMatchObject({ models: [], failure: { kind: 'unverified' } });
  expect(agent).toMatchObject({ available: false, models: [], diagnostics: [{ reason: 'auth-unknown', message: result.failure?.message }] });
});

it('rejects a sentinel-only fallback when live discovery is absent', async () => {
  // Given no concrete models in either source.
  const def: RuntimeAgentDef = { ...claudeAgentDef, fallbackModels: [{ id: 'default', label: 'Default' }], fetchModels: async () => null };
  // When models are fetched.
  const result = await fetchModels(def, process.execPath, {});
  // Then a routing sentinel cannot establish readiness.
  expect(result).toMatchObject({ models: [], failure: { kind: 'unverified' } });
});

it.each(['Authentication required', 'Unknown option --output-format', 'Connection refused'])('preserves proven discovery failure despite fallback: %s', async (message) => {
  // Given a concrete catalogue whose discovery fails, rather than returning no data.
  const def: RuntimeAgentDef = { ...claudeAgentDef, fetchModels: async () => { throw new Error(message); } };
  // When detection observes that failure.
  const agent = await safeProbe(def, { CLAUDE_BIN: process.execPath });
  // Then the catalogue does not override the failure.
  expect(agent).toMatchObject({ available: false, models: [] });
  expect(agent.diagnostics?.[0]?.severity).toBe('error');
});

it('keeps Databricks available but empty when its CLI is ready and registration is empty', async () => {
  // Given the managed adapter with zero registered models.
  const fixture = runtimeServiceFixture();
  fixture.catalogue.models = [];
  fixture.status.cli = 'ready';
  // When managed detection runs.
  const agent = await safeProbe(createDatabricksAgentDef(() => fixture.service));
  // Then model selection remains required and no fallback is invented.
  expect(agent).toMatchObject({ available: true, modelSelectionRequired: true, modelsSource: 'live', models: [] });
  expect(agent.diagnostics?.[0]?.reason).toBe('auth-unknown');
});
