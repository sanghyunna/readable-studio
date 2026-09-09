import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@readable-studio/components';
import { questionsFormTrackingId } from '@readable-studio/contracts/analytics';
import { useT } from '../i18n';
import { useAnalytics } from '../analytics/provider';
import { trackQuestionsFormClick, trackQuestionsFormSurfaceView } from '../analytics/events';
import type { QuestionForm } from '../artifacts/question-form';
import { QuestionFormView, type QuestionFormHandle } from './QuestionForm';
import { localizeBriefAssumption, questionForAssumption, type BriefAssumption, type ProjectBrief } from './brief-state';
import './QuestionsPanel.css';

const viewedFormOccurrences = new Set<string>();
const QUESTION_FORM_DRAFT_STORAGE_PREFIX = 'readable-studio:question-form-draft:';
type QuestionFormAnswers = Record<string, string | string[]>;
export type QuestionRunHydrationStatus = 'pending' | 'failed' | 'ready';

interface Props {
  brief?: ProjectBrief | null;
  onCorrect?: (brief: ProjectBrief, corrected: BriefAssumption) => Promise<boolean>;
  projectId?: string;
  form: QuestionForm | null;
  formKey?: string | null;
  interactive: boolean;
  submitDisabled?: boolean;
  runHydrationStatus?: QuestionRunHydrationStatus;
  onRetryRunHydration?: () => void;
  submissionQueued?: boolean;
  submittedAnswers?: QuestionFormAnswers;
  generating: boolean;
  onSubmit: (text: string) => void;
}

