import { describe, expect, it } from 'vitest';
import {
  emittedRenderableQuestionForm,
  findQuestionFormCloseTag,
  questionFormBodyIsRenderable,
} from '../../src/question-form-detect.js';
import { QUESTION_FORM_CLARIFICATION_SECTION, composeSystemPrompt } from '../../src/prompts/system.js';

// Structural contract only: the examples the prompt hands the model must be
// forms the real daemon detector accepts, or the model copies a pattern the
// host cannot render. Prose wording is deliberately not asserted. Only
// attributed open tags count as examples; the bare `<question-form>` mention
// in the prose is exactly what the real detector is built to walk past.
const EXAMPLE_OPEN_RE = /<question-form\s+id="([^"]+)"[^>]*>/g;

function extractForms(text: string): Array<{ id: string; body: string }> {
  const forms: Array<{ id: string; body: string }> = [];
  for (const m of text.matchAll(EXAMPLE_OPEN_RE)) {
    const openEnd = (m.index ?? 0) + m[0].length;
    const closeIdx = findQuestionFormCloseTag(text, openEnd, '</question-form>');
    expect(closeIdx).not.toBe(-1);
    forms.push({ id: m[1] ?? '', body: text.slice(openEnd, closeIdx) });
  }
  return forms;
}

describe('question-form examples embedded in the system prompt', () => {
  const forms = extractForms(QUESTION_FORM_CLARIFICATION_SECTION);

  it('ships at least two examples that the daemon detector accepts as renderable', () => {
    expect(forms.length).toBeGreaterThanOrEqual(2);
    for (const form of forms) {
      expect(form.id).not.toBe('');
      expect(questionFormBodyIsRenderable(form.body)).toBe(true);
    }
    expect(emittedRenderableQuestionForm(QUESTION_FORM_CLARIFICATION_SECTION)).toBe(true);
  });

  it('uses machine-readable ids and option values that survive JSON.parse', () => {
    const types = new Set<string>();
    for (const form of forms) {
      const parsed = JSON.parse(form.body.trim()) as {
        questions: Array<{ id: unknown; type: unknown; options?: unknown; maxSelections?: unknown }>;
      };
      for (const q of parsed.questions) {
        expect(typeof q.id).toBe('string');
        expect(typeof q.type).toBe('string');
        types.add(q.type as string);
        if (Array.isArray(q.options)) {
          for (const opt of q.options) {
            if (typeof opt === 'string') continue;
            expect(typeof (opt as { value: unknown }).value).toBe('string');
            expect(typeof (opt as { label: unknown }).label).toBe('string');
          }
        }
        if (q.maxSelections !== undefined) {
          expect(q.type).toBe('checkbox');
          expect(Number.isInteger(q.maxSelections)).toBe(true);
        }
      }
    }
    // The examples exist so the model sees several shapes, not one.
    expect(types.has('radio')).toBe(true);
    expect(types.has('checkbox')).toBe(true);
    expect(types.has('text') || types.has('textarea')).toBe(true);
  });

  it('does not reuse the reserved discovery or task-type form ids', () => {
    for (const form of forms) {
      expect(['discovery', 'task-type']).not.toContain(form.id);
    }
  });

  it('is composed into every prompt, including the skipDiscoveryBrief path', () => {
    for (const prompt of [
      composeSystemPrompt({}),
      composeSystemPrompt({ metadata: { skipDiscoveryBrief: true } }),
      composeSystemPrompt({ streamFormat: 'plain' }),
    ]) {
      expect(prompt).toContain(QUESTION_FORM_CLARIFICATION_SECTION);
    }
  });
});
