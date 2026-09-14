import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ToggleButton } from '@readable-studio/components';
import { useT } from '../i18n';
import { DirectListbox } from './DirectListbox';
import type { DirectionCard, FormOption, QuestionForm } from '../artifacts/question-form';
import { formatFormAnswers, formOptionValueForLabel } from '../artifacts/question-form';

interface Props {
  form: QuestionForm;
  // Whether the user can still submit answers. The owning AssistantMessage
  // disables the form when the assistant turn is no longer the most recent
  // one (i.e. the user has already moved past it).
  interactive: boolean;
  // Hold submission without locking draft inputs or marking the form answered.
  submitDisabled?: boolean;
  // Pre-existing answers — when we detect a follow-up user message that
  // begins with "[form answers — <id>]", we parse it back out and pass it
  // here so the rendered form reflects what was sent.
  submittedAnswers?: Record<string, string | string[]>;
  // The accepted answers are waiting behind an active run rather than already
  // being consumed by the agent.
  submittedQueued?: boolean;
  // When the form lives in the Questions tab the Continue button owns the
  // submit, so hide the form's own footer button and report ready-state out.
  hideInternalSubmit?: boolean;
  // When the host surface already titles the form in its own visual language
  // (the Brief drill-in owns its header, back affordance and copy), suppress
  // this component's chat-era head so two title blocks in two design languages
  // never render together. Default keeps the standard chat rendering.
  hideInternalHead?: boolean;
  listboxPopoverClassName?: string;
  draftAnswers?: Record<string, string | string[]>;
  onReadyChange?: (ready: boolean) => void;
  onDraftChange?: (answers: Record<string, string | string[]>) => void;
  // Fires on each real user interaction with a single question (locked forms
  // never reach it). Lets the Questions tab host track chip picks.
  onAnswerChange?: (questionId: string, value: string | string[]) => void;
  onSubmit?: (text: string, answers: Record<string, string | string[]>) => void;
}

// Lets a parent (the Questions tab Continue button) trigger submission.
export interface QuestionFormHandle {
  submit: () => void;
  // Submit with no answers — backs the "skip all" affordance. Every question
  // is optional, so this just records each as "(skipped)" and moves on.
  skipAll: () => void;
}

