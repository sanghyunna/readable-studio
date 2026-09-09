import type { ProjectMetadata } from '../types';
import type { Dict } from '../i18n/types';
import { patchProject } from '../state/projects';
import type { FormQuestion, QuestionForm } from '../artifacts/question-form';
import { formatFormAnswers } from '../artifacts/question-form';

export type AssumptionProvenance = 'stated' | 'inferred' | 'default';
export type AssumptionValue = string | string[];

// Keep the storage/protocol names compatible while Questions owns the capability.
export type { QuestionAssumption as BriefAssumption, ProjectQuestions as ProjectBrief } from '@readable-studio/contracts';
import type { QuestionAssumption as BriefAssumption, ProjectQuestions as ProjectBrief } from '@readable-studio/contracts';

export type BriefProjectMetadata = ProjectMetadata & { brief?: ProjectBrief };

const STANDARD_QUESTIONS: Record<string, FormQuestion> = {
  output: {
    id: 'output', label: 'What are we making?', type: 'radio',
    options: ['Slide deck / pitch', 'Single web prototype / landing', 'Multi-screen app prototype', 'Dashboard / tool UI', 'Editorial / marketing page', 'Other'].map(value => ({ label: value, value })),
  },
  platform: {
    id: 'platform', label: 'Target platform', type: 'checkbox', maxSelections: 4,
    options: ['Responsive web', 'Desktop web', 'iOS app', 'Android app', 'Tablet app', 'Desktop app', 'Fixed canvas (1920×1080)'].map(value => ({ label: value, value })),
  },
  audience: { id: 'audience', label: 'Who is this for?', type: 'text', placeholder: 'e.g. dev-tools buyers' },
  tone: {
    id: 'tone', label: 'Visual tone', type: 'checkbox', maxSelections: 2,
    options: ['Editorial / magazine', 'Modern minimal', 'Playful / illustrative', 'Tech / utility', 'Luxury / refined', 'Brutalist / experimental', 'Human / approachable'].map(value => ({ label: value, value })),
  },
  brand: {
    id: 'brand', label: 'Brand context', type: 'radio',
    options: [
      { label: 'Pick a direction for me', value: 'pick_direction' },
      { label: 'I have a brand spec - I will share it', value: 'brand_spec' },
      { label: 'Match a reference site or screenshot', value: 'reference_match' },
    ],
  },
  scale: { id: 'scale', label: 'Roughly how much?', type: 'text', placeholder: 'e.g. 8 slides or 4 mobile screens' },
  constraints: { id: 'constraints', label: 'Important constraints', type: 'textarea', placeholder: 'Real copy, required fonts, things to avoid...' },
};

export function questionForAssumption(assumption: BriefAssumption): FormQuestion {
  return assumption.question ?? STANDARD_QUESTIONS[assumption.id] ?? {
    id: assumption.id,
    label: assumption.label,
    type: Array.isArray(assumption.value) ? 'checkbox' : 'text',
    ...(Array.isArray(assumption.value)
      ? { options: assumption.value.map(value => ({ label: value, value })) }
      : {}),
  };
}

type Translate = (key: keyof Dict, vars?: Record<string, string | number>) => string;

const FIELD_LABEL_KEYS: Partial<Record<string, keyof Dict>> = {
  output: 'questions.field.output',
  platform: 'questions.field.platform',
  audience: 'questions.field.audience',
  tone: 'questions.field.tone',
  brand: 'questions.field.brand',
  scale: 'questions.field.scale',
  language: 'questions.field.language',
  constraints: 'questions.field.constraints',
  fidelity: 'questions.field.fidelity',
  platformTargets: 'questions.field.platformTargets',
  companionSurfaces: 'questions.field.companionSurfaces',
  speakerNotes: 'questions.field.speakerNotes',
  animations: 'questions.field.animations',
};

