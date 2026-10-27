import type { SkillDetail, SkillSummary } from '@readable-studio/contracts';

interface TurnSkillPromptOptions {
  skillIds: readonly string[];
  projectSkillId?: string | null;
  skills: readonly SkillSummary[];
  designTemplates: readonly SkillSummary[];
  cache: Map<string, { body: string; isTemplate: boolean }>;
  fetchSkill(id: string): Promise<SkillDetail | null>;
  fetchTemplate(id: string): Promise<SkillDetail | null>;
}

/** Functional instructions and template reference content never share a block. */
export async function resolveTurnSkillPrompt(options: TurnSkillPromptOptions): Promise<{
  additionalSkillBody?: string;
  templateReferences?: Array<{ name?: string; body: string }>;
}> {
  const functional: string[] = [];
  const templates: Array<{ name?: string; body: string }> = [];
  const ids = [...new Set(options.skillIds)].filter(id => id && id !== options.projectSkillId);
  for (const id of ids) {
    const summary = options.skills.find(item => item.id === id) ?? options.designTemplates.find(item => item.id === id);
    const cached = options.cache.get(id);
    let body = cached?.body;
    let isTemplate = cached?.isTemplate ?? false;
    if (body === undefined) {
      const skill = await options.fetchSkill(id);
      const template = skill ? null : await options.fetchTemplate(id);
      const detail = skill ?? template;
      if (!detail?.body) continue;
      isTemplate = Boolean(template);
      body = detail.body;
      options.cache.set(id, { body, isTemplate });
    }
    if (!body.trim()) continue;
    if (isTemplate) templates.push({ name: summary?.name ?? id, body });
    else functional.push(`## ${summary?.name ?? id}\n\n${body}`);
  }
  return {
    ...(functional.length ? { additionalSkillBody: functional.join('\n\n') } : {}),
    ...(templates.length ? { templateReferences: templates } : {}),
  };
}
