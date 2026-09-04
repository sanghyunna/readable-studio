import { useMemo, useState } from 'react';
import type { QuestionForm } from '../artifacts/question-form';
import { QuestionFormView } from './QuestionForm';
import {
  formatBriefSteering,
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

export function BriefCard({ brief, onChange, onSteer, onTrackEdit }: BriefCardProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = brief.assumptions.find(item => item.id === editingId) ?? null;
  const editorForm = useMemo<QuestionForm | null>(() => editing ? ({
    id: `brief-${editing.id}`,
    title: `Correct ${editing.label}`,
    description: 'This updates the project brief and steers work already in progress.',
    questions: [questionForAssumption(editing)],
    submitLabel: 'Apply correction',
  }) : null, [editing]);

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
    <section className="brief-card" aria-labelledby="brief-card-title" data-testid="brief-card">
      <header className="brief-card__head">
        <div>
          <h2 id="brief-card-title">Brief</h2>
          <p>Working assumptions - select any chip to correct it.</p>
        </div>
        <span className="brief-card__status">Live</span>
      </header>
      <div className="brief-card__chips" role="list" aria-label="Project assumptions">
        {brief.assumptions.map(assumption => (
          <button
            key={assumption.id}
            type="button"
            role="listitem"
            className="brief-card__chip"
            data-provenance={assumption.provenance}
            aria-label={`${assumption.label}: ${displayAssumptionValue(assumption)} (${assumption.provenance})`}
            onClick={() => setEditingId(assumption.id)}
          >
            <span className="brief-card__key">{assumption.label}</span>
            <span className="brief-card__value">{displayAssumptionValue(assumption)}</span>
            <span className="brief-card__provenance">{assumption.provenance}</span>
          </button>
        ))}
      </div>
      {editing && editorForm ? (
        <div className="brief-card__popover" role="dialog" aria-label={`Correct ${editing.label}`}>
          <QuestionFormView
            key={editing.id}
            form={editorForm}
            interactive
            draftAnswers={{ [editing.id]: editing.value }}
            onSubmit={(_text, answers) => apply(answers[editing.id] ?? '')}
          />
          <button type="button" className="brief-card__cancel" onClick={() => setEditingId(null)}>Cancel</button>
        </div>
      ) : null}
    </section>
  );
}

function displayAssumptionValue(assumption: BriefAssumption): string {
  if (assumption.displayValue) return assumption.displayValue;
  return Array.isArray(assumption.value) ? assumption.value.join(', ') : assumption.value;
}