const QUESTION_LABEL_KEYS: Partial<Record<string, keyof Dict>> = {
  output: 'questions.question.output',
  platform: 'questions.question.platform',
  audience: 'questions.question.audience',
  tone: 'questions.question.tone',
  brand: 'questions.question.brand',
  scale: 'questions.question.scale',
  language: 'questions.question.language',
  constraints: 'questions.question.constraints',
  fidelity: 'newproj.fidelityLabel',
  platformTargets: 'newproj.targetPlatformsLabel',
  companionSurfaces: 'questions.field.companionSurfaces',
  speakerNotes: 'newproj.toggleSpeakerNotes',
  animations: 'newproj.toggleAnimations',
};

const PLACEHOLDER_KEYS: Partial<Record<string, keyof Dict>> = {
  audience: 'questions.placeholder.audience',
  scale: 'questions.placeholder.scale',
  constraints: 'questions.placeholder.constraints',
};

const OPTION_LABEL_KEYS: Partial<Record<string, keyof Dict>> = {
  'output:Slide deck / pitch': 'questions.option.slideDeck',
  'output:Single web prototype / landing': 'questions.option.singlePrototype',
  'output:Multi-screen app prototype': 'questions.option.multiPrototype',
  'output:Dashboard / tool UI': 'questions.option.dashboard',
  'output:Editorial / marketing page': 'questions.option.editorial',
  'output:Other': 'questions.option.other',
  'platform:Responsive web': 'newproj.platform.responsive.label',
  'platform:Desktop web': 'newproj.platform.webDesktop.label',
  'platform:iOS app': 'newproj.platform.mobileIos.label',
  'platform:Android app': 'newproj.platform.mobileAndroid.label',
  'platform:Tablet app': 'newproj.platform.tablet.label',
  'platform:Desktop app': 'newproj.platform.desktopApp.label',
  'platform:Fixed canvas (1920×1080)': 'questions.option.fixedCanvas',
  'tone:Editorial / magazine': 'questions.option.toneEditorial',
  'tone:Modern minimal': 'questions.option.toneMinimal',
  'tone:Playful / illustrative': 'questions.option.tonePlayful',
  'tone:Tech / utility': 'questions.option.toneTech',
  'tone:Luxury / refined': 'questions.option.toneLuxury',
  'tone:Brutalist / experimental': 'questions.option.toneBrutalist',
  'tone:Human / approachable': 'questions.option.toneHuman',
  'brand:pick_direction': 'questions.option.pickDirection',
  'brand:brand_spec': 'questions.option.brandSpec',
  'brand:reference_match': 'questions.option.referenceMatch',
  'fidelity:wireframe': 'newproj.fidelityWireframe',
  'fidelity:high-fidelity': 'newproj.fidelityHigh',
  'platformTargets:responsive': 'newproj.platform.responsive.label',
  'platformTargets:web-desktop': 'newproj.platform.webDesktop.label',
  'platformTargets:mobile-ios': 'newproj.platform.mobileIos.label',
  'platformTargets:mobile-android': 'newproj.platform.mobileAndroid.label',
  'platformTargets:tablet': 'newproj.platform.tablet.label',
  'platformTargets:desktop-app': 'newproj.platform.desktopApp.label',
  'companionSurfaces:landing': 'newproj.includeLandingPage',
  'companionSurfaces:os-widgets': 'newproj.includeOsWidgets',
  'speakerNotes:yes': 'questions.option.included',
  'speakerNotes:no': 'questions.option.notIncluded',
  'animations:yes': 'questions.option.included',
  'animations:no': 'questions.option.notIncluded',
};

function translatedOptionLabel(id: string, value: string, fallback: string, t: Translate): string {
  const key = OPTION_LABEL_KEYS[`${id}:${value}`] ?? OPTION_LABEL_KEYS[`${id}:${fallback}`];
  return key ? t(key) : fallback;
}

/**
 * Project brief payloads remain language-neutral and stable by id. This view
 * projection deliberately ignores old persisted English labels for known ids,
 * so projects created before localization render in the active locale too.
 */
