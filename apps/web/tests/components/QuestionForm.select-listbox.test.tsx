// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionFormView } from '../../src/components/QuestionForm';
import type { QuestionForm } from '../../src/artifacts/question-form';

// One question per renderer branch, so the "no native select" guard covers
// every field type the question form supports, not only the one reported.
const everyTypeForm: QuestionForm = {
  id: 'coverage',
  title: 'Every field type',
  questions: [
    { id: 'kind', label: 'Task type', type: 'radio', options: [{ label: 'Build', value: 'build' }] },
    { id: 'tone', label: 'Tone', type: 'checkbox', options: [{ label: 'Calm', value: 'calm' }] },
    {
      id: 'platform',
      label: 'Target platform',
      type: 'select',
      required: true,
      options: [
        { label: 'iOS', value: 'ios' },
        { label: 'Android', value: 'android' },
        { label: 'Web (desktop browsers, responsive down to tablet)', value: 'web' },
      ],
    },
    { id: 'audience', label: 'Audience', type: 'text' },
    { id: 'notes', label: 'Notes', type: 'textarea' },
    {
      id: 'direction',
      label: 'Direction',
      type: 'direction-cards',
      cards: [
        {
          id: 'editorial',
          label: 'Editorial',
          mood: 'Quiet',
          references: [],
          palette: [],
          displayFont: 'serif',
          bodyFont: 'sans-serif',
        },
      ],
    },
  ],
};

const selectForm: QuestionForm = {
  id: 'discovery',
  title: 'Quick brief',
  questions: [
    {
      id: 'platform',
      label: 'Target platform',
      type: 'select',
      required: true,
      placeholder: 'Pick a platform',
      options: [
        { label: 'iOS', value: 'ios' },
        { label: 'Android', value: 'android' },
        { label: 'Web', value: 'web' },
      ],
    },
  ],
};

describe('QuestionFormView select field', () => {
  afterEach(() => cleanup());

  it('renders no native select in any question-form field type', () => {
    const { container } = render(
      <QuestionFormView form={everyTypeForm} interactive onSubmit={vi.fn()} />,
    );

    expect(container.querySelectorAll('.qf-field')).toHaveLength(6);
    expect(container.querySelector('select')).toBeNull();
    expect(document.querySelector('select')).toBeNull();
    expect(container.querySelector('option')).toBeNull();
  });

  it('exposes select-only combobox + listbox semantics on the product dropdown', () => {
    render(<QuestionFormView form={selectForm} interactive onSubmit={vi.fn()} />);

    const trigger = screen.getByRole('combobox', { name: 'Target platform' });
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.textContent).toContain('Pick a platform');
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const listbox = screen.getByRole('listbox', { name: 'Target platform' });
    expect(trigger.getAttribute('aria-controls')).toBe(listbox.id);
    // The list is portalled to <body> so it can escape clipping containers,
    // exactly like the composer's model picker.
    expect(listbox.closest('.question-form')).toBeNull();
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['iOS', 'Android', 'Web']);
    expect(options.every((option) => option.getAttribute('aria-selected') === 'false')).toBe(true);
    // Active option: the first option holds focus when nothing is selected.
    expect(document.activeElement).toBe(options[0]);
  });

  it('supports open, arrow, type-ahead, Enter and Escape from the keyboard', () => {
    render(<QuestionFormView form={selectForm} interactive onSubmit={vi.fn()} />);
    const trigger = screen.getByRole('combobox', { name: 'Target platform' });

    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const [ios, android, web] = screen.getAllByRole('option');
    expect(document.activeElement).toBe(ios);

    fireEvent.keyDown(ios!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(android);
    fireEvent.keyDown(android!, { key: 'End' });
    expect(document.activeElement).toBe(web);
    fireEvent.keyDown(web!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(ios);
    fireEvent.keyDown(ios!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(web);
    fireEvent.keyDown(web!, { key: 'Home' });
    expect(document.activeElement).toBe(ios);

    // Type-ahead: a printable key jumps to the next option starting with it.
    fireEvent.keyDown(ios!, { key: 'a' });
    expect(document.activeElement).toBe(android);

    fireEvent.keyDown(android!, { key: 'Enter' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger.textContent).toContain('Android');
    expect(trigger.getAttribute('data-value')).toBe('android');
    expect(document.activeElement).toBe(trigger);

    // Re-open lands on the selected option and reports it as selected.
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const reopened = screen.getAllByRole('option');
    expect(document.activeElement).toBe(reopened[1]);
    expect(reopened[1]!.getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('option', { selected: true })).toHaveLength(1);

    fireEvent.keyDown(reopened[1]!, { key: 'Escape' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    // Escape dismisses without changing the answer.
    expect(trigger.getAttribute('data-value')).toBe('android');
  });

  it('feeds the picked option into the answer state that submission reads', () => {
    const onSubmit = vi.fn();
    const onAnswerChange = vi.fn();
    const onDraftChange = vi.fn();
    render(
      <QuestionFormView
        form={selectForm}
        interactive
        onSubmit={onSubmit}
        onAnswerChange={onAnswerChange}
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(screen.getByRole('combobox', { name: 'Target platform' }));
    fireEvent.click(screen.getByRole('option', { name: 'Web' }));

    expect(onAnswerChange).toHaveBeenCalledWith('platform', 'web');
    expect(onDraftChange).toHaveBeenLastCalledWith({ platform: 'web' });
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    expect(onSubmit).toHaveBeenCalledWith(
      '[form answers — discovery]\n- Target platform: Web [value: web]',
      { platform: 'web' },
    );
  });

  it('keeps required gating: an unanswered select blocks submit and reports not-ready', () => {
    const onSubmit = vi.fn();
    const onReadyChange = vi.fn();
    const { container } = render(
      <QuestionFormView
        form={selectForm}
        interactive
        onSubmit={onSubmit}
        onReadyChange={onReadyChange}
      />,
    );

    const submit = screen.getByRole('button', { name: 'Send answers' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(onReadyChange).toHaveBeenLastCalledWith(false);
    expect(container.querySelector('.qf-required')?.textContent).toBe('*');
    expect(container.querySelector('.question-form')?.getAttribute('data-reachability-required')).toBe(
      'true',
    );

    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('combobox', { name: 'Target platform' }));
    fireEvent.click(screen.getByRole('option', { name: 'iOS' }));

    expect(submit.disabled).toBe(false);
    expect(onReadyChange).toHaveBeenLastCalledWith(true);
  });

  it('locks the dropdown and shows the submitted label once answers are in', () => {
    render(
      <QuestionFormView
        form={selectForm}
        interactive={false}
        submittedAnswers={{ platform: 'Android' }}
        onSubmit={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('combobox', { name: 'Target platform' }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.textContent).toContain('Android');
    expect(trigger.getAttribute('data-value')).toBe('android');
  });

  it('closes on outside pointer press and survives anchor re-placement on scroll', () => {
    render(<QuestionFormView form={selectForm} interactive onSubmit={vi.fn()} />);
    const trigger = screen.getByRole('combobox', { name: 'Target platform' });
    fireEvent.click(trigger);
    expect(screen.getByRole('listbox')).toBeTruthy();

    // Ancestor scroll re-runs placePopover against the anchor; the list stays.
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(screen.getByRole('listbox')).toBeTruthy();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});
