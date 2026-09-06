/**
 * Coverage for daemon-side model admission. A concrete model must be one
 * the user explicitly sent: catalog-only adapters accept surfaced ids,
 * custom-capable adapters may also accept safe free-form ids, and omission
 * never triggers a fallback. The synthetic `default` remains valid only for
 * adapters that surface it as their daemon-owned no-choice sentinel.
 */

import { describe, expect, it } from 'vitest';

import {
  agentHasModelChoice,
  getRememberedLiveModels,
  isKnownModel,
  preferFreshLiveModels,
  rememberLiveModels,
  resolveModelForAgent,
} from '../../src/runtimes/models.js';
import type { RuntimeAgentDef } from '../../src/runtimes/types.js';

function defWith(fallbackIds: string[]): RuntimeAgentDef {
  return {
    id: 'test',
    name: 'Test',
    bin: 'test',
    versionArgs: ['--version'],
    fallbackModels: fallbackIds.map((id) => ({ id, label: id })),
    buildArgs: () => [],
    streamFormat: 'acp-json-rpc',
  };
}

function defWithId(id: string, fallbackIds: string[]): RuntimeAgentDef {
  return {
    ...defWith(fallbackIds),
    id,
  };
}

describe('resolveModelForAgent', () => {
  it('does not substitute a concrete fallback when the model is omitted', () => {
    const def = defWith(['gpt-5.4-mini', 'gpt-5.4']);
    expect(resolveModelForAgent(def, null)).toBe(null);
  });

  it('rejects the synthetic "default" id when the adapter does not surface it', () => {
    const def = defWith(['gpt-5.4-mini', 'gpt-5.4']);
    expect(resolveModelForAgent(def, 'default')).toBe(null);
  });

  it('does not substitute the first remembered live model for an omitted selection', () => {
    const def = defWithId('live-default-test', []);
    rememberLiveModels(def.id, [
      { id: 'deepseek-v3.2', label: 'deepseek-v3.2' },
      { id: 'glm-5.1', label: 'glm-5.1' },
    ]);

    expect(resolveModelForAgent(def, null)).toBe(null);
    expect(resolveModelForAgent(def, 'default')).toBe(null);
    expect(getRememberedLiveModels(def.id)).toEqual([
      { id: 'deepseek-v3.2', label: 'deepseek-v3.2' },
      { id: 'glm-5.1', label: 'glm-5.1' },
    ]);
  });

  it('isolates remembered AMR live models by environment profile scope', () => {
    const def = defWithId('amr', []);
    rememberLiveModels(def.id, [
      { id: 'prod-model', label: 'prod-model' },
    ], 'prod');
    rememberLiveModels(def.id, [
      { id: 'test-model', label: 'test-model' },
    ], 'test');

    expect(getRememberedLiveModels(def.id, 'prod')).toEqual([
      { id: 'prod-model', label: 'prod-model' },
    ]);
    expect(getRememberedLiveModels(def.id, 'test')).toEqual([
      { id: 'test-model', label: 'test-model' },
    ]);
    expect(isKnownModel(def, 'prod-model', 'prod')).toBe(true);
    expect(isKnownModel(def, 'prod-model', 'test')).toBe(false);
    expect(resolveModelForAgent(def, null, {}, 'prod')).toBe(null);
    expect(resolveModelForAgent(def, null, {}, 'test')).toBe(null);
    expect(resolveModelForAgent(def, 'prod-model', {}, 'prod')).toBe('prod-model');
    expect(resolveModelForAgent(def, 'prod-model', {}, 'test')).toBe('prod-model');
  });

  it('prefers remembered live models only when the fresh AMR catalog is empty', () => {
    const remembered = [
      { id: 'deepseek-v3.2', label: 'deepseek-v3.2' },
      { id: 'glm-5.1', label: 'glm-5.1' },
    ];
    const fresh = [{ id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' }];

    expect(preferFreshLiveModels(fresh, remembered)).toEqual(fresh);
    expect(preferFreshLiveModels([], remembered)).toEqual(remembered);
  });

  it('rejects the default sentinel when remembered concrete models are available', () => {
    const def = defWithId('live-default-capable-test', ['default']);
    rememberLiveModels(def.id, [
      { id: 'deepseek-v3.2', label: 'deepseek-v3.2' },
    ]);

    expect(agentHasModelChoice(def)).toBe(true);
    expect(resolveModelForAgent(def, null)).toBe(null);
    expect(resolveModelForAgent(def, 'default')).toBe(null);
  });

  it('rejects the default sentinel when the static catalog has concrete choices', () => {
    const def = defWith(['default', 'sonnet']);
    expect(agentHasModelChoice(def)).toBe(true);
    expect(resolveModelForAgent(def, 'default')).toBe(null);
    expect(resolveModelForAgent(def, null)).toBe(null);
  });

  it('accepts a sanitized uncatalogued id when custom models are supported', () => {
    const def = defWith(['gpt-5.4-mini']);
    expect(resolveModelForAgent(def, 'vendor/gpt-5.4-fast')).toBe('vendor/gpt-5.4-fast');
  });

  it('rejects an uncatalogued id when custom models are not supported', () => {
    const def: RuntimeAgentDef = {
      ...defWith(['gpt-5.4-mini']),
      supportsCustomModel: false,
    };
    expect(resolveModelForAgent(def, 'vendor/gpt-5.4-fast')).toBe(null);
  });

  it('accepts a surfaced id when custom models are not supported', () => {
    const def: RuntimeAgentDef = {
      ...defWith(['gpt-5.4-mini']),
      supportsCustomModel: false,
    };
    expect(resolveModelForAgent(def, 'gpt-5.4-mini')).toBe('gpt-5.4-mini');
  });

  it('keeps a no-model CLI sendable through its surfaced default sentinel', () => {
    const def = defWith(['default']);
    expect(agentHasModelChoice(def)).toBe(false);
    expect(resolveModelForAgent(def, 'default')).toBe('default');
    expect(def.buildArgs('prompt', [], [], { model: 'default' })).toEqual([]);
  });

  it('does not use an environment override when the model is omitted', () => {
    const def = defWith(['gpt-5.4-mini']);
    expect(
      resolveModelForAgent(def, null, { VELA_DEFAULT_MODEL: 'gpt-5.5' }),
    ).toBe(null);
  });
});
