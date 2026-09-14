import { describe, expect, it } from 'vitest';
import { emittedRenderableQuestionForm } from '@readable-studio/contracts';
import {
  splitOnQuestionForms, parsePartialQuestionForm, stripTrailingOpenQuestionForm,
} from '../../src/artifacts/question-form';

const body = JSON.stringify({ questions: [{ id: 'scope', label: 'Scope?', type: 'text' }] });
const form = `<question-form id="real" title="Brief">\n${body}\n</question-form>`;
const partial = '<question-form id="real">\n{"questions":[';
const cases: Array<[string, string, boolean]> = [
  ['prose mention', 'Here is a <question-form> for you.', false],
  ['prose then real form', `Here is a <question-form> for you.\n${form}`, true],
  ['backtick mention then real form', `Here is a \`<question-form>\` for you.\n${form}`, true],
  ['inline complete form', `Example: ${form}`, false],
  ['code span', `\`${form}\``, false],
  ['multiline code span', `\`example\n${form}\n\``, false],
  ['double-backtick span', `\`\`example \`\n${form}\n\`\``, false],
  ['backtick fence', `\`\`\`html\n${form}\n\`\`\``, false],
  ['tilde fence', `~~~html\n${form}\n~~~`, false],
  ['long fence with short inner fence', `\`\`\`\`html\n\`\`\`\n${form}\n\`\`\`\``, false],
  ['unclosed fence', `\`\`\`html\n${form}`, false],
  ['fenced sample then real form', `\`\`\`html\n${form}\n\`\`\`\n${form}`, true],
  ['valid form', form, true],
  ['optional attributes', `<question-form>${body}</question-form>`, true],
  ['alias and case', `<ASK-QUESTION>${body}</ASK-QUESTION>`, true],
  ['JSON body fence', `<question-form>\n\`\`\`json\n${body}\n\`\`\`\n</question-form>`, true],
  ['malformed JSON', '<question-form>\n{broken}\n</question-form>', false],
  ['empty questions', '<question-form>{"questions":[]}</question-form>', false],
  ['non-object questions', '<question-form>{"questions":[null,1]}</question-form>', false],
  ['truncated streaming form', partial, false],
  ['complete body without close', `<question-form>${body}`, true],
  ['mismatched close', `<question-form>${body}</ask-question>`, false],
  ['standalone mention then real form', `<question-form>\n${form}`, true],
  ['malformed candidate then real form', `<question-form>\n{broken}\n${form}`, true],
  ['Unicode prefix', `prefix İ\n${form}`, true],
  ['CRLF and indentation', `prefix\r\n  ${form.replaceAll('\n', '\r\n')}`, true],
  ['indented code', form.split('\n').map((line) => `    ${line}`).join('\n'), false],
  ['non-protocol tag', `<question-form-example>${body}</question-form>`, false],
];

describe('question-form Markdown boundaries and daemon agreement', () => {
  it.each(cases)('%s', (_name, input, expected) => {
    const forms = splitOnQuestionForms(input).filter((segment) => segment.kind === 'form');
    expect(forms.length > 0).toBe(expected);
    // This is the exact detector re-exported by apps/daemon, not a test mirror.
    expect(emittedRenderableQuestionForm(input)).toBe(forms.length > 0);
    if (!expected) {
      expect(splitOnQuestionForms(input)).toEqual([{ kind: 'text', text: input }]);
    }
  });

  it('preserves mention prose and extracts only the real block', () => {
    const prose = 'Here is a `<question-form>` for you.\n';
    expect(splitOnQuestionForms(prose + form)).toMatchObject([
      { kind: 'text', text: prose }, { kind: 'form', raw: form, form: { id: 'real' } },
    ]);
    expect(parsePartialQuestionForm(prose + partial)?.id).toBe('real');
    expect(stripTrailingOpenQuestionForm(prose + partial)).toEqual({ text: prose, hadOpenForm: true });
  });

  it.each([
    '`<question-form>`', `\`\`\`html\n${partial}`, `~~~\n${partial}\n~~~`,
    'Here is a <question-form> for you.',
  ])('keeps documentation inert during streaming: %s', (input) => {
    expect(parsePartialQuestionForm(input)).toBeNull();
    expect(stripTrailingOpenQuestionForm(input)).toEqual({ text: input, hadOpenForm: false });
  });

  it('suppresses only the trailing incomplete block after a complete form', () => {
    const prefix = `${form}\nNext:\n`;
    expect(stripTrailingOpenQuestionForm(prefix + partial)).toEqual({ text: prefix, hadOpenForm: true });
  });

  it('preserves all supported form and question fields', () => {
    const cards = [{ id: 'a', label: 'A', mood: 'Calm', references: ['Ref'], palette: ['#fff'], displayFont: 'Georgia', bodyFont: 'Arial' }];
    const questions = [
      { id: 'scope', label: 'Scope', type: 'checkbox', options: [{ label: 'A', value: 'a', description: 'Detail' }], placeholder: 'Choose', required: true, help: 'Help', defaultValue: ['a'], maxSelections: 1 },
      { id: 'direction', label: 'Direction', type: 'direction-cards', options: [{ label: 'A', value: 'a' }], cards },
    ];
    const data = { id: 'body-id', title: 'Body title', description: 'Description', submitLabel: 'Send', questions };
    const raw = `<question-form id="tag-id" title="Tag title">\n${JSON.stringify(data)}\n</question-form>`;
    expect(splitOnQuestionForms(raw)).toEqual([{ kind: 'form', raw, form: { ...data, id: 'tag-id', title: 'Tag title' } }]);
    expect(emittedRenderableQuestionForm(raw)).toBe(true);
  });
});
