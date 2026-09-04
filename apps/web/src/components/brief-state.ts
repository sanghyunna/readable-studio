import type { ProjectMetadata } from '../types';
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

export function mergeBriefAssumptions(
  current: ProjectBrief | null,
  incoming: BriefAssumption[],
  updatedAt = Date.now(),
): ProjectBrief {
  const byId = new Map(current?.assumptions.map(item => [item.id, item]) ?? []);
  for (const item of incoming) byId.set(item.id, item);
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
