// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionFormView, parseSubmittedAnswers } from '../../src/components/QuestionForm';
import type { QuestionForm } from '../../src/artifacts/question-form';

const form: QuestionForm = {
  id: 'discovery',
  title: 'Quick brief',
  questions: [
    {
      id: 'tone',
      label: 'Visual tone (pick up to two)',
      type: 'checkbox',
      options: [
        { label: 'Editorial / magazine', value: 'Editorial / magazine' },
        { label: 'Modern minimal', value: 'Modern minimal' },
        { label: 'Soft gradients', value: 'Soft gradients' },
      ],
      maxSelections: 2,
      required: true,
    },
  ],
};

const voiceForm: QuestionForm = {
  id: 'elevenlabs-voice',
  title: 'Choose an ElevenLabs voice',
  description:
    'Pick a voice by description. The selected answer will be the exact voice_id passed to the renderer.',
  questions: [
    {
      id: 'voice',
      label: 'Voice',
      type: 'select',
      required: true,
      placeholder: 'Choose a voice',
      help: 'Select a voice description; the answer submits the matching Voice ID.',
      options: [
        { label: 'Rachel — american · female', value: '21m00Tcm4TlvDq8ikWAM' },
        { label: 'Adam — american · male', value: 'pNInz6obpgDQGcFmaJgB' },
      ],
    },
  ],
  submitLabel: 'Use voice',
};

const richForm = {
  id: 'discovery',
  title: 'Quick brief',
  questions: [
    {
      id: 'platform',
      label: 'Primary surface',
      type: 'radio',
      required: true,
      options: [
        { label: 'Responsive', value: 'Responsive' },
        {
          label: 'Mobile (iOS/Android)',
          description: 'Phone-first app prototype',
          value: 'mobile',
        },
        {
          label: 'Desktop web',
          description: 'Browser-first prototype',
          value: 'Desktop web',
        },
      ],
    },
  ],
} as QuestionForm;

const checkboxObjectForm = {
  id: 'discovery',
  title: 'Quick brief',
  questions: [
    {
      id: 'tone',
      label: 'Visual tone',
      type: 'checkbox',
      required: true,
      options: [
        { label: 'Editorial / magazine', value: 'editorial' },
        { label: 'Soft gradients', value: 'soft-gradients' },
        { label: 'Modern minimal', value: 'modern-minimal' },
      ],
    },
  ],
} as QuestionForm;

const selectObjectForm = {
  id: 'discovery',
  title: 'Quick brief',
  questions: [
    {
      id: 'platform',
      label: 'Primary surface',
      type: 'select',
      required: true,
      options: [
        { label: 'Mobile (iOS/Android)', value: 'mobile' },
        { label: 'Desktop web', value: 'desktop-web' },
      ],
    },
  ],
} as QuestionForm;

