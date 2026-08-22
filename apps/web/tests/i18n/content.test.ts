import { describe, expect, it } from 'vitest';
import type { DesignSystemSummary, SkillSummary } from '../../src/types';
import {
  KOREAN_CONTENT_IDS,
  localizeDesignSystemSummary,
  localizeSkillDescription,
  localizeSkillName,
  localizeSkillPrompt,
  hasLocalizedContent,
} from '../../src/i18n/content';
import {
  KO_DESIGN_SYSTEM_SUMMARIES,
  KO_SKILL_COPY,
} from '../../src/i18n/content.ko';
import { LOCALES } from '../../src/i18n/types';

function requireDefined<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

describe('localized resource content', () => {
  it('derives localized ids only from localized dictionaries', () => {
    expect(KOREAN_CONTENT_IDS.skills).toContain('brandkit');
    expect(KOREAN_CONTENT_IDS.skills).not.toContain('nonexistent-skill');
    expect(KOREAN_CONTENT_IDS.designSystems).toContain('airbnb');
    expect(KOREAN_CONTENT_IDS.designSystems).not.toContain('nonexistent-system');
  });

  it('prefers localized skill copy and falls back to english field-by-field', () => {
    const localizedSkill = {
      id: 'brandkit',
      examplePrompt: '  English prompt from source.  ',
      description: '  English description from source.  ',
    } as unknown as SkillSummary;
    const brandkitCopy = requireDefined(KO_SKILL_COPY.brandkit);

    expect(localizeSkillPrompt('ko', localizedSkill)).toBe(
      brandkitCopy.examplePrompt,
    );
    expect(localizeSkillDescription('ko', localizedSkill)).toBe(
      brandkitCopy.description,
    );

    const englishOnlySkill = {
      id: 'english-only-skill',
      examplePrompt: '  English prompt from source.  ',
      description: '  English description from source.  ',
    } as unknown as SkillSummary;

    expect(localizeSkillPrompt('ko', englishOnlySkill)).toBe('English prompt from source.');
    expect(localizeSkillDescription('ko', englishOnlySkill)).toBe('English description from source.');
  });

  it('uses inline skill display metadata before falling back to source fields', () => {
    const inlineSkill = {
      id: 'inline-skill',
      name: 'inline-skill',
      displayName: {
        en: 'Inline Skill',
        ko: 'Inline Skill KO',
      },
      description: ' English description from source. ',
      descriptionI18n: {
        en: 'English inline description.',
        ko: 'Korean inline description.',
      },
      examplePrompt: ' English prompt from source. ',
      examplePromptI18n: {
        en: 'English inline prompt.',
        ko: 'Korean inline prompt.',
      },
    } as unknown as SkillSummary;

    expect(localizeSkillName('ko', inlineSkill)).toBe('Inline Skill KO');
    expect(localizeSkillName('en', inlineSkill)).toBe('Inline Skill');
    expect(localizeSkillDescription('ko', inlineSkill)).toBe('Korean inline description.');
    expect(localizeSkillDescription('en', inlineSkill)).toBe('English inline description.');
    expect(localizeSkillPrompt('ko', inlineSkill)).toBe('Korean inline prompt.');
    expect(localizeSkillPrompt('en', inlineSkill)).toBe('English inline prompt.');
  });

  it('prefers localized design system summaries and falls back to english when missing', () => {
    const localizedSystem = {
      id: 'agentic',
      summary: ' English summary from source. ',
      category: 'English category',
    } as DesignSystemSummary;

    expect(localizeDesignSystemSummary('ko', localizedSystem)).toBe(
      KO_DESIGN_SYSTEM_SUMMARIES.agentic,
    );

    const englishOnlySystem = {
      id: 'english-only-system',
      summary: ' English summary from source. ',
      category: 'English category',
    } as DesignSystemSummary;

    expect(localizeDesignSystemSummary('ko', englishOnlySystem)).toBe(' English summary from source. ');
  });

  // Coverage lock: every supported non-English locale must resolve a
  // built-in-content bundle registered in LOCALIZED_CONTENT. When a locale has
  // no bundle, built-in copy silently renders English. This test locks every
  // non-English locale to a resolvable bundle so a future locale addition
  // cannot regress.
  it('resolves a built-in-content bundle for every supported non-English locale', () => {
    const missing = LOCALES.filter(
      (locale) => locale !== 'en' && !hasLocalizedContent(locale),
    );
    expect(
      missing,
      `These locales have no built-in-content bundle: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
