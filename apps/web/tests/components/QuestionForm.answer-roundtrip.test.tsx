// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatFormAnswers, type QuestionForm } from '../../src/artifacts/question-form';
import { parseSubmittedAnswers, QuestionFormView } from '../../src/components/QuestionForm';

const form: QuestionForm = {
  id: 'scope', title: 'Scope', questions: [
    { id: 'platform', label: 'Target platform', type: 'radio', options: [{ label: 'Desktop web', value: 'desktop-web' }] },
    { id: 'features', label: 'Features', type: 'checkbox', options: [
      { label: 'Search, filter', value: 'search-filter' },
      { label: 'Export', value: 'export' },
      { label: 'Read, write', value: 'Read, write' },
    ] },
    { id: 'notes', label: 'Notes', type: 'textarea' },
  ],
};

afterEach(cleanup);

describe('question answer restoration', () => {
  it('restores every selected option without splitting commas inside option labels', () => {
    const answers = { platform: 'desktop-web', features: ['search-filter', 'export', 'Read, write'], notes: '' };
    const prompt = formatFormAnswers(form, answers);
    const restored = parseSubmittedAnswers(form, prompt);
    expect(restored).toEqual(answers);
    render(<QuestionFormView form={form} interactive={false} submittedQueued submittedAnswers={restored!} onSubmit={vi.fn()} />);
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(3);
    expect(screen.getByRole('radio', { checked: true })).toHaveProperty('disabled', true);
  });

  it('restores multiline text including blank lines, indentation, and list items', () => {
    const answers = { platform: 'desktop-web', features: ['export'], notes: 'First line\n\n  Indented detail\n- Keep this: detail\nLast line' };
    expect(parseSubmittedAnswers(form, formatFormAnswers(form, answers))).toEqual(answers);
  });

  it('continues to accept historical plain labels and skipped answers', () => {
    expect(parseSubmittedAnswers(form, '[form answers - scope]\n- Target platform: Desktop web\n- Features: Search, filter, Export\n- Notes: (skipped)'))
      .toEqual({ platform: 'desktop-web', features: ['search-filter', 'export'], notes: '' });
  });
});
