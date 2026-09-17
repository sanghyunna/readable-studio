import { describe, expect, it } from 'vitest';
import {
  agentHasModelChoice,
  isKnownModel,
  rememberLiveModels,
  resolveModelForAgent,
} from '../../src/runtimes/models.js';
import type { RuntimeAgentDef } from '../../src/runtimes/types.js';

const definition: RuntimeAgentDef = {
  id: 'explicit-empty-catalogue', name: 'Explicit model fixture', bin: 'fixture',
  versionArgs: [], fallbackModels: [{ id: 'openai/gpt-5', label: 'GPT-5' }],
  buildArgs: () => [], streamFormat: 'json-stream',
};

describe('explicit selection with empty discovery', () => {
  it.each(['openai/gpt-5', 'custom/new-model'])('accepts %s when the remembered set is empty', (model) => {
    // Given
    rememberLiveModels(definition.id, []);
    // When
    const resolved = resolveModelForAgent(definition, model);
    // Then
    expect(resolved).toBe(model);
  });

  it.each([null, undefined, '', ' ', 'default'])('refuses %s when no concrete model was selected', (model) => {
    // Given
    rememberLiveModels(definition.id, []);
    // When
    const resolved = resolveModelForAgent(definition, model);
    // Then
    expect(resolved).toBeNull();
  });

  it.each([definition, { ...definition, fallbackModels: [] }])('requires a selection when discovery has no models for $id', (def) => {
    // Given
    rememberLiveModels(def.id, []);
    // When
    const required = agentHasModelChoice(def);
    // Then
    expect(required).toBe(true);
  });

  it('accepts a static catalog selection when custom models are disabled and discovery is empty', () => {
    // Given
    const def = { ...definition, supportsCustomModel: false };
    rememberLiveModels(def.id, []);
    // When
    const resolved = resolveModelForAgent(def, 'openai/gpt-5');
    // Then
    expect(resolved).toBe('openai/gpt-5');
  });

  it('refuses an unregistered selection when custom models are disabled', () => {
    // Given
    const def = { ...definition, supportsCustomModel: false };
    rememberLiveModels(def.id, []);
    // When
    const resolved = resolveModelForAgent(def, 'custom/new-model');
    // Then
    expect(resolved).toBeNull();
  });

  it.each(['--model', 'model with spaces', 'model\nflag'])('refuses unsafe custom id %s when discovery is empty', (model) => {
    // Given
    rememberLiveModels(definition.id, []);
    // When
    const resolved = resolveModelForAgent(definition, model);
    // Then
    expect(resolved).toBeNull();
  });

  it('keeps static models unverified when discovery is empty', () => {
    // Given
    rememberLiveModels(definition.id, []);
    // When
    const known = isKnownModel(definition, 'openai/gpt-5');
    // Then
    expect(known).toBe(false);
  });
});
