import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { QuestionForm } from '../artifacts/question-form';
import { useT } from '../i18n';
import { placePopover } from './popoverPlacement';
import { QuestionFormView } from './QuestionForm';
import {
  formatBriefSteering,
  localizeBriefAssumption,
  questionForAssumption,
  type AssumptionValue,
  type BriefAssumption,
  type ProjectBrief,
} from './brief-state';
import './BriefCard.css';

interface BriefCardProps {
  brief: ProjectBrief;
  onChange: (brief: ProjectBrief) => void | Promise<void>;
  onSteer: (payload: string) => void;
  onTrackEdit?: (event: { fieldId: string; provenance: BriefAssumption['provenance'] }) => void;
}

const PROVENANCE_ORDER: BriefAssumption['provenance'][] = ['stated', 'inferred', 'default'];

type PanelRect = { left: number; top: number };

export function BriefCard({ brief, onChange, onSteer, onTrackEdit }: BriefCardProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The compact trigger lives in the preview toolbar, but the editor panel is
  // a body-level fixed layer: preview frames and toolbar chrome deliberately
  // clip their contents. Shared measured placement keeps the variable-height
  // panel anchored, viewport-clamped, and above those stacking contexts.
  const [rect, setRect] = useState<PanelRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const localizedAssumptions = useMemo(
    () => brief.assumptions.map((assumption) => localizeBriefAssumption(assumption, t)),
    [brief.assumptions, t],
  );
  const editing = localizedAssumptions.find(item => item.id === editingId) ?? null;
  const grouped = useMemo(() => PROVENANCE_ORDER.map(provenance => ({
    provenance,
    assumptions: localizedAssumptions.filter(item => item.provenance === provenance),
  })).filter(group => group.assumptions.length > 0), [localizedAssumptions]);
  const summary = localizedAssumptions.find(item => item.provenance === 'stated') ?? localizedAssumptions[0];
  const editorForm = useMemo<QuestionForm | null>(() => editing ? ({
    id: `brief-${editing.id}`,
    title: t('brief.correctTitle', { label: editing.label }),
    description: t('brief.correctionDescription'),
    questions: [questionForAssumption(editing)],
    submitLabel: t('brief.applyCorrection'),
  }) : null, [editing, t]);
  const provenanceLabel = (provenance: BriefAssumption['provenance']) => {
    switch (provenance) {
      case 'stated': return t('brief.provenance.stated');
      case 'inferred': return t('brief.provenance.inferred');
      case 'default': return t('brief.provenance.default');
    }
  };

  const collapse = useCallback(() => {
    setExpanded(false);
    setEditingId(null);
  }, []);

  // Placement is measured, never assumed: the panel's height depends on how
  // many assumption groups the brief has, and the editor overlay changes it
  // again. Re-measuring on resize and on scroll (capture) keeps it pinned to a
  // trigger that lives inside scrolling, sticky chrome.
  useLayoutEffect(() => {
    if (!expanded) return;
    const updatePosition = () => {
      const anchorNode = triggerRef.current;
      const panel = panelRef.current;
      if (!anchorNode || !panel) return;
      const anchor = anchorNode.getBoundingClientRect();
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      // Pre-paint the panel has no box; placing against 0x0 would park it in
      // the viewport gutter. Wait for the next measured pass instead.
      if (width === 0 || height === 0) return;
      setRect(
        placePopover(
          { left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height },
          { width, height },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
    // `grouped` is a fresh array every render, so its identity cannot be a
    // dependency: it would re-run this effect, set state, and loop. The panel's
    // height only changes when the number of rendered assumptions changes or
    // the editor overlay opens, and both are captured by scalars.
  }, [expanded, editingId, brief.assumptions.length]);

  // Portaled to <body>, the panel is no longer a DOM descendant of the trigger,
  // so outside-click and Escape have to be handled explicitly.
  useEffect(() => {
    if (!expanded) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      collapse();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      collapse();
      // Focus returns to the trigger so the panel is not a keyboard dead end.
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [collapse, expanded]);

  function apply(value: AssumptionValue) {
    if (!editing) return;
    const assumptions = brief.assumptions.map(item => item.id === editing.id
      ? { ...item, value, displayValue: undefined, provenance: 'stated' as const }
      : item);
    const next = { assumptions, updatedAt: Date.now() };
    // One chokepoint owns persistence, steering, and analytics so a correction
    // can never send duplicate messages from individual controls.
    void onChange(next);
    onSteer(formatBriefSteering(editing, value));
    onTrackEdit?.({ fieldId: editing.id, provenance: editing.provenance });
    setEditingId(null);
  }

  return (
    <div className="brief-card" data-testid="brief-card" data-expanded={expanded ? 'true' : undefined}>
      <button
        type="button"
        ref={triggerRef}
        className="brief-card__trigger"
        aria-expanded={expanded}
        aria-controls="project-brief-panel"
        onClick={() => {
          if (expanded) {
            collapse();
            return;
          }
          // Rect is computed by the layout effect once the panel has a real
          // measured box; until then it renders hidden rather than misplaced.
          setRect(null);
          setExpanded(true);
        }}
      >
        <span className="brief-card__trigger-title">{t('brief.trigger')}</span>
        {summary ? (
          <span className="brief-card__summary">
            <span>{summary.label}</span>
            <strong>{displayAssumptionValue(summary)}</strong>
          </span>
        ) : null}
        <span className="brief-card__count">{brief.assumptions.length}</span>
        <span className="brief-card__chevron" aria-hidden>⌄</span>
      </button>
      {expanded && typeof document !== 'undefined' ? createPortal(
        <section
          id="project-brief-panel"
          ref={panelRef}
          className="brief-card__panel"
          data-testid="brief-card-panel"
          aria-labelledby="brief-card-title"
          style={
            rect
              ? { left: `${rect.left}px`, top: `${rect.top}px` }
              : // Measured on the next layout pass. Kept out of the paint and
                // out of hit-testing meanwhile, so no frame shows it misplaced.
                { left: '0px', top: '0px', visibility: 'hidden', pointerEvents: 'none' }
          }
        >
          <header className="brief-card__head">
            <div>
              <h2 id="brief-card-title">{t('brief.title')}</h2>
              <p>{t('brief.description')}</p>
            </div>
            <button type="button" className="brief-card__close" aria-label={t('brief.collapse')} onClick={collapse}>×</button>
          </header>
          <div className="brief-card__groups" role="group" aria-label={t('brief.assumptions')}>
            {grouped.map(group => (
              <section className="brief-card__group" key={group.provenance}>
                <h3 data-provenance={group.provenance}>{provenanceLabel(group.provenance)}</h3>
                <div className="brief-card__chips" role="list">
                  {group.assumptions.map(assumption => (
                    <button
                      key={assumption.id}
                      type="button"
                      role="listitem"
                      className="brief-card__chip"
                      data-provenance={assumption.provenance}
                      aria-label={t('brief.assumptionLabel', {
                        label: assumption.label,
                        value: displayAssumptionValue(assumption),
                        provenance: provenanceLabel(assumption.provenance),
                      })}
                      onClick={() => setEditingId(assumption.id)}
                    >
                      <span className="brief-card__key">{assumption.label}</span>
                      <span className="brief-card__value">{displayAssumptionValue(assumption)}</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
          {editing && editorForm ? (
            <div className="brief-card__editor" role="dialog" aria-label={t('brief.correctTitle', { label: editing.label })}>
              <QuestionFormView
                key={editing.id}
                form={editorForm}
                interactive
                draftAnswers={{ [editing.id]: editing.value }}
                onSubmit={(_text, answers) => apply(answers[editing.id] ?? '')}
              />
              <button type="button" className="brief-card__cancel" onClick={() => setEditingId(null)}>{t('common.cancel')}</button>
            </div>
          ) : null}
        </section>,
        document.body,
      ) : null}
    </div>
  );
}

function displayAssumptionValue(assumption: BriefAssumption): string {
  if (assumption.displayValue) return assumption.displayValue;
  return Array.isArray(assumption.value) ? assumption.value.join(', ') : assumption.value;
}