export function QuestionsPanel({
  brief,
  onCorrect,
  projectId,
  form,
  formKey = null,
  interactive,
  submitDisabled = false,
  runHydrationStatus = 'ready',
  onRetryRunHydration,
  submissionQueued = false,
  submittedAnswers,
  generating,
  onSubmit,
}: Props) {
  const t = useT();
  const analytics = useAnalytics();
  const formRef = useRef<QuestionFormHandle>(null);
  const [ready, setReady] = useState(false);
  const [draftAnswers, setDraftAnswers] = useState<QuestionFormAnswers | undefined>(() => readQuestionFormDraft(formKey));
  const answered = submittedAnswers !== undefined;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [correctionError, setCorrectionError] = useState(false);
  const savingRef = useRef(false);
  const assumptions = useMemo(() => brief?.assumptions.map(item => localizeBriefAssumption(item, t)) ?? [], [brief, t]);
  const editing = assumptions.find(item => item.id === editingId);
  const correctionForm = useMemo<QuestionForm | null>(() => editing ? {
    id: `correction-${editing.id}`, title: t('questions.correctTitle', { label: editing.label }),
    questions: [questionForAssumption(editing)], submitLabel: t('questions.applyCorrection'),
  } : null, [editing, t]);
  const correctionDisabled = submitDisabled || runHydrationStatus !== 'ready' || saving;
  async function applyCorrection(answers: QuestionFormAnswers) {
    if (!editing || !brief || !onCorrect || correctionDisabled || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setCorrectionError(false);
    const corrected: BriefAssumption = { ...editing, value: answers[editing.id] ?? '', displayValue: undefined, provenance: 'stated' };
    try {
      const persisted = await onCorrect({ assumptions: brief.assumptions.map(item => item.id === editing.id ? corrected : item), updatedAt: Date.now() }, corrected);
      if (persisted) setEditingId(null);
      else setCorrectionError(true);
    } catch {
      setCorrectionError(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!form || answered || !projectId) return;
    const key = formKey ?? `${projectId}:${form.id}`;
    if (viewedFormOccurrences.has(key)) return;
    viewedFormOccurrences.add(key);
    trackQuestionsFormSurfaceView(analytics.track, {
      page_name: 'chat_panel', area: 'questions_form', project_id: projectId,
      form_id: questionsFormTrackingId(form.id),
    });
  }, [form, answered, formKey, projectId, analytics.track]);

  useEffect(() => setDraftAnswers(readQuestionFormDraft(formKey)), [formKey]);
  useEffect(() => { if (answered) clearQuestionFormDraft(formKey); }, [answered, formKey]);

  const updateDraftAnswers = useCallback((answers: QuestionFormAnswers) => {
    setDraftAnswers(answers);
    writeQuestionFormDraft(formKey, answers);
  }, [formKey]);

  const handleAnswerChange = useCallback((questionId: string, value: string | string[]) => {
    if (!form || !projectId || typeof value !== 'string' || value.length === 0) return;
    const element = questionId === 'taskType' ? 'task_type_chip' as const
      : questionId === 'brand' ? 'brand_bg_chip' as const : null;
    if (!element) return;
    trackQuestionsFormClick(analytics.track, {
      page_name: 'chat_panel', area: 'questions_form', element,
      chip_id: questionsFormTrackingId(value), form_id: questionsFormTrackingId(form.id), project_id: projectId,
    });
  }, [analytics.track, form, projectId]);

  const submitAndClearDraft = useCallback((text: string, answers: QuestionFormAnswers) => {
    if (form && projectId) {
      const answeredCount = form.questions.filter(q => {
        const value = answers[q.id];
        return Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim().length > 0;
      }).length;
      trackQuestionsFormClick(analytics.track, {
        page_name: 'chat_panel', area: 'questions_form', element: 'submit',
        answered_count: answeredCount, skipped_count: form.questions.length - answeredCount,
        form_id: questionsFormTrackingId(form.id), project_id: projectId,
      });
    }
    clearQuestionFormDraft(formKey);
    setDraftAnswers(undefined);
    onSubmit(text);
  }, [analytics.track, form, formKey, onSubmit, projectId]);

  const canSubmit = Boolean(form && interactive && !answered && !generating && !submitDisabled
    && runHydrationStatus === 'ready');
  const canContinue = canSubmit && ready;

  return (
    <section className="questions-panel" data-testid="questions-panel" data-step={editing ? 'correct' : 'summary'} role="dialog" aria-labelledby="questions-panel-title">
      <header className="questions-panel__head">
        {editing ? <Button variant="ghost" disabled={saving} aria-label={t('questions.backToSummary')} onClick={() => { setEditingId(null); setCorrectionError(false); }}>‹</Button> : null}
        <div><h2 id="questions-panel-title">{editing ? t('questions.correctTitle', { label: editing.label }) : t('questions.title')}</h2>
          <p>{t(editing ? 'questions.correctionDescription' : 'questions.description')}</p></div>
      </header>
      <div className="questions-panel-body">
        {editing && correctionForm ? <div className="questions-panel__editor">
          <QuestionFormView key={editing.id} form={correctionForm} interactive hideInternalHead
            submitDisabled={correctionDisabled} draftAnswers={{ [editing.id]: editing.value }}
            onSubmit={(_text, answers) => applyCorrection(answers)} />
          {correctionError ? <p role="alert">{t('questions.correctionFailed')}</p> : null}
        </div> : <>
        {brief ? <div className="questions-panel__groups" role="group" aria-label={t('questions.assumptions')}>
          <p className="questions-panel__influence" data-testid="questions-influence" data-count={assumptions.length} data-confirmed={assumptions.filter(item => item.provenance === 'stated').length}>
            {t('questions.influence', { count: assumptions.length, stated: assumptions.filter(item => item.provenance === 'stated').length })}
          </p>
          {(['stated', 'inferred', 'default'] as const).map(provenance => {
            const group = assumptions.filter(item => item.provenance === provenance);
            return group.length ? <section className="questions-panel__group" key={provenance}>
              <h3 data-provenance={provenance}>{t(`questions.provenance.${provenance}`)}</h3>
              <div className="questions-panel__chips" role="list">{group.map(item => {
                const value = item.displayValue ?? (Array.isArray(item.value) ? item.value.join(', ') : item.value);
                return <Button key={item.id} role="listitem" className="questions-panel__chip" data-provenance={provenance}
                  disabled={!onCorrect} aria-label={t('questions.assumptionLabel', { label: item.label, value, provenance: t(`questions.provenance.${provenance}`) })}
                  onClick={() => { setEditingId(item.id); setCorrectionError(false); }}>
                  <span className="questions-panel__key">{item.label}</span><span className="questions-panel__value">{value}</span>
                </Button>;
              })}</div>
            </section> : null;
          })}
        </div> : null}
        {form ? (
          <div className="questions-panel__editor">
          <h3>{form.title}</h3>{answered ? <span className="question-form-pill">{t('qf.answered')}</span> : null}
          {form.description ? <p>{form.description}</p> : null}
          <QuestionFormView
            ref={formRef}
            form={form}
            interactive={interactive}
            submitDisabled={!canSubmit}
            submittedAnswers={submittedAnswers}
            submittedQueued={submissionQueued}
            draftAnswers={draftAnswers}
            hideInternalSubmit
            hideInternalHead
            onReadyChange={setReady}
            onDraftChange={updateDraftAnswers}
            onAnswerChange={handleAnswerChange}
            onSubmit={submitAndClearDraft}
          />
          </div>
        ) : !brief ? <div className="questions-panel-skeleton">{t(generating ? 'questions.generating' : 'questions.empty')}</div> : null}
        </>}
      </div>
      <div className="questions-panel-foot">
        <span className="questions-panel-status" role="status">
          {runHydrationStatus === 'pending'
            ? t('questions.hydratingRuns')
            : runHydrationStatus === 'failed'
              ? t('questions.runHydrationFailed')
              : generating
                ? t('questions.generating')
                : submissionQueued
                  ? t(answered ? 'questions.queued' : 'questions.willQueue')
                  : null}
        </span>
        {runHydrationStatus === 'failed' && onRetryRunHydration ? (
          <Button variant="ghost" onClick={onRetryRunHydration}>
            {t('questions.retryRunHydration')}
          </Button>
        ) : null}
        {!editing && form && !answered ? (
          <button
            type="button"
            className="questions-skip"
            disabled={!canSubmit}
            onClick={() => formRef.current?.skipAll()}
          >
            {t('questions.skipAll')}
          </button>
        ) : null}
        {!editing && form ? <button type="button" className="questions-continue" disabled={!canContinue} onClick={() => formRef.current?.submit()}>
          {t('questions.continue')}
        </button> : null}
      </div>
    </section>
  );
}

function questionFormDraftStorageKey(formKey: string | null | undefined): string | null {
  return formKey ? `${QUESTION_FORM_DRAFT_STORAGE_PREFIX}${formKey}` : null;
}
function readQuestionFormDraft(formKey: string | null | undefined): QuestionFormAnswers | undefined {
  const key = questionFormDraftStorageKey(formKey);
  if (!key || typeof window === 'undefined') return undefined;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const out: QuestionFormAnswers = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === 'string') out[id] = value;
      else if (Array.isArray(value) && value.every(item => typeof item === 'string')) out[id] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch { return undefined; }
}
function writeQuestionFormDraft(formKey: string | null | undefined, answers: QuestionFormAnswers): void {
  const key = questionFormDraftStorageKey(formKey);
  if (!key || typeof window === 'undefined') return;
  try { window.sessionStorage.setItem(key, JSON.stringify(answers)); } catch { /* input remains usable */ }
}
function clearQuestionFormDraft(formKey: string | null | undefined): void {
  const key = questionFormDraftStorageKey(formKey);
  if (!key || typeof window === 'undefined') return;
  try { window.sessionStorage.removeItem(key); } catch { /* submitted message is authoritative */ }
}
