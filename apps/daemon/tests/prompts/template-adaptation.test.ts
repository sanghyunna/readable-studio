import { describe, expect, it } from 'vitest';
import { composeSystemPrompt } from '../../src/prompts/system.js';
import { DISCOVERY_AND_PHILOSOPHY } from '../../src/prompts/discovery.js';
import { DECK_FRAMEWORK_DIRECTIVE } from '../../src/prompts/deck-framework.js';
import { OFFICIAL_DESIGNER_PROMPT } from '../../src/prompts/official-system.js';

const policyOf = (prompt: string) => JSON.parse(prompt.match(/<readable-template-policy>(.*?)<\/readable-template-policy>/s)![1]!);

describe('template discovery routing', () => {
  it.each(['example-html-ppt-weekly-report', 'example-html-ppt-product-launch', 'example-finance-report'])('routes %s to content-only clarification', (id) => {
    const prompt = composeSystemPrompt({ metadata: { templateRef: { id, name: id, boundary: 0 } } });
    const policy = JSON.parse(prompt.match(/<readable-clarification-policy>(.*?)<\/readable-clarification-policy>/s)![1]!);
    expect(policy).toEqual({ mode: 'template', structure: 'selected-template', askFor: ['missing-user-content'], format: 'question-form' });
    expect(prompt).not.toMatch(/<question-form id="(?:report-brief|deck-brief|brand-source)"/);
    expect(prompt).not.toContain('kind="workflow-background"');
  });
  it('keeps owner workflow and charter instructions authoritative, then pins the template gate', () => {
    const prompt = composeSystemPrompt({
      templateReference: true,
      editablePromptBodies: {
        'discovery-workflow': 'OWNER_WORKFLOW_723',
        'designer-charter': 'OWNER_CHARTER_723',
        'deck-framework': 'OWNER_DECK_723',
      },
      metadata: { kind: 'deck' },
    });
    const outside = prompt.replace(/<readable-template-reference[^>]*>.*?<\/readable-template-reference>/gs, '');
    for (const marker of ['OWNER_WORKFLOW_723', 'OWNER_CHARTER_723', 'OWNER_DECK_723']) {
      expect(outside).toContain(marker);
      expect(outside.indexOf(marker)).toBeLessThan(outside.indexOf('<readable-template-content-gate>'));
    }
    const gate = JSON.parse(prompt.match(/<readable-template-content-gate>(.*?)<\/readable-template-content-gate>/s)![1]!);
    expect(gate).toEqual({
      version: 1, source: 'user-content-only',
      askWhen: ['no-substantive-content', 'explicitly-requested-content-missing'],
      optionalFields: 'omit', otherwise: 'generate', output: 'index.html',
      factFidelity: { factSources: ['user-request', 'user-attachments'], outsideFacts: 'forbidden', suppliedFacts: 'preserve-all-verbatim', unsuppliedFields: 'omit' },
    });
    expect(policyOf(prompt).contentSources).toEqual(['user-request', 'user-attachments']);
  });
  it('recognizes the resolved shipped workflow without restoring ordinary forms', () => {
    const input = { templateReference: true };
    const defaultPrompt = composeSystemPrompt(input);
    expect(composeSystemPrompt({ ...input, editablePromptBodies: {
      'designer-charter': '', 'deck-framework': '', 'discovery-workflow': DISCOVERY_AND_PHILOSOPHY,
    } })).not.toMatch(/<question-form id="(?:report-brief|deck-brief|brand-source)"/);
    expect(defaultPrompt).toContain('<readable-template-content-gate>');
  });
  it('retains ordinary discovery forms', () => {
    const prompt = composeSystemPrompt({ metadata: { kind: 'deck' } });
    expect(prompt).toContain('<question-form id="deck-brief"');
    expect(prompt).not.toContain('<readable-clarification-policy>');
    expect(prompt).not.toContain('<readable-template-content-gate>');
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

describe('template canvas resolution', () => {
  it('makes template dimensions authoritative in both deck instruction layers', () => {
    for (const directive of [OFFICIAL_DESIGNER_PROMPT, DECK_FRAMEWORK_DIRECTIVE]) {
      expect(directive).toContain("Preserve a supplied template's explicit canvas resolution, aspect ratio, and layout");
      expect(directive).toContain('1920×1080 is only the default when no template defines a canvas size');
    }
    expect(DECK_FRAMEWORK_DIRECTIVE).toContain('takes precedence over all copy-verbatim rules and numeric examples below');
    expect(DECK_FRAMEWORK_DIRECTIVE).toContain('stage dimensions, scale-to-fit calculations, print page size, and density guidance');
    expect(DECK_FRAMEWORK_DIRECTIVE).toContain('vertical decks without an explicitly sized supplied template');
  });

  it.each([
    { resolution: '1280×720', body: 'Use a 1280×720 canvas.' },
    { resolution: '900×1200', body: 'Use a 900×1200 canvas.' },
    { resolution: '900×1200', body: 'Use assets/template.html with a 900×1200 canvas.' },
  ])('keeps $resolution template guidance in the composed deck prompt', ({ resolution, body }) => {
    const prompt = composeSystemPrompt({
      skillMode: 'deck',
      skillBody: body,
      templateReference: true,
      metadata: { kind: 'deck' },
    });
    expect(prompt).toContain(resolution);
    expect(prompt).toContain("Preserve a supplied template's explicit canvas resolution, aspect ratio, and layout");
    expect(prompt).toContain('1920×1080 is only the default when no template defines a canvas size');
  });
});
