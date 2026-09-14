import { describe, expect, it } from 'vitest';
import {
  composerReasoningOptions,
  effectiveAgentModelChoice,
  effectiveReasoningOptions,
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

const HIGH = { id: 'high', label: 'High' };
const XHIGH = { id: 'xhigh', label: 'Extra high' };
const LOW = { id: 'low', label: 'Low' };

const gatewayAgent: AgentInfo = {
  id: 'gateway',
  name: 'Gateway',
  bin: 'gateway',
  available: true,
  version: '1.0.0',
  models: [
    { id: 'wide', label: 'Wide' },
    { id: 'narrow', label: 'Narrow', reasoningOptions: [HIGH] },
    { id: 'flat', label: 'Flat', reasoningOptions: [] },
  ],
  reasoningOptions: [LOW, HIGH, XHIGH],
};

const databricksAgent: AgentInfo = {
  id: 'databricks',
  name: 'Databricks',
  bin: 'databricks',
  available: true,
  version: '1.0.0',
  models: [
    { id: 'sonnet-endpoint', label: 'Sonnet', reasoningOptions: [HIGH, XHIGH] },
    { id: 'llama-endpoint', label: 'Llama' },
  ],
  reasoningOptions: [],
};

describe('effective reasoning options', () => {
  it('uses the agent-wide list when the model advertises none of its own', () => {
    expect(effectiveReasoningOptions(gatewayAgent, 'wide')).toEqual([LOW, HIGH, XHIGH]);
    expect(effectiveReasoningOptions(gatewayAgent, undefined)).toEqual([LOW, HIGH, XHIGH]);
  });

  it('replaces, never merges, the agent-wide list with a per-model list', () => {
    expect(effectiveReasoningOptions(gatewayAgent, 'narrow')).toEqual([HIGH]);
    // An explicit empty per-model list means this model takes no effort.
    expect(effectiveReasoningOptions(gatewayAgent, 'flat')).toEqual([]);
  });

  it('resolves Databricks effort per registered endpoint', () => {
    expect(effectiveReasoningOptions(databricksAgent, 'sonnet-endpoint')).toEqual([HIGH, XHIGH]);
    expect(effectiveReasoningOptions(databricksAgent, 'llama-endpoint')).toEqual([]);
    expect(effectiveReasoningOptions(databricksAgent, undefined)).toEqual([]);
  });

  it('yields nothing without an agent or for a CLI that advertises no levels', () => {
    expect(effectiveReasoningOptions(null, 'sonnet')).toEqual([]);
    expect(effectiveReasoningOptions(codexAgent, 'default')).toEqual([]);
  });

  it('hides Grok Build effort for models its CLI would ignore', () => {
    const grok: AgentInfo = {
      id: 'grok-build',
      name: 'Grok Build',
      bin: 'grok',
      available: true,
      version: '1.0.0',
      models: [
        { id: 'grok-4.20-reasoning', label: 'Grok reasoning' },
        { id: 'grok-4.20-non-reasoning', label: 'Grok fast' },
      ],
      reasoningOptions: [HIGH],
    };
    expect(effectiveReasoningOptions(grok, 'grok-4.20-reasoning')).toEqual([HIGH]);
    expect(effectiveReasoningOptions(grok, 'grok-4.20-non-reasoning')).toEqual([]);
    expect(effectiveReasoningOptions(grok, undefined)).toEqual([]);
  });

  it('reads the composer pick through the same model resolution the run uses', () => {
    const base = { mode: 'daemon' as const, agentId: 'databricks', agentModels: {} };
    expect(composerReasoningOptions(
      { ...base, agentModels: { databricks: { model: 'sonnet-endpoint' } } },
      [databricksAgent],
    )).toEqual([HIGH, XHIGH]);
    // No model picked yet: nothing resolves, so nothing is offered.
    expect(composerReasoningOptions(base, [databricksAgent])).toEqual([]);
    // BYOK mode has no CLI effort levels.
    expect(composerReasoningOptions(
      { ...base, mode: 'api', agentModels: { databricks: { model: 'sonnet-endpoint' } } },
      [databricksAgent],
    )).toEqual([]);
  });
});