export const QuestionFormView = forwardRef<QuestionFormHandle, Props>(function QuestionFormView(
  {
    form,
    interactive,
    submitDisabled = false,
    submittedAnswers,
    submittedQueued = false,
    hideInternalSubmit = false,
    hideInternalHead = false,
    listboxPopoverClassName,
    draftAnswers,
    onReadyChange,
    onDraftChange,
    onAnswerChange,
    onSubmit,
  },
  ref,
) {
  const t = useT();
  const initial = useMemo(
    () => buildInitialState(form, submittedAnswers ?? draftAnswers),
    [form, submittedAnswers, draftAnswers],
  );
  const [answers, setAnswers] = useState<Record<string, string | string[]>>(initial);
  const locked = !interactive || !onSubmit || submittedAnswers !== undefined;
  const currentAnswers = submittedAnswers ?? answers;

  // When the form streams in question-by-question, backfill state for newly
  // revealed questions without disturbing answers the user already touched.
  useEffect(() => {
    setAnswers((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const q of form.questions) {
        if (next[q.id] !== undefined) continue;
        changed = true;
        if (submittedAnswers && submittedAnswers[q.id] !== undefined) {
          next[q.id] = canonicalizeQuestionValue(q, submittedAnswers[q.id]!);
        } else if (q.defaultValue !== undefined) {
          next[q.id] = canonicalizeQuestionValue(q, q.defaultValue);
        } else {
          next[q.id] = q.type === 'checkbox' ? [] : '';
        }
      }
      return changed ? next : prev;
    });
  }, [form, submittedAnswers]);

  function update(id: string, value: string | string[]) {
    if (locked) return;
    const next = { ...answers, [id]: value };
    setAnswers(next);
    onDraftChange?.(next);
    onAnswerChange?.(id, value);
  }

  function toggleOption(id: string, option: string, maxSelections?: number) {
    if (locked) return;
    const current = Array.isArray(answers[id]) ? answers[id] : [];
    const selected = current.includes(option);
    if (!selected && maxSelections !== undefined && current.length >= maxSelections) return;
    update(id, selected ? current.filter((value) => value !== option) : [...current, option]);
  }

  function handleSubmit() {
    if (locked || submitDisabled || !onSubmit) return;
    // Block submit until required fields are answered and selection caps hold.
    // skipAll() is the only path that intentionally bypasses this (the new
    // Questions-tab Skip button / countdown).
    if (!ready) return;
    onSubmit(formatFormAnswers(form, answers), answers);
  }

  function handleSkipAll() {
    if (locked || submitDisabled || !onSubmit) return;
    const empty: Record<string, string | string[]> = {};
    onSubmit(formatFormAnswers(form, empty), empty);
  }

  // Per-question checkbox selection caps must hold.
  const withinSelectionLimits = form.questions.every((q) => {
    if (q.type !== 'checkbox' || q.maxSelections === undefined) return true;
    const v = currentAnswers[q.id];
    return !Array.isArray(v) || v.length <= q.maxSelections;
  });
  // Required questions must carry a non-empty answer. This gates the standard
  // submit button AND the Questions-tab Continue CTA — only skipAll() bypasses
  // it on purpose. Without this, main-path forms (the discovery router's
  // required taskType/output, the ElevenLabs voice picker) would accept an
  // empty submit and serialize "(skipped)" for fields the rest of the system
  // treats as mandatory.
  const requiredAnswered = form.questions.every((q) => {
    if (q.required !== true) return true;
    const v = currentAnswers[q.id];
    if (Array.isArray(v)) return v.length > 0;
    return typeof v === 'string' && v.trim().length > 0;
  });
  const ready = withinSelectionLimits && requiredAnswered;

  useImperativeHandle(ref, () => ({ submit: handleSubmit, skipAll: handleSkipAll }));
  useEffect(() => {
    onReadyChange?.(!locked && ready);
  }, [onReadyChange, locked, ready]);

  return (
    <div
      className={`question-form${locked ? ' question-form-locked' : ''}`}
      data-form-id={form.id}
      data-reachability-required={
        submittedAnswers === undefined && form.questions.some((question) => question.required)
          ? 'true'
          : undefined
      }
    >
      {hideInternalHead ? null : (
        <div className="question-form-head">
          <span className="question-form-icon" aria-hidden>?</span>
          <div className="question-form-titles">
            <div className="question-form-title">{form.title}</div>
            {form.description ? (
              <div className="question-form-desc">{form.description}</div>
            ) : null}
          </div>
          {locked ? <span className="question-form-pill">{t('qf.answered')}</span> : null}
        </div>
      )}
      <div className="question-form-body">
        {form.questions.map((q) => {
          const value = currentAnswers[q.id];
          return (
            <div key={q.id} className="qf-field" data-question-id={q.id} data-question-type={q.type}>
              <label className="qf-label">
                <span>{q.label}</span>
                {q.required ? (
                  <span className="qf-required" aria-label={t('qf.required')}>*</span>
                ) : null}
              </label>
              {q.help ? <div className="qf-help">{q.help}</div> : null}
              {q.type === 'radio' && q.options ? (
                <RadioPillGroup
                  label={q.label}
                  options={q.options}
                  value={typeof value === 'string' ? value : ''}
                  disabled={locked}
                  onSelect={(nextValue) => update(q.id, nextValue)}
                />
              ) : null}
              {q.type === 'checkbox' && q.options ? (
                <div className="qf-options">
                  {q.options.map((opt) => {
                    const arr = Array.isArray(value) ? value : [];
                    const on = arr.includes(opt.value);
                    const maxed =
                      q.maxSelections !== undefined && !on && arr.length >= q.maxSelections;
                    return (
                      <ToggleButton
                        key={opt.value}
                        title={opt.description}
                        className={`qf-chip${on ? ' qf-chip-on' : ''}${maxed ? ' qf-chip-disabled' : ''}`}
                        pressed={on}
                        disabled={locked || maxed}
                        aria-label={opt.label}
                        onPressedChange={() => toggleOption(q.id, opt.value, q.maxSelections)}
                      >
                        <OptionCopy option={opt} />
                      </ToggleButton>
                    );
                  })}
                </div>
              ) : null}
              {q.type === 'select' && q.options ? (
                // The product's direct listbox (shared with the composer's
                // model picker), never a native <select>: the OS-drawn control
                // ignored every product token and broke the form's look.
                <DirectListbox
                  className="qf-select"
                  popoverClassName={listboxPopoverClassName}
                  label={q.label}
                  options={q.options}
                  // Submitted history may carry the option label rather than
                  // its stable value; resolve it so the locked field shows
                  // the pick instead of the placeholder.
                  value={typeof value === 'string' ? formOptionValueForLabel(q, value) : ''}
                  placeholder={q.placeholder ?? t('qf.choose')}
                  disabled={locked}
                  onChange={(nextValue) => update(q.id, nextValue)}
                />
              ) : null}
              {q.type === 'text' ? (
                <input
                  type="text"
                  className="qf-input"
                  aria-label={q.label}
                  value={typeof value === 'string' ? value : ''}
                  placeholder={q.placeholder}
                  disabled={locked}
                  onChange={(e) => update(q.id, e.target.value)}
                />
              ) : null}
              {q.type === 'textarea' ? (
                <textarea
                  className="qf-textarea"
                  aria-label={q.label}
                  value={typeof value === 'string' ? value : ''}
                  placeholder={q.placeholder}
                  disabled={locked}
                  rows={3}
                  onChange={(e) => update(q.id, e.target.value)}
                />
              ) : null}
              {q.type === 'direction-cards' && q.cards && q.cards.length > 0 ? (
                <div className="qf-direction-cards">
                  {q.cards.map((card) => (
                    <DirectionCardView
                      key={card.id}
                      card={card}
                      formId={form.id}
                      questionId={q.id}
                      selected={value === card.id || value === card.label}
                      disabled={locked}
                      onSelect={() => update(q.id, card.id)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {locked ? (
        <div className="question-form-foot">
          <span className="qf-locked-note">
            {submittedAnswers
              ? t(submittedQueued ? 'qf.lockedQueued' : 'qf.lockedSubmitted')
              : t('qf.lockedPrev')}
          </span>
        </div>
      ) : hideInternalSubmit ? null : (
        <div className="question-form-foot">
          <span className="qf-hint">{t('qf.hint')}</span>
          <button
            type="button"
            className="primary"
            onClick={handleSubmit}
            disabled={submitDisabled || !ready}
            title={ready ? t('qf.submitTitle') : t('qf.submitDisabledTitle')}
          >
            {form.submitLabel ?? t('qf.submitDefault')}
          </button>
        </div>
      )}
    </div>
  );
});

function RadioPillGroup({
  label,
  options,
  value,
  disabled,
  onSelect,
}: {
  label: string;
  options: FormOption[];
  value: string;
  disabled: boolean;
  onSelect: (value: string) => void;
}) {
  const selectedIndex = options.findIndex((option) => option.value === value);
  const tabStopIndex = selectedIndex >= 0 ? selectedIndex : 0;

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (index + 1) % options.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (index - 1 + options.length) % options.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = options.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextOption = options[nextIndex];
    if (!nextOption) return;
    onSelect(nextOption.value);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
      .item(nextIndex)
      .focus();
  }

  return (
    <div className="qf-options" role="radiogroup" aria-label={label}>
      {options.map((option, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.label}
            tabIndex={index === tabStopIndex ? 0 : -1}
            title={option.description}
            className={`qf-chip${selected ? ' qf-chip-on' : ''}`}
            disabled={disabled}
            onClick={() => onSelect(option.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            <OptionCopy option={option} />
          </button>
        );
      })}
    </div>
  );
}

function OptionCopy({ option }: { option: FormOption }) {
  return (
    <span className="qf-chip-copy">
      <span>{option.label}</span>
      {option.description ? <span className="qf-chip-desc">{option.description}</span> : null}
    </span>
  );
}

function DirectionCardView({
  card,
  formId,
  questionId,
  selected,
  disabled,
  onSelect,
}: {
  card: DirectionCard;
  formId: string;
  questionId: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  return (
    <label
      className={`qf-card${selected ? ' qf-card-on' : ''}${disabled ? ' qf-card-disabled' : ''}`}
    >
      <input
        type="radio"
        name={`${formId}-${questionId}`}
        value={card.id}
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect()}
      />
      <div className="qf-card-head">
        <div className="qf-card-title">{card.label}</div>
        {selected ? <span className="qf-card-pill">{t('qf.cardSelected')}</span> : null}
      </div>
      {card.palette.length > 0 ? (
        <div className="qf-card-swatches" aria-hidden>
          {card.palette.slice(0, 6).map((c, i) => (
            <span
              key={i}
              className="qf-card-swatch"
              style={{ background: c }}
              title={c}
            />
          ))}
        </div>
      ) : null}
      <div className="qf-card-types" aria-hidden>
        <span className="qf-card-type-display" style={{ fontFamily: card.displayFont }}>
          Aa
        </span>
        <span className="qf-card-type-body" style={{ fontFamily: card.bodyFont }}>
          {t('qf.cardSampleText')}
        </span>
      </div>
      {card.mood ? <p className="qf-card-mood">{card.mood}</p> : null}
      {card.references.length > 0 ? (
        <p className="qf-card-refs">
          <span className="qf-card-refs-label">{t('qf.cardRefs')}</span>{' '}
          {card.references.slice(0, 4).join(' · ')}
        </p>
      ) : null}
    </label>
  );
}

function buildInitialState(
  form: QuestionForm,
  submitted: Record<string, string | string[]> | undefined,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const q of form.questions) {
    if (submitted && submitted[q.id] !== undefined) {
      out[q.id] = canonicalizeQuestionValue(q, submitted[q.id]!);
      continue;
    }
    if (q.defaultValue !== undefined) {
      out[q.id] = canonicalizeQuestionValue(q, q.defaultValue);
      continue;
    }
    if (q.type === 'checkbox') {
      out[q.id] = [];
    } else {
      out[q.id] = '';
    }
  }
  return out;
}

function canonicalizeQuestionValue(
  q: QuestionForm['questions'][number],
  value: string | string[],
): string | string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => formOptionValueForLabel(q, entry));
  }
  return formOptionValueForLabel(q, value);
}

/**
 * Reverse of formatFormAnswers — when we render an old assistant message
 * that contained a form, look at the next user message in the conversation
 * to see if the form was already answered. If so, return the answers map
 * so the form renders in the locked "answered" state with the user's
 * picks visible.
 */
export function parseSubmittedAnswers(
  form: QuestionForm,
  userMessageContent: string,
): Record<string, string | string[]> | null {
  const lines = userMessageContent.split('\n');
  if (lines.length === 0) return null;
  const header = (lines[0] ?? '').trim();
  // We accept any "form answers" header so the agent can paraphrase.
  if (!/^\[form answers/i.test(header)) return null;
  const answers: Record<string, string | string[]> = {};
  const labelToQuestion = new Map(form.questions.map((q) => [q.label.toLowerCase(), q]));
  const rawAnswers = new Map<string, string>();
  let currentQuestion: QuestionForm['questions'][number] | undefined;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = /^[-*]\s*([^:]+):\s*(.*)$/.exec(line.trim());
    const q = m ? labelToQuestion.get(m[1]!.trim().toLowerCase()) : undefined;
    if (q && m) {
      currentQuestion = q;
      rawAnswers.set(q.id, m[2]!);
    } else if (currentQuestion?.type === 'text' || currentQuestion?.type === 'textarea') {
      rawAnswers.set(currentQuestion.id, `${rawAnswers.get(currentQuestion.id)}\n${line}`);
    }
  }
  for (const q of form.questions) {
    const raw = rawAnswers.get(q.id);
    if (raw === undefined) continue;
    const value = raw.trim();
    if (q.type === 'checkbox') {
      answers[q.id] = parseSubmittedOptionValues(q, value);
    } else {
      answers[q.id] = value.toLowerCase() === '(skipped)' ? '' : formOptionValueForLabel(q, parseSubmittedOptionToken(value));
    }
  }
  return Object.keys(answers).length > 0 ? answers : null;
}

function parseSubmittedOptionValues(q: QuestionForm['questions'][number], value: string): string[] {
  // Match complete known options before consuming the comma separator: labels
  // and stable values can themselves contain commas, including legacy labels.
  const tokens = (q.options ?? []).flatMap((option) => [
    `${option.label} [value: ${option.value}]`, option.label, option.value,
  ]).sort((a, b) => b.length - a.length);
  const values: string[] = [];
  let remaining = value;
  while (remaining) {
    const token = tokens.find((candidate) => remaining.startsWith(candidate)
      && (remaining.length === candidate.length || remaining[candidate.length] === ','));
    const next = token ?? remaining.split(',')[0]!;
    const trimmed = next.trim();
    if (trimmed && trimmed.toLowerCase() !== '(skipped)') {
      values.push(formOptionValueForLabel(q, parseSubmittedOptionToken(trimmed)));
    }
    remaining = remaining.slice(next.length).replace(/^,\s*/, '').trim();
  }
  return values;
}

function parseSubmittedOptionToken(raw: string): string {
  const match = /\s+\[value:\s*([^\]]+)\]\s*$/i.exec(raw);
  if (!match) return raw.trim();
  return match[1]!.trim();
}
