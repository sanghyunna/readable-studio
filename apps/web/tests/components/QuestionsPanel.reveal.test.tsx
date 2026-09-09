// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionsPanel } from '../../src/components/QuestionsPanel';
import type { QuestionForm } from '../../src/artifacts/question-form';

const form: QuestionForm = {
  id: 'blocking-input', title: 'Required source',
  questions: [
    { id: 'q1', label: 'Source URL', type: 'text', required: true },
    { id: 'q2', label: 'Notes', type: 'textarea' },
  ],
};

const scopeForm: QuestionForm = {
  id: 'scope',
  title: 'Confirm the scope',
  questions: [
    {
      id: 'platform', label: 'Target platform', type: 'radio', required: true,
      options: [{ label: 'Desktop web', value: 'desktop-web' }],
    },
    {
      id: 'fidelity', label: 'Revision fidelity', type: 'radio', required: true,
      options: [{ label: 'High fidelity', value: 'high' }],
    },
  ],
};

afterEach(() => { cleanup(); window.sessionStorage.clear(); });

describe('QuestionsPanel blocking forms', () => {
  it('shows every available question immediately without a theatrical reveal', () => {
    render(<QuestionsPanel form={form} interactive generating={false} onSubmit={() => {}} />);
    expect(document.querySelectorAll('.qf-field')).toHaveLength(2);
  });

  it('offers a recovery path that bypasses required fields without a countdown', () => {
    const onSubmit = vi.fn();
    render(<QuestionsPanel form={form} interactive generating={false} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: /skip all/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      '[form answers — blocking-input]\n- Source URL: (skipped)\n- Notes: (skipped)', {},
    );
    expect(document.querySelector('.questions-skip-timer')).toBeNull();
  });

  it('enables Continue after every required choice is answered, including during an in-flight run', () => {
    const onSubmit = vi.fn();
    render(
      <QuestionsPanel
        form={scopeForm}
        interactive
        generating={false}
        submissionQueued
        onSubmit={onSubmit}
      />,
    );

    const continueButton = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Desktop web' }));
    fireEvent.click(screen.getByRole('radio', { name: 'High fidelity' }));

    expect(continueButton.disabled).toBe(false);
    expect(screen.getByText('Answers will be queued and applied when the current run finishes.')).toBeTruthy();
    fireEvent.click(continueButton);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('preserves drafts across remount and clears them on submit', () => {
    const onSubmit = vi.fn();
    const props = { form, formKey: 'conv:blocker', interactive: true, generating: false, onSubmit } as const;
    const first = render(<QuestionsPanel {...props} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Source URL' }), { target: { value: 'https://brand.example' } });
    first.unmount();

    const second = render(<QuestionsPanel {...props} />);
    expect((screen.getByRole('textbox', { name: 'Source URL' }) as HTMLInputElement).value).toBe('https://brand.example');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onSubmit).toHaveBeenCalledWith('[form answers — blocking-input]\n- Source URL: https://brand.example\n- Notes: (skipped)', { q1: 'https://brand.example', q2: '' });
    second.unmount();

    render(<QuestionsPanel {...props} />);
    expect((screen.getByRole('textbox', { name: 'Source URL' }) as HTMLInputElement).value).toBe('');
  });

  it('keeps historical submitted forms fully rendered and locked', () => {
    render(<QuestionsPanel form={form} interactive={false} generating={false} submittedAnswers={{ q1: 'https://brand.example' }} onSubmit={() => {}} />);
    expect(document.querySelectorAll('.qf-field')).toHaveLength(2);
    expect(screen.getByText('answered')).toBeTruthy();
  });
});
