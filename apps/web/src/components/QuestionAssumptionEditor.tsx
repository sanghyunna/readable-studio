import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@readable-studio/components';
import { useT } from '../i18n';
import { formOptionValueForLabel } from '../artifacts/question-form';
import { questionForAssumption, type BriefAssumption } from './brief-state';
import { DirectListbox } from './DirectListbox';
import { placePopover } from './popoverPlacement';

interface Props {
  id: string;
  assumption: BriefAssumption;
  anchor: HTMLButtonElement;
  value: string | string[];
  disabled: boolean;
  saving: boolean;
  error: boolean;
  onChange: (value: string | string[]) => void;
  onSave: (value: string | string[]) => void;
  onClose: (returnFocus: boolean) => void;
  onCancel: () => void;
}

export function QuestionAssumptionEditor({ id, assumption, anchor, value, disabled, saving, error, onChange, onSave, onClose, onCancel }: Props) {
  const t = useT();
  const question = questionForAssumption(assumption);
  const multiple = question.type === 'checkbox';
  const options = question.options ?? question.cards?.map(card => ({ value: card.id, label: card.label }));
  const canonicalValue = Array.isArray(value) ? value.map(entry => formOptionValueForLabel(question, entry)) : formOptionValueForLabel(question, value);
  const valid = !question.required || (Array.isArray(value) ? value.length > 0 : value.trim().length > 0);
  const withinCap = !Array.isArray(value) || question.maxSelections === undefined || value.length <= question.maxSelections;
  const feedback = error ? <p className="questions-panel__error" role="alert">{t('questions.correctionFailed')}</p> : null;
  const actions = <>
    {feedback}
    <div className="questions-panel__edit-actions">
      <Button variant="ghost" disabled={saving} onClick={onCancel}>{t('common.cancel')}</Button>
      <Button disabled={disabled || !valid || !withinCap} onClick={() => onSave(canonicalValue)}>{t('questions.applyCorrection')}</Button>
    </div>
  </>;
  if (options) return <DirectListbox
    anchorElement={anchor} listId={id} label={question.label} placeholder={t('qf.choose')}
    options={options} value={typeof canonicalValue === 'string' ? canonicalValue : ''}
    selectedValues={multiple ? Array.isArray(canonicalValue) ? canonicalValue : [] : undefined}
    maxSelections={question.maxSelections} disabled={disabled} keepOpenOnSelect onClose={onClose}
    popoverClassName="questions-panel__popover"
    footer={multiple ? actions : feedback}
    onChange={next => {
      if (multiple) {
        const current = Array.isArray(canonicalValue) ? canonicalValue : [];
        onChange(current.includes(next) ? current.filter(entry => entry !== next) : [...current, next]);
      } else { onChange(next); onSave(next); }
    }}
  />;
  return <AnchoredTextEditor id={id} anchor={anchor} label={question.label} onClose={onClose}>
    <label className="questions-panel__edit-label" htmlFor={`${id}-input`}>{question.label}</label>
    {question.help ? <p>{question.help}</p> : null}
    {question.type === 'textarea' ? <textarea id={`${id}-input`} className="qf-textarea" rows={3}
      value={typeof value === 'string' ? value : ''} placeholder={question.placeholder} disabled={saving}
      onChange={event => onChange(event.target.value)} /> : <input id={`${id}-input`} type="text" className="qf-input"
      value={typeof value === 'string' ? value : ''} placeholder={question.placeholder} disabled={saving}
      onChange={event => onChange(event.target.value)} />}
    {actions}
  </AnchoredTextEditor>;
}

function AnchoredTextEditor({ id, anchor, label, onClose, children }: {
  id: string; anchor: HTMLButtonElement; label: string; onClose: (returnFocus: boolean) => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    const panel = ref.current!;
    const place = () => setPosition(placePopover(anchor.getBoundingClientRect(),
      { width: panel.offsetWidth, height: panel.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
    place();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
    observer?.observe(panel);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { observer?.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchor]);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('input, textarea')?.focus(); }, []);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) onClose(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(true); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [anchor, onClose]);
  return createPortal(<div id={id} ref={ref} role="group" aria-label={label}
    className="inline-switcher__popover inline-switcher__popover--layer inline-switcher__popover--model questions-panel__popover questions-panel__popover--text"
    style={position}>
    {children}
  </div>, document.body);
}
