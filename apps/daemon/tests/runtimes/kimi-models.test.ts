import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kimiAgentDef } from '../../src/runtimes/defs/kimi.js';
import { fetchModels } from '../../src/runtimes/detection-model-fetch.js';
import { DEFAULT_MODEL_OPTION } from '../../src/runtimes/models.js';

test('Kimi failed ACP discovery never substitutes unconfigured provider model IDs', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kimi-models-test-'));
  try {
    const result = await fetchModels(kimiAgentDef, join(home, 'absent-kimi.exe'), {});
    assert.deepEqual(result.models, []);
    assert.equal(result.source, 'fallback');
    assert.equal(result.failure?.kind, 'discovery-failed');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Kimi unavailable and offline fallback has no concrete model selectors', () => {
  assert.deepEqual(kimiAgentDef.fallbackModels, [DEFAULT_MODEL_OPTION]);
});
