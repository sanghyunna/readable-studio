import { afterEach, expect, it, vi } from 'vitest';
import { geminiAgentDef } from '../../src/runtimes/defs/gemini.js';
import * as shared from '../../src/runtimes/defs/shared.js';
import { fetchModels } from '../../src/runtimes/detection-model-fetch.js';
import { safeProbe } from '../../src/runtimes/detection-probe.js';
import type { RuntimeAgentDef } from '../../src/runtimes/types.js';

const def: RuntimeAgentDef = geminiAgentDef;
afterEach(() => vi.restoreAllMocks());

it('uses version and help arguments accepted by Gemini 0.1.9 when checking capabilities', async () => {
  // Given the captured 0.1.9 help accepts --version, --help and --yolo.
  const command = vi.spyOn(shared, 'probeAdapterCommand').mockResolvedValue(undefined);
  // When compatibility is checked without supplying an inference prompt.
  await geminiAgentDef.compatibilityProbe('gemini', {});
  // Then discovery is a help-only call, not an inference or model-list attempt.
  expect(def.versionArgs).toEqual(['--version']);
  expect(command).toHaveBeenCalledExactlyOnceWith('gemini', ['--yolo', '--help'], {});
});

it('declares plain output when Gemini lacks an output-format option', () => {
  // Given the captured CLI rejects --output-format.
  // When the runtime selects its stream decoder.
  const format = def.streamFormat;
  // Then it cannot route ordinary text through the JSON event parser.
  expect(format).toBe('plain');
  expect(def.eventParser).toBeUndefined();
});

it('returns an unverified empty catalogue when Gemini has no live listing', async () => {
  // Given no supported listing command exists in the captured CLI help.
  expect(def.listModels).toBeUndefined();
  expect(def.fetchModels).toBeUndefined();
  // When the real shared model-discovery policy reads the definition.
  const result = await fetchModels(def, 'gemini', {});
  // Then no configured or static model is presented as live.
  expect(result).toMatchObject({ models: [], source: 'fallback', failure: { kind: 'unverified' } });
  expect(def.fallbackModels).toEqual([]);
});

it('keeps Gemini unavailable when executable probes succeed without live model discovery', async () => {
  // Given an invocable executable and a successful metadata-only capability probe.
  vi.spyOn(shared, 'probeAdapterCommand').mockResolvedValue(undefined);
  // When real detection runs with a deterministic local executable override.
  const agent = await safeProbe(def, { GEMINI_BIN: process.execPath });
  // Then a successful version/help probe alone cannot establish usability.
  expect(agent).toMatchObject({ available: false, modelsSource: 'fallback', models: [] });
  expect(agent.diagnostics?.map((diagnostic) => diagnostic.reason)).toEqual(['auth-unknown']);
});
