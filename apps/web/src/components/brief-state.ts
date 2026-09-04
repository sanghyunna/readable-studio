import type { ProjectMetadata } from '../types';
import type { Dict } from '../i18n/types';
import { patchProject } from '../state/projects';
import type { FormQuestion, QuestionForm } from '../artifacts/question-form';
import { formatFormAnswers } from '../artifacts/question-form';

export type AssumptionProvenance = 'stated' | 'inferred' | 'default';
export type AssumptionValue = string | string[];

export interface BriefAssumption {
  id: string;
  label: string;
  value: AssumptionValue;
  displayValue?: string;
  provenance: AssumptionProvenance;
  question?: FormQuestion;
}

export interface ProjectBrief {
  assumptions: BriefAssumption[];
  updatedAt: number;
}

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
  output: 'brief.field.output',
  platform: 'brief.field.platform',
  audience: 'brief.field.audience',
  tone: 'brief.field.tone',
  brand: 'brief.field.brand',
  scale: 'brief.field.scale',
  language: 'brief.field.language',
  constraints: 'brief.field.constraints',
  fidelity: 'brief.field.fidelity',
  platformTargets: 'brief.field.platformTargets',
  companionSurfaces: 'brief.field.companionSurfaces',
  speakerNotes: 'brief.field.speakerNotes',
  animations: 'brief.field.animations',
};

const QUESTION_LABEL_KEYS: Partial<Record<string, keyof Dict>> = {
  output: 'brief.question.output',
  platform: 'brief.question.platform',
  audience: 'brief.question.audience',
  tone: 'brief.question.tone',
  brand: 'brief.question.brand',
  scale: 'brief.question.scale',
  language: 'brief.question.language',
  constraints: 'brief.question.constraints',
  fidelity: 'newproj.fidelityLabel',
  platformTargets: 'newproj.targetPlatformsLabel',
  companionSurfaces: 'brief.field.companionSurfaces',
  speakerNotes: 'newproj.toggleSpeakerNotes',
  animations: 'newproj.toggleAnimations',
};

const PLACEHOLDER_KEYS: Partial<Record<string, keyof Dict>> = {
  audience: 'brief.placeholder.audience',
  scale: 'brief.placeholder.scale',
  constraints: 'brief.placeholder.constraints',
};

const OPTION_LABEL_KEYS: Partial<Record<string, keyof Dict>> = {
  'output:Slide deck / pitch': 'brief.option.slideDeck',
  'output:Single web prototype / landing': 'brief.option.singlePrototype',
  'output:Multi-screen app prototype': 'brief.option.multiPrototype',
  'output:Dashboard / tool UI': 'brief.option.dashboard',
  'output:Editorial / marketing page': 'brief.option.editorial',
  'output:Other': 'brief.option.other',
  'platform:Responsive web': 'newproj.platform.responsive.label',
  'platform:Desktop web': 'newproj.platform.webDesktop.label',
  'platform:iOS app': 'newproj.platform.mobileIos.label',
  'platform:Android app': 'newproj.platform.mobileAndroid.label',
  'platform:Tablet app': 'newproj.platform.tablet.label',
  'platform:Desktop app': 'newproj.platform.desktopApp.label',
  'platform:Fixed canvas (1920×1080)': 'brief.option.fixedCanvas',
  'tone:Editorial / magazine': 'brief.option.toneEditorial',
  'tone:Modern minimal': 'brief.option.toneMinimal',
  'tone:Playful / illustrative': 'brief.option.tonePlayful',
  'tone:Tech / utility': 'brief.option.toneTech',
  'tone:Luxury / refined': 'brief.option.toneLuxury',
  'tone:Brutalist / experimental': 'brief.option.toneBrutalist',
  'tone:Human / approachable': 'brief.option.toneHuman',
  'brand:pick_direction': 'brief.option.pickDirection',
  'brand:brand_spec': 'brief.option.brandSpec',
  'brand:reference_match': 'brief.option.referenceMatch',
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
  'speakerNotes:yes': 'brief.option.included',
  'speakerNotes:no': 'brief.option.notIncluded',
  'animations:yes': 'brief.option.included',
  'animations:no': 'brief.option.notIncluded',
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
