import { describe, expect, it } from 'vitest';
import {
  effectiveAgentModelChoice,
  hasRequiredModelSelection,
} from '../../src/components/agentModelSelection';
import type { AgentInfo } from '../../src/types';

const amrAgent: AgentInfo = {
  id: 'amr',
  name: 'AMR',
  bin: 'amr',
  available: true,
  version: '1.0.0',
  models: [
    { id: 'glm-5', label: 'GLM 5' },
    { id: 'glm-5.1', label: 'GLM 5.1' },
  ],
  supportsCustomModel: false,
};

const codexAgent: AgentInfo = {
  id: 'codex',
  name: 'Codex',
  bin: 'codex',
  available: true,
  version: '1.0.0',
  models: [{ id: 'default', label: 'Default' }],
};

describe('agent model selection', () => {
  it('does not replace a stale saved AMR model with a catalog default', () => {
    expect(
      effectiveAgentModelChoice(amrAgent, {
        model: 'gpt-5.4-mini',
        reasoning: 'medium',
      }),
    ).toBeUndefined();
  });

  it('accepts a catalog model and rejects a stale model for catalog-only agents', () => {
    expect(
      effectiveAgentModelChoice(amrAgent, {
        model: 'glm-5.1',
        reasoning: 'medium',
      }),
    ).toEqual({ model: 'glm-5.1', reasoning: 'medium' });
    expect(
      effectiveAgentModelChoice(amrAgent, { model: 'retired-model' }),
    ).toBeUndefined();
  });

  it('allows a default-only CLI to submit without a meaningless selection', () => {
    expect(hasRequiredModelSelection({
      mode: 'daemon',
      model: '',
      agentId: 'codex',
      agentModels: {},
    }, [codexAgent])).toBe(true);
    expect(effectiveAgentModelChoice(codexAgent, undefined)).toEqual({ model: 'default' });
  });

  it('preserves supported custom model ids instead of silently dropping them', () => {
    expect(
      effectiveAgentModelChoice(codexAgent, {
        model: 'custom-codex-model',
        reasoning: 'high',
      }),
    ).toEqual({ model: 'custom-codex-model', reasoning: 'high' });
  });

  it('still requires an explicit choice when the agent exposes real models', () => {
    expect(hasRequiredModelSelection({
      mode: 'daemon',
      model: '',
      agentId: 'amr',
      agentModels: {},
    }, [amrAgent])).toBe(false);
  });
});