describe('QuestionFormView', () => {
  afterEach(() => cleanup());

  it('updates locked answers when submitted history arrives after the initial render', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <QuestionFormView form={form} interactive submittedAnswers={undefined} onSubmit={onSubmit} />,
    );

    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(3);

    rerender(
      <QuestionFormView
        form={form}
        interactive={false}
        submittedAnswers={{ tone: ['Editorial / magazine', 'Modern minimal'] }}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByText('answered')).toBeTruthy();
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(2);
  });

  it('explains that submitted answers are in effect when the panel owns the submit controls', () => {
    render(
      <QuestionFormView
        form={form}
        interactive={false}
        submittedAnswers={{ tone: ['Editorial / magazine', 'Modern minimal'] }}
        hideInternalSubmit
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText('Answers sent — agent is using these for the rest of the session.')).toBeTruthy();
  });

  it('renders select options with labels and submits the selected voice id', () => {
    const onSubmit = vi.fn();
    const { container, rerender } = render(
      <QuestionFormView form={voiceForm} interactive submittedAnswers={undefined} onSubmit={onSubmit} />,
    );

    const trigger = screen.getByRole('combobox', { name: 'Voice' });
    expect(container.querySelector('select')).toBeNull();
    expect(trigger.textContent).toContain('Choose a voice');

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: 'Rachel — american · female' }));
    expect(trigger.textContent).toContain('Rachel — american · female');
    fireEvent.click(screen.getByRole('button', { name: 'Use voice' }));

    expect(onSubmit).toHaveBeenCalledWith(
      '[form answers — elevenlabs-voice]\n- Voice: Rachel — american · female [value: 21m00Tcm4TlvDq8ikWAM]',
      { voice: '21m00Tcm4TlvDq8ikWAM' },
    );

    rerender(
      <QuestionFormView
        form={voiceForm}
        interactive={false}
        submittedAnswers={{ voice: 'Rachel — american · female' }}
        onSubmit={onSubmit}
      />,
    );

    const locked = screen.getByRole('combobox', { name: 'Voice' }) as HTMLButtonElement;
    expect(locked.getAttribute('data-value')).toBe('21m00Tcm4TlvDq8ikWAM');
    expect(locked.textContent).toContain('Rachel — american · female');
    expect(locked.disabled).toBe(true);
  });

  it('parses submitted object-option values from readable answer text', () => {
    expect(
      parseSubmittedAnswers(
        richForm,
        [
          '[form answers - discovery]',
          '- Primary surface: Mobile (iOS/Android) [value: mobile]',
        ].join('\n'),
      ),
    ).toEqual({ platform: 'mobile' });
  });

  it('renders visible, pointer-operable radio pills and submits the stable value', () => {
    const onSubmit = vi.fn();
    const { container } = render(<QuestionFormView form={richForm} interactive onSubmit={onSubmit} />);

    const group = screen.getByRole('radiogroup', { name: 'Primary surface' });
    const responsive = screen.getByRole('radio', { name: 'Responsive' });
    expect(responsive.tagName).toBe('BUTTON');
    expect((responsive as HTMLButtonElement).disabled).toBe(false);
    expect(container.querySelector('input[type="radio"]')).toBeNull();
    expect(screen.getByText('Phone-first app prototype')).toBeTruthy();
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(3);

    fireEvent.click(screen.getByRole('radio', { name: 'Mobile (iOS/Android)' }));

    expect(screen.getAllByRole('radio', { checked: true })).toHaveLength(1);
    expect(screen.getByRole('radio', { name: 'Mobile (iOS/Android)' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toContain(
      '- Primary surface: Mobile (iOS/Android) [value: mobile]',
    );
    expect(onSubmit.mock.calls[0]?.[1]).toEqual({ platform: 'mobile' });
  });

  it('uses arrow, Home, and End keys for roving radio focus and selection', () => {
    render(<QuestionFormView form={richForm} interactive onSubmit={vi.fn()} />);

    const responsive = screen.getByRole('radio', { name: 'Responsive' });
    const mobile = screen.getByRole('radio', { name: 'Mobile (iOS/Android)' });
    const desktop = screen.getByRole('radio', { name: 'Desktop web' });
    expect(responsive.tabIndex).toBe(0);
    expect(mobile.tabIndex).toBe(-1);

    responsive.focus();
    fireEvent.keyDown(responsive, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(mobile);
    expect(mobile.getAttribute('aria-checked')).toBe('true');
    expect(mobile.tabIndex).toBe(0);
    expect(responsive.tabIndex).toBe(-1);

    fireEvent.keyDown(mobile, { key: 'End' });
    expect(document.activeElement).toBe(desktop);
    expect(desktop.getAttribute('aria-checked')).toBe('true');

    fireEvent.keyDown(desktop, { key: 'Home' });
    expect(document.activeElement).toBe(responsive);
    expect(responsive.getAttribute('aria-checked')).toBe('true');
    expect(screen.getAllByRole('radio', { checked: true })).toHaveLength(1);
  });

  it('submits required checkbox object options with stable values', () => {
    const onSubmit = vi.fn();
    render(<QuestionFormView form={checkboxObjectForm} interactive onSubmit={onSubmit} />);

    const submit = screen.getByRole('button', { name: 'Send answers' });
    // Required field unanswered → submit stays disabled (regression guard:
    // the Questions-tab refactor must not make required fields optional on the
    // standard submit path).
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('Editorial / magazine'));
    fireEvent.click(screen.getByLabelText('Soft gradients'));

    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(2);
    expect((submit as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(submit);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toContain('Editorial / magazine [value: editorial]');
    expect(onSubmit.mock.calls[0]?.[0]).toContain('Soft gradients [value: soft-gradients]');
    expect(onSubmit.mock.calls[0]?.[1]).toEqual({
      tone: ['editorial', 'soft-gradients'],
    });
  });

  it('disables unselected toggles at maxSelections while preserving selected toggle removal', () => {
    // Given
    const onSubmit = vi.fn();
    render(<QuestionFormView form={form} interactive onSubmit={onSubmit} />);
    const editorial = screen.getByRole('button', { name: 'Editorial / magazine' });
    const modern = screen.getByRole('button', { name: 'Modern minimal' });
    const gradients = screen.getByRole('button', { name: 'Soft gradients' });

    // When
    fireEvent.click(editorial);
    fireEvent.click(modern);

    // Then
    expect(editorial.getAttribute('aria-pressed')).toBe('true');
    expect(modern.getAttribute('aria-pressed')).toBe('true');
    expect((gradients as HTMLButtonElement).disabled).toBe(true);

    // When
    fireEvent.click(editorial);

    // Then
    expect(editorial.getAttribute('aria-pressed')).toBe('false');
    expect((gradients as HTMLButtonElement).disabled).toBe(false);
  });

  it('marks required fields with the inline indicator even when the footer is hidden', () => {
    // Panel path (Questions tab): hideInternalSubmit hides the form footer, so
    // the inline "*" next to a required label is the only per-field cue that a
    // field is mandatory. A mixed required/optional form must still advertise
    // which fields block the disabled Continue button.
    const mixedForm = {
      id: 'discovery',
      title: 'Quick brief',
      questions: [
        { id: 'taskType', label: 'Task type', type: 'text', required: true },
        { id: 'notes', label: 'Notes', type: 'text' },
      ],
    } as QuestionForm;

    const onSubmit = vi.fn();
    const { container } = render(
      <QuestionFormView form={mixedForm} interactive hideInternalSubmit onSubmit={onSubmit} />,
    );

    const fields = container.querySelectorAll('.qf-field');
    const requiredField = fields[0]!;
    const optionalField = fields[1]!;
    expect(requiredField.querySelector('.qf-required')?.textContent).toBe('*');
    expect(optionalField.querySelector('.qf-required')).toBeNull();
  });

  it('submits required select object options with stable values', () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <QuestionFormView form={selectObjectForm} interactive onSubmit={onSubmit} />,
    );

    const submit = screen.getByRole('button', { name: 'Send answers' });
    // Required select unanswered → submit stays disabled (regression guard).
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    expect(container.querySelector('select')).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: 'Primary surface' }));
    fireEvent.click(screen.getByRole('option', { name: 'Mobile (iOS/Android)' }));

    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toContain(
      '- Primary surface: Mobile (iOS/Android) [value: mobile]',
    );
    expect(onSubmit.mock.calls[0]?.[1]).toEqual({ platform: 'mobile' });
  });
});
