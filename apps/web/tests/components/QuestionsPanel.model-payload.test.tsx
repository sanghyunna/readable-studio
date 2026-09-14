// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionsPanel } from '../../src/components/QuestionsPanel';
import { findFirstQuestionForm, type FormQuestion } from '../../src/artifacts/question-form';
import { briefAssumptionsFromAnswers, mergeBriefAssumptions, persistProjectBrief } from '../../src/components/brief-state';
import { parseSubmittedAnswers } from '../../src/components/QuestionForm';

const questions: FormQuestion[] = [
  { id: 'reportPeriod', label: 'Reporting period', type: 'text' },
  { id: 'sources', label: 'Source material', type: 'textarea' },
  { id: 'analysisMode', label: 'Analysis mode', type: 'select', options: [{ label: 'Comparison', value: 'compare' }] },
];
function payload(items: FormQuestion[]) {
  return findFirstQuestionForm(`<question-form id="report">${JSON.stringify({ questions: items })}</question-form>`)?.form ?? null;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.sessionStorage.clear(); });

describe('model-authored question contract', () => {
  it.each([1, 3])('renders exactly the %i emitted question ids and types', count => {
    const emitted = questions.slice(0, count);
    const view = render(<QuestionsPanel form={payload(emitted)} interactive generating={false} onSubmit={vi.fn()} />);
    expect([...view.container.querySelectorAll('[data-question-id]')].map(node => [node.getAttribute('data-question-id'), node.getAttribute('data-question-type')]))
      .toEqual(emitted.map(question => [question.id, question.type]));
    expect(view.container.querySelectorAll('.questions-panel__row')).toHaveLength(0);
  });

  it.each([null, payload([]), { id: 'none', title: 'None', questions: [] }])('shows an empty state without controls when there are no questions', form => {
    const view = render(<QuestionsPanel brief={{ assumptions: [], updatedAt: 1 }} form={form} interactive generating={false} onSubmit={vi.fn()} />);
    expect(screen.getByTestId('questions-empty')).toBeTruthy();
    expect(view.container.querySelectorAll('[data-question-id], input, textarea, .questions-continue, .questions-skip')).toHaveLength(0);
  });

  it('persists an arbitrary answered id and its model schema into prompt-facing metadata', async () => {
    const form = payload(questions.slice(0, 1))!;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ project: { id: 'report-project' } }), { status: 200 }));
    const onSubmit = vi.fn(async (text: string, answers: Record<string, string | string[]>) => {
      expect(parseSubmittedAnswers(form, text)).toEqual(answers);
      return persistProjectBrief('report-project', { kind: 'other' }, mergeBriefAssumptions(null, briefAssumptionsFromAnswers(form, answers), 1));
    });
    const view = render(<QuestionsPanel form={form} interactive generating={false} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'REPORT_PERIOD_729' } });
    await act(async () => { fireEvent.click(view.container.querySelector('.questions-continue')!); });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const metadata = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).metadata;
    expect(metadata.brief.assumptions).toEqual([{ id: 'reportPeriod', label: questions[0]!.label, value: 'REPORT_PERIOD_729', provenance: 'stated', question: form.questions[0] }]);
  });
});
