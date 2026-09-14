import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@readable-studio/components';
import { useT } from '../i18n';
import { questionForAssumption, type BriefAssumption, type ProjectBrief } from './brief-state';
import { QuestionAssumptionEditor } from './QuestionAssumptionEditor';
import { Icon } from './Icon';
import './QuestionsPanel.css';
import './AssumptionLedger.css';

// Persisted project assumptions are background context, not a pending
// request. The inline question card shows them next to the form that produced
// them; this compact chat-header affordance is the home for the same ledger
// whenever no form is in view (new conversation, receipt-only project, form
// scrolled out of history). Corrections go through the SAME `onCorrect` the
// card uses, so there is one write path into metadata.brief.
interface Props {
  brief: ProjectBrief | null | undefined;
  onCorrect?: (brief: ProjectBrief, corrected: BriefAssumption) => Promise<boolean>;
  disabled?: boolean;
}

const PROVENANCES = ['stated', 'inferred', 'default'] as const;

export function AssumptionLedger({ brief, onCorrect, disabled = false }: Props) {
  const t = useT();
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const editorId = `${baseId}-editor`;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | string[] | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const savingRef = useRef(false);
  const editingRef = useRef<string | null>(null);
  editingRef.current = editingId;
  const returnFocusId = useRef<string | null>(null);

  const assumptions = useMemo(() => brief?.assumptions ?? [], [brief]);
  const confirmed = assumptions.filter(item => item.provenance === 'stated').length;
  const editing = assumptions.find(item => item.id === editingId);
  const correctionDisabled = disabled || saving || !onCorrect;

  const closeEditor = useCallback((returnFocus: boolean) => {
    if (savingRef.current) return;
    setEditingId(null);
    setDraft(undefined);
    setError(false);
    if (returnFocus) anchorRef.current?.focus();
  }, []);

  const closeLedger = useCallback((returnFocus: boolean) => {
    if (savingRef.current) return;
    setEditingId(null);
    setDraft(undefined);
    setError(false);
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      // The correction editor is portalled; while it is open it owns dismissal.
      if (editingRef.current) return;
      if (!rootRef.current?.contains(event.target as Node)) closeLedger(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || editingRef.current) return;
      event.preventDefault();
      closeLedger(true);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, closeLedger]);

  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLElement>('.assumption-ledger__row')?.focus();
  }, [open]);

  useEffect(() => {
    if (editingId || saving || !returnFocusId.current) return;
    document.getElementById(returnFocusId.current)?.focus();
    returnFocusId.current = null;
  }, [editingId, saving]);

  async function applyCorrection(value: string | string[]) {
    if (!editing || !brief || !onCorrect || correctionDisabled || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(false);
    const corrected: BriefAssumption = { ...editing, value, displayValue: undefined, provenance: 'stated' };
    try {
      const persisted = await onCorrect(
        { assumptions: brief.assumptions.map(item => item.id === editing.id ? corrected : item), updatedAt: Date.now() },
        corrected,
      );
      if (persisted) {
        returnFocusId.current = `${editorId}-${editing.id}`;
        setEditingId(null);
        setDraft(undefined);
      } else setError(true);
    } catch {
      setError(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  if (assumptions.length === 0) return null;

  return (
    <div ref={rootRef} className={`assumption-ledger${open ? ' open' : ''}`} data-testid="assumption-ledger">
      <button
        ref={triggerRef}
        type="button"
        className="assumption-ledger__trigger"
        data-testid="assumption-ledger-trigger"
        title={t('questions.assumptions')}
        aria-label={t('questions.ledgerTrigger', { count: assumptions.length, stated: confirmed })}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${baseId}-dialog` : undefined}
        onClick={() => (open ? closeLedger(false) : setOpen(true))}
      >
        <Icon name="sliders" size={16} />
        <span className="assumption-ledger__count" aria-hidden>{assumptions.length}</span>
      </button>
      {open ? (
        <div id={`${baseId}-dialog`} className="assumption-ledger__menu" role="dialog" aria-labelledby={titleId}
          data-testid="assumption-ledger-menu">
          <div className="assumption-ledger__head">
            <h2 id={titleId} className="assumption-ledger__title">{t('questions.assumptions')}</h2>
            <p className="assumption-ledger__influence" data-testid="assumption-ledger-influence"
              data-count={assumptions.length} data-confirmed={confirmed}>
              {t('questions.influence', { count: assumptions.length, stated: confirmed })}
            </p>
          </div>
          <div className="assumption-ledger__body">
            {PROVENANCES.map(provenance => {
              const group = assumptions.filter(item => item.provenance === provenance);
              if (!group.length) return null;
              return (
                <section className="assumption-ledger__group" key={provenance} data-provenance={provenance}>
                  <h3>{t(`questions.provenance.${provenance}`)} <span>{group.length}</span></h3>
                  <ul className="assumption-ledger__rows">
                    {group.map(item => {
                      const value = item.displayValue ?? (Array.isArray(item.value) ? item.value.join(', ') : item.value);
                      const question = questionForAssumption(item);
                      return (
                        <li key={item.id}>
                          <Button id={`${editorId}-${item.id}`} className="assumption-ledger__row" data-provenance={provenance}
                            disabled={!onCorrect} aria-disabled={saving || undefined}
                            aria-label={t('questions.assumptionLabel', { label: item.label, value, provenance: t(`questions.provenance.${provenance}`) })}
                            aria-haspopup={question.options || question.cards ? 'listbox' : undefined}
                            aria-expanded={editingId === item.id} aria-controls={editingId === item.id ? editorId : undefined}
                            onClick={event => {
                              if (savingRef.current) return;
                              if (editingId === item.id) { closeEditor(true); return; }
                              anchorRef.current = event.currentTarget;
                              setDraft(undefined);
                              setEditingId(item.id);
                              setError(false);
                            }}>
                            <span className="assumption-ledger__key">{item.label}</span>
                            <span className="assumption-ledger__value">{value || t('common.none')}</span>
                            <Icon name="chevron-down" size={16} />
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
          {error && !editing ? <p className="assumption-ledger__error" role="alert">{t('questions.correctionFailed')}</p> : null}
        </div>
      ) : null}
      {editing && anchorRef.current ? (
        <QuestionAssumptionEditor key={editing.id} id={editorId}
          assumption={editing} anchor={anchorRef.current} value={draft ?? editing.value}
          disabled={correctionDisabled} saving={saving} error={error}
          onChange={setDraft} onSave={applyCorrection}
          onClose={closeEditor} onCancel={() => closeEditor(true)} />
      ) : null}
    </div>
  );
}
