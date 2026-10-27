import { describe, expect, it, vi } from 'vitest';
import type { SkillDetail, SkillSummary } from '@readable-studio/contracts';
import { resolveTurnSkillPrompt } from '../../src/runtime/turn-skill-prompt';

const skill: SkillSummary = { id: 'functional', name: 'Functional', description: '', triggers: [], mode: 'deck', previewType: 'html', designSystemRequired: false, defaultFor: [], upstream: null, hasBody: true, examplePrompt: '', aggregatesExamples: false };
const template: SkillSummary = { ...skill, id: 'template', name: 'Imported 720p', mode: 'deck' };
const detail = (summary: SkillSummary, body: string): SkillDetail => ({ ...summary, body });
describe('API turn skill prompt', () => {
  it('separates catalog templates from functional instructions even when both have deck mode', async () => {
    const fetchSkill = vi.fn(async (id: string) => id === skill.id ? detail(skill, 'Perform functional steps.') : null);
    const fetchTemplate = vi.fn(async () => detail(template, 'Use the authored 1280×720 layout.'));
    const result = await resolveTurnSkillPrompt({ skillIds: [skill.id, template.id, skill.id], skills: [skill], designTemplates: [template], cache: new Map(), fetchSkill, fetchTemplate });
    expect(result.additionalSkillBody).toContain('Perform functional steps.');
    expect(result.additionalSkillBody).not.toContain('1280');
    expect(result.templateReferences).toEqual([{ name: template.name, body: 'Use the authored 1280×720 layout.' }]);
    expect(fetchSkill).toHaveBeenCalledTimes(2);
  });
  it('keeps a selected functional skill authoritative in a template-backed project', async () => {
    const result = await resolveTurnSkillPrompt({ skillIds: [template.id, skill.id], projectSkillId: template.id, skills: [skill], designTemplates: [template], cache: new Map([[skill.id, { body: 'Functional instructions', isTemplate: false }]]), fetchSkill: vi.fn(), fetchTemplate: vi.fn() });
    expect(result).toEqual({ additionalSkillBody: '## Functional\n\nFunctional instructions' });
  });
  it.each(['fresh', 'cached'] as const)('keeps the functional skill authoritative when a template has the same ID (%s)', async (source) => {
    const collidingTemplate = { ...template, id: skill.id };
    const fetchSkill = vi.fn(async () => detail(skill, 'Functional instructions'));
    const fetchTemplate = vi.fn(async () => detail(collidingTemplate, 'Template layout'));
    const options = { skillIds: [skill.id], skills: [skill], designTemplates: [collidingTemplate], cache: new Map(), fetchSkill, fetchTemplate };
    let result = await resolveTurnSkillPrompt(options);
    if (source === 'cached') result = await resolveTurnSkillPrompt(options);
    expect(result).toEqual({ additionalSkillBody: '## Functional\n\nFunctional instructions' });
    expect(fetchSkill).toHaveBeenCalledTimes(1);
    expect(fetchTemplate).not.toHaveBeenCalled();
  });
  it('does not add missing or duplicate default skills', async () => {
    const fetchSkill = vi.fn(async () => null);
    const fetchTemplate = vi.fn(async () => null);
    const result = await resolveTurnSkillPrompt({ skillIds: [skill.id, 'missing', 'missing'], projectSkillId: skill.id, skills: [skill], designTemplates: [], cache: new Map(), fetchSkill, fetchTemplate });
    expect(result).toEqual({});
    expect(fetchSkill).toHaveBeenCalledTimes(1);
  });
});
