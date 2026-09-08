// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionsPanel } from '../../src/components/QuestionsPanel';
import { QuestionFormView, type QuestionFormHandle } from '../../src/components/QuestionForm';
import { I18nProvider } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';
import { ko } from '../../src/i18n/locales/ko';
import type { QuestionForm } from '../../src/artifacts/question-form';

const form: QuestionForm = { id: 'hydration', title: 'Scope', questions: [
  { id: 'notes', label: 'Notes', type: 'text', required: true },
] };
afterEach(() => { cleanup(); window.sessionStorage.clear(); });

describe('Questions hydration boundary', () => {
  it.each(['en', 'ko'] as const)('localizes pending, failed and recovered states in %s without locking drafts', locale => {
    const dict = locale === 'ko' ? ko : en;
    const onSubmit = vi.fn();
    const onRetryRunHydration = vi.fn();
    const panel = (runHydrationStatus: 'pending' | 'failed' | 'ready') => <I18nProvider initial={locale}>
      <QuestionsPanel form={form} interactive generating={false} runHydrationStatus={runHydrationStatus}
        onSubmit={onSubmit} onRetryRunHydration={onRetryRunHydration} />
    </I18nProvider>;
    const view = render(panel('pending'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'Keep this answer' } });
    expect(screen.getByRole('status').textContent).toBe(dict['questions.hydratingRuns']);
    expect(screen.getByRole('button', { name: dict['questions.continue'] })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: dict['questions.skipAll'] }));
    expect(onSubmit).not.toHaveBeenCalled();
    view.rerender(panel('failed'));
    expect(screen.getByRole('status').textContent).toBe(dict['questions.runHydrationFailed']);
    fireEvent.click(screen.getByRole('button', { name: dict['questions.retryRunHydration'] }));
    expect(onRetryRunHydration).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: dict['questions.continue'] })).toHaveProperty('disabled', true);
    view.rerender(panel('pending'));
    expect(screen.queryByRole('button', { name: dict['questions.retryRunHydration'] })).toBeNull();
    view.rerender(panel('ready'));
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveProperty('value', 'Keep this answer');
    expect(screen.getByRole('button', { name: dict['questions.continue'] })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: dict['questions.continue'] }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('gates imperative submit and skip without reporting an editable form as answered', () => {
    const ref = createRef<QuestionFormHandle>();
    const onSubmit = vi.fn();
    const view = render(<QuestionFormView ref={ref} form={form} interactive submitDisabled onSubmit={onSubmit} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'Retained' } });
    act(() => { ref.current!.submit(); ref.current!.skipAll(); });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.querySelector('.question-form-locked')).toBeNull();
    view.rerender(<QuestionFormView ref={ref} form={form} interactive onSubmit={onSubmit} />);
    act(() => { ref.current!.submit(); });
    expect(onSubmit).toHaveBeenCalledWith(expect.any(String), { notes: 'Retained' });
  });
});
