import type { ProjectMetadata } from '../types';
import { patchProject } from '../state/projects';
import type { FormQuestion, QuestionForm } from '../artifacts/question-form';
import { formatFormAnswers } from '../artifacts/question-form';

export type AssumptionProvenance = 'stated' | 'inferred' | 'default';
export type AssumptionValue = string | string[];

// Keep the storage/protocol names compatible while Questions owns the capability.
export type { QuestionAssumption as BriefAssumption, ProjectQuestions as ProjectBrief } from '@readable-studio/contracts';
import type { QuestionAssumption as BriefAssumption, ProjectQuestions as ProjectBrief } from '@readable-studio/contracts';

export type BriefProjectMetadata = ProjectMetadata & { brief?: ProjectBrief };

// A receipt without an editor schema can still correct its existing value.
// Never supply domain-specific questions or options the model did not emit.
export function questionForAssumption(assumption: BriefAssumption): FormQuestion {
  return assumption.question ?? {
    id: assumption.id,
    label: assumption.label,
    type: Array.isArray(assumption.value) ? 'checkbox' : 'text',
    ...(Array.isArray(assumption.value)
      ? { options: assumption.value.map(value => ({ label: value, value })) }
      : {}),
  };
}

/** Every model-authored question id participates in persistent prompt context. */
export function briefAssumptionsFromAnswers(
  form: QuestionForm,
  answers: Record<string, string | string[]>,
): BriefAssumption[] {
  return form.questions.flatMap(question => {
    const value = answers[question.id];
    if (value === undefined
      || (Array.isArray(value) ? value.length === 0 : value.trim().length === 0)) return [];
    return [{ id: question.id, label: question.label, value, provenance: 'stated' as const, question }];
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
