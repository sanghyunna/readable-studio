import { describe, expect, it } from 'vitest';

import {
  parseQoderModels,
  qoderAgentDef,
} from '../../src/runtimes/defs/qoder.js';
import { fetchModels } from '../../src/runtimes/detection-model-fetch.js';

describe('Qoder model discovery', () => {
  it('parses the structured account catalogue and keeps a known-good model', () => {
    expect(parseQoderModels(JSON.stringify({
      models: [
        { modelId: 'performance', displayName: 'Performance' },
        { id: 'custom/model-v2', label: 'Custom Model V2' },
        { id: 'performance', label: 'duplicate' },
      ],
    }))).toEqual([
      { id: 'default', label: 'Default (CLI config)' },
      { id: 'performance', label: 'Performance' },
      { id: 'custom/model-v2', label: 'Custom Model V2' },
    ]);
  });

  it('parses the human-readable tier list conservatively', () => {
    expect(parseQoderModels('Available models:\n- Lite\n- ultimate  Ultimate\n')).toEqual([
      { id: 'default', label: 'Default (CLI config)' },
      { id: 'lite', label: 'Lite' },
      { id: 'ultimate', label: 'Ultimate' },
    ]);
  });

  it('rejects unauthenticated output and falls back when the probe fails', async () => {
    expect(parseQoderModels('Not logged in. Run `qodercli login` to authenticate.')).toBeNull();
    const result = await fetchModels(qoderAgentDef, 'missing-qodercli', process.env);
    expect(result.source).toBe('fallback');
    expect(result.models.map((model) => model.id)).toContain('performance');
  });
});
