import { useCallback, useEffect, useRef, useState } from 'react';
import { questionsFormTrackingId } from '@readable-studio/contracts/analytics';
import { useT } from '../i18n';
import { useAnalytics } from '../analytics/provider';
import { trackQuestionsFormClick, trackQuestionsFormSurfaceView } from '../analytics/events';
import type { QuestionForm } from '../artifacts/question-form';
import { QuestionFormView, type QuestionFormHandle } from './QuestionForm';

const viewedFormOccurrences = new Set<string>();
const QUESTION_FORM_DRAFT_STORAGE_PREFIX = 'readable-studio:question-form-draft:';
type QuestionFormAnswers = Record<string, string | string[]>;

interface Props {
  projectId?: string;
  form: QuestionForm | null;
  formKey?: string | null;
  interactive: boolean;
  submitDisabled?: boolean;
  submittedAnswers?: QuestionFormAnswers;
  generating: boolean;
  onSubmit: (text: string) => void;
}

export function QuestionsPanel({
  projectId,
  form,
  formKey = null,
  interactive,
  submitDisabled = false,
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

  const canContinue = Boolean(form && interactive && !generating && !submitDisabled && ready);

  return (
    <div className="questions-panel" data-testid="questions-panel">
      <div className="questions-panel-body">
        {form ? (
          <QuestionFormView
            ref={formRef}
            form={form}
            interactive={interactive}
            submittedAnswers={submittedAnswers}
            draftAnswers={draftAnswers}
            hideInternalSubmit
            onReadyChange={setReady}
            onDraftChange={updateDraftAnswers}
            onAnswerChange={handleAnswerChange}
            onSubmit={submitAndClearDraft}
          />
        ) : <div className="questions-panel-skeleton">{t('questions.generating')}</div>}
      </div>
      <div className="questions-panel-foot">
        <span className="questions-panel-status">{generating ? t('questions.generating') : null}</span>
        <button type="button" className="questions-continue" disabled={!canContinue} onClick={() => formRef.current?.submit()}>
          {t('questions.continue')}
        </button>
      </div>
    </div>
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
