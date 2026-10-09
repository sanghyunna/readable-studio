import { describe, expect, it } from 'vitest';
import { composeSystemPrompt } from '../../src/prompts/system.js';

const policyOf = (prompt: string) => JSON.parse(prompt.match(/<readable-template-policy>(.*?)<\/readable-template-policy>/s)![1]!);

describe('template subject adaptation', () => {
  it('adapts or drops template slots without demanding unrelated user data', () => {
    const policy = policyOf(composeSystemPrompt({ metadata: { templateRef: { id: 'example-html-ppt-product-launch', name: 'Keynote', boundary: 0 } } }));
    expect(policy.subjectSlots).toBe('adapt-to-user-domain-or-drop');
    expect(policy.missingContent).toBe('question-form');
    expect(policy.missingContentSource).toBe('user-content-only');
    expect(policy.contentSources).toEqual(['user-request', 'user-attachments']);
  });
});
