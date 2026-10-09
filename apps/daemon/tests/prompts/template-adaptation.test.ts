import { describe, expect, it } from 'vitest';
import { composeSystemPrompt } from '../../src/prompts/system.js';

const policyOf = (prompt: string) => JSON.parse(prompt.match(/<readable-template-policy>(.*?)<\/readable-template-policy>/s)![1]!);

describe('template discovery routing', () => {
  it.each(['example-html-ppt-weekly-report', 'example-html-ppt-product-launch', 'example-finance-report'])('routes %s to content-only clarification', (id) => {
    const prompt = composeSystemPrompt({ metadata: { templateRef: { id, name: id, boundary: 0 } } });
    const policy = JSON.parse(prompt.match(/<readable-clarification-policy>(.*?)<\/readable-clarification-policy>/s)![1]!);
    expect(policy).toEqual({ mode: 'template', structure: 'selected-template', askFor: ['missing-user-content'], format: 'question-form' });
    expect(prompt).not.toMatch(/<question-form id="(?:report-brief|deck-brief|brand-source)"/);
  });
  it('retains ordinary discovery forms', () => {
    const prompt = composeSystemPrompt({ metadata: { kind: 'deck' } });
    expect(prompt).toContain('<question-form id="deck-brief"');
    expect(prompt).not.toContain('<readable-clarification-policy>');
  });
});

describe('template subject adaptation', () => {
  it('adapts or drops template slots without demanding unrelated user data', () => {
    const policy = policyOf(composeSystemPrompt({ metadata: { templateRef: { id: 'example-html-ppt-product-launch', name: 'Keynote', boundary: 0 } } }));
    expect(policy.subjectSlots).toBe('adapt-to-user-domain-or-drop');
    expect(policy.missingContent).toBe('question-form');
    expect(policy.missingContentSource).toBe('user-content-only');
    expect(policy.contentSources).toEqual(['user-request', 'user-attachments']);
  });
});