export function localizeBriefAssumption(assumption: BriefAssumption, t: Translate): BriefAssumption {
  const labelKey = FIELD_LABEL_KEYS[assumption.id];
  const sourceQuestion = questionForAssumption(assumption);
  const questionLabelKey = QUESTION_LABEL_KEYS[assumption.id];
  const placeholderKey = PLACEHOLDER_KEYS[assumption.id];
  const question: FormQuestion = {
    ...sourceQuestion,
    label: questionLabelKey ? t(questionLabelKey) : sourceQuestion.label,
    ...(sourceQuestion.placeholder && placeholderKey
      ? { placeholder: t(placeholderKey) }
      : {}),
    ...(sourceQuestion.options
      ? {
          options: sourceQuestion.options.map((option) => ({
            ...option,
            label: translatedOptionLabel(assumption.id, option.value, option.label, t),
          })),
        }
      : {}),
  };
  const values = Array.isArray(assumption.value) ? assumption.value : [assumption.value];
  const translatedValues = values.map((value) =>
    translatedOptionLabel(assumption.id, value, value, t),
  );
  const emptyCompanionSurfaces = assumption.id === 'companionSurfaces' && values.length === 0;
  const hasTranslatedValue = translatedValues.some((value, index) => value !== values[index]);
  return {
    ...assumption,
    label: labelKey ? t(labelKey) : assumption.label,
    question,
    ...(emptyCompanionSurfaces
      ? { displayValue: t('common.none') }
      : hasTranslatedValue
        ? { displayValue: translatedValues.join(', ') }
        : {}),
  };
}

/** Stable field ids, never localized labels, connect ordinary answers to Questions. */
export function briefAssumptionsFromAnswers(
  form: QuestionForm,
  answers: Record<string, string | string[]>,
): BriefAssumption[] {
  return form.questions.flatMap(question => {
    const value = answers[question.id];
    if (!FIELD_LABEL_KEYS[question.id] || value === undefined
      || (Array.isArray(value) ? value.length === 0 : value.trim().length === 0)) return [];
    return [{ id: question.id, label: question.id, value, provenance: 'stated' as const, question }];
  });
}

export function formatBriefSteering(
  assumption: BriefAssumption,
  value: AssumptionValue,
): string {
  const form: QuestionForm = {
    id: assumption.id,
    title: assumption.label,
    questions: [questionForAssumption(assumption)],
  };
  return formatFormAnswers(form, { [assumption.id]: value })
    .replace(`[form answers — ${assumption.id}]`, `[brief correction — ${assumption.id}]`);
}

export function readProjectBrief(metadata: ProjectMetadata | undefined): ProjectBrief | null {
  const candidate = (metadata as BriefProjectMetadata | undefined)?.brief;
  if (!candidate || !Array.isArray(candidate.assumptions) || typeof candidate.updatedAt !== 'number') return null;
  return candidate;
}

function normalizeKnownAssumptionForStorage(assumption: BriefAssumption): BriefAssumption {
  if (!FIELD_LABEL_KEYS[assumption.id]) return assumption;
  const question = assumption.question
    ? {
        ...assumption.question,
        label: assumption.question.id,
        placeholder: undefined,
        options: assumption.question.options?.map((option) => ({
          ...option,
          label: option.value,
        })),
      }
    : undefined;
  return {
    ...assumption,
    label: assumption.id,
    displayValue: undefined,
    question,
  };
}

export function mergeBriefAssumptions(
  current: ProjectBrief | null,
  incoming: BriefAssumption[],
  updatedAt = Date.now(),
): ProjectBrief {
  const byId = new Map(current?.assumptions.map(item => [item.id, item]) ?? []);
  for (const item of incoming) {
    byId.set(item.id, normalizeKnownAssumptionForStorage(item));
  }
  return { assumptions: [...byId.values()], updatedAt };
}

export async function persistProjectBrief(
  projectId: string,
  metadata: ProjectMetadata,
  brief: ProjectBrief,
): Promise<boolean> {
  const nextMetadata: BriefProjectMetadata = { ...metadata, brief };
  return (await patchProject(projectId, { metadata: nextMetadata })) !== null;
}
