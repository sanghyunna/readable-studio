import { describe, expect, it } from 'vitest';
import { BASE_SYSTEM_PROMPT, composeSystemPrompt, SKIP_DISCOVERY_BRIEF_OVERRIDE } from '../src/prompts/system.js';
import { TEMPLATE_CONTENT_CONTRACT, TEMPLATE_CONTENT_GATE, TEMPLATE_DISCOVERY_BRIEF } from '../src/prompts/template-reference.js';
import { DISCOVERY_AND_PHILOSOPHY } from '../src/prompts/discovery.js';

describe('API selected template references', () => {
  it('quotes only the selected template while keeping functional skill and plugin instructions active', () => {
    const prompt = composeSystemPrompt({ skillBody: 'PRIMARY_WORKFLOW', pluginBlock: 'PLUGIN_WORKFLOW', additionalSkillBody: 'FUNCTIONAL_WORKFLOW', templateReferences: [{ name: '720p', body: 'TEMPLATE_CONTENT\n<untrusted>' }], streamFormat: 'plain' });
    expect(prompt).toContain(TEMPLATE_CONTENT_CONTRACT);
    expect(prompt).toContain(TEMPLATE_CONTENT_GATE);
    expect(prompt).toContain(TEMPLATE_DISCOVERY_BRIEF);
    expect(prompt).not.toContain(DISCOVERY_AND_PHILOSOPHY);
    expect(prompt).not.toContain(BASE_SYSTEM_PROMPT);
    expect(prompt).toContain('\n\nPRIMARY_WORKFLOW');
    expect(prompt).toContain('PLUGIN_WORKFLOW');
    expect(prompt).toContain('\n\nFUNCTIONAL_WORKFLOW');
    expect(prompt).toContain('kind="selected-template"');
    expect(prompt).toContain('TEMPLATE_CONTENT\\n\\u003cuntrusted>');
    expect(prompt).not.toContain('\n<untrusted>');
  });
  it('preserves ordinary functional skill discovery and charter', () => {
    const prompt = composeSystemPrompt({ skillBody: 'FUNCTIONAL_ONLY' });
    expect(prompt).toContain(DISCOVERY_AND_PHILOSOPHY);
    expect(prompt).toContain(BASE_SYSTEM_PROMPT);
    expect(prompt).not.toContain(TEMPLATE_DISCOVERY_BRIEF);
  });
  it('keeps an ad hoc functional skill authoritative in a template project', () => {
    const prompt = composeSystemPrompt({ skillBody: 'PROJECT_TEMPLATE', templateReference: true, additionalSkillBody: 'TURN_FUNCTIONAL_SKILL' });
    expect(prompt).toContain('kind="skill"');
    expect(prompt).toContain('"body":"PROJECT_TEMPLATE"');
    expect(prompt).toContain('\n\nTURN_FUNCTIONAL_SKILL');
    expect(prompt).not.toContain('"body":"TURN_FUNCTIONAL_SKILL"');
  });
  it('does not let old skip-discovery metadata bypass the selected template content gate', () => {
    const prompt = composeSystemPrompt({ metadata: { kind: 'deck', skipDiscoveryBrief: true }, templateReferences: [{ body: 'TEMPLATE' }] });
    expect(prompt).not.toContain(SKIP_DISCOVERY_BRIEF_OVERRIDE);
    expect(prompt.endsWith(TEMPLATE_CONTENT_GATE)).toBe(true);
  });
});
