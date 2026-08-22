import type {
  DesignSystemSummary,
  SkillSummary,
} from '../types';
import type { Locale } from './types';
import {
  KO_DESIGN_SYSTEM_CATEGORIES,
  KO_DESIGN_SYSTEM_SUMMARIES,
  KO_SKILL_COPY,
} from './content.ko';

type LocalizedSkillCopy = { description?: string; examplePrompt?: string };
type LocalizedContentIds = {
  skills: string[];
  designSystems: string[];
  designSystemCategories: string[];
};
type LocalizedContentBundle = {
  skillCopy: Record<string, LocalizedSkillCopy>;
  designSystemSummaries: Record<string, string>;
  designSystemCategories: Record<string, string>;
};

const LOCALIZED_CONTENT: Partial<Record<Locale, LocalizedContentBundle>> = {
  ko: {
    skillCopy: KO_SKILL_COPY,
    designSystemSummaries: KO_DESIGN_SYSTEM_SUMMARIES,
    designSystemCategories: KO_DESIGN_SYSTEM_CATEGORIES,
  },
};

// True when a locale resolves a built-in-content bundle. When false,
// built-in skill / design-system copy renders in English for that locale.
export function hasLocalizedContent(locale: Locale): boolean {
  return getLocalizedContent(locale) !== undefined;
}

function getLocalizedContent(locale: Locale): LocalizedContentBundle | undefined {
  return LOCALIZED_CONTENT[locale];
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function localizedRecordValue(
  locale: Locale,
  values: Record<string, string> | undefined,
  options: { includeEnglishFallback?: boolean } = {},
): string | undefined {
  if (!values) return undefined;
  if (values[locale]) return values[locale];
  if (options.includeEnglishFallback !== false && values.en) return values.en;
  return undefined;
}

export function localizeSkillName(locale: Locale, skill: SkillSummary): string {
  return localizedRecordValue(locale, skill.displayName) ?? skill.name;
}

export function localizeSkillPrompt(locale: Locale, skill: SkillSummary): string | undefined {
  const inline = localizedRecordValue(locale, skill.examplePromptI18n, {
    includeEnglishFallback: false,
  });
  if (inline) return inline;
  const translated = getLocalizedContent(locale)?.skillCopy[skill.id]?.examplePrompt;
  if (translated) return translated;
  const fallback = localizedRecordValue(locale, skill.examplePromptI18n);
  if (fallback) return fallback;
  return skill.examplePrompt ? normalizeText(skill.examplePrompt) : undefined;
}

export function localizeSkillDescription(locale: Locale, skill: SkillSummary): string {
  const inline = localizedRecordValue(locale, skill.descriptionI18n, {
    includeEnglishFallback: false,
  });
  if (inline) return inline;
  const translated = getLocalizedContent(locale)?.skillCopy[skill.id]?.description;
  if (translated) return translated;
  const fallback = localizedRecordValue(locale, skill.descriptionI18n);
  if (fallback) return fallback;
  return normalizeText(skill.description);
}

export function localizeDesignSystemSummary(
  locale: Locale,
  system: DesignSystemSummary,
): string {
  const translated = getLocalizedContent(locale)?.designSystemSummaries[system.id];
  if (translated) return translated;
  return system.summary || system.category || '';
}

export function localizeDesignSystemCategory(locale: Locale, category: string): string {
  return getLocalizedContent(locale)?.designSystemCategories[category] ?? category;
}

function buildLocalizedContentIds(content: LocalizedContentBundle): LocalizedContentIds {
  return {
    skills: Object.keys(content.skillCopy),
    designSystems: Object.keys(content.designSystemSummaries),
    designSystemCategories: Object.keys(content.designSystemCategories),
  };
}

export const KOREAN_CONTENT_IDS = buildLocalizedContentIds(LOCALIZED_CONTENT.ko!);
