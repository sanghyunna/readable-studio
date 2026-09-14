import { describe, expect, it } from 'vitest';
import { emittedRenderableQuestionForm as sharedDetector } from '@readable-studio/contracts';
import { emittedRenderableQuestionForm } from '../src/question-form-detect.js';

const body = '{"questions":[{"id":"scope","label":"Scope?","type":"text"}]}';
const form = `<question-form id="real" title="Brief">\n${body}\n</question-form>`;

describe('question-form detection', () => {
  it('uses the shared detector exercised against the web parser', () => {
    expect(emittedRenderableQuestionForm).toBe(sharedDetector);
  });

  it.each([
    ['prose mention', 'Here is a <question-form> for you.', false],
    ['prose mention then form', `Here is a <question-form> for you.\n${form}`, true],
    ['backtick mention then form', `Here is a \`<question-form>\` for you.\n${form}`, true],
    ['code span', `\`${form}\``, false],
    ['multiline code span', `\`example\n${form}\n\``, false],
    ['fenced code', `\`\`\`html\n${form}\n\`\`\``, false],
    ['tilde fence', `~~~html\n${form}\n~~~`, false],
    ['unclosed fence', `\`\`\`html\n${form}`, false],
    ['fenced sample then real form', `\`\`\`html\n${form}\n\`\`\`\n${form}`, true],
    ['valid form', form, true],
    ['optional attributes', `<question-form>${body}</question-form>`, true],
    ['alias', `<ASK-QUESTION>${body}</ASK-QUESTION>`, true],
    ['fenced JSON body', `<question-form>\n\`\`\`json\n${body}\n\`\`\`\n</question-form>`, true],
    ['malformed JSON', '<question-form>\n{broken}\n</question-form>', false],
    ['truncated stream', '<question-form>\n{"questions":[', false],
    ['complete body without close', `<question-form>${body}`, true],
    ['standalone mention then form', `<question-form>\n${form}`, true],
    ['malformed candidate then form', `<question-form>\n{broken}\n${form}`, true],
    ['mismatched close', `<question-form>${body}</ask-question>`, false],
  ] as const)('%s', (_name, input, expected) => {
    expect(emittedRenderableQuestionForm(input)).toBe(expected);
  });
});
