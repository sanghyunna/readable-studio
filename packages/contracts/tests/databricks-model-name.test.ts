import { describe, expect, it } from 'vitest';
import { matchesDatabricksModelSearch, splitDatabricksModelName } from '../src/index.js';

describe('splitDatabricksModelName', () => {
  it.each([
    ['system.ai.gpt-oss-120b', 'gpt-oss-120b', 'system.ai'],
    ['system.ai.qwen3-next-80b-a3b-instruct', 'qwen3-next-80b-a3b-instruct', 'system.ai'],
    ['app_dev.default.oai-luna-model-service', 'oai-luna-model-service', 'app_dev.default'],
    ['app_dev.default.c-sonnet-model-service', 'c-sonnet-model-service', 'app_dev.default'],
    ['system.ai.llama-3.1-70b', 'llama-3.1-70b', 'system.ai'],
  ])('splits %s at the first two periods', (name, model, path) => {
    expect(splitDatabricksModelName(name)).toEqual({ model, path });
  });

  it.each(['gpt-5.6-luna', 'databricks-claude-sonnet-4', 'plain'])('keeps %s whole when it has fewer than two periods', (name) => {
    expect(splitDatabricksModelName(name)).toEqual({ model: name, path: null });
  });

  it('keeps degenerate dotted names whole', () => {
    expect(splitDatabricksModelName('a..b')).toEqual({ model: 'a..b', path: null });
    expect(splitDatabricksModelName('a.b.')).toEqual({ model: 'a.b.', path: null });
    expect(splitDatabricksModelName('.a.b')).toEqual({ model: '.a.b', path: null });
  });
});

describe('matchesDatabricksModelSearch', () => {
  const endpoint = { label: 'claude-sonnet-4', displayName: 'app_dev.default.c-sonnet-model-service', servedModelName: 'claude-sonnet-4' };

  it('matches the model name, the UC path and the full original name case-insensitively', () => {
    expect(matchesDatabricksModelSearch(endpoint, 'SONNET')).toBe(true);
    expect(matchesDatabricksModelSearch(endpoint, 'app_dev.default')).toBe(true);
    expect(matchesDatabricksModelSearch(endpoint, 'app_dev.default.c-sonnet-model-service')).toBe(true);
    expect(matchesDatabricksModelSearch(endpoint, 'c-sonnet-model')).toBe(true);
  });

  it('rejects a query no name contains and accepts a blank query', () => {
    expect(matchesDatabricksModelSearch(endpoint, 'gpt')).toBe(false);
    expect(matchesDatabricksModelSearch(endpoint, '   ')).toBe(true);
  });
});
