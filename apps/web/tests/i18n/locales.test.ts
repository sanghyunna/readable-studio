import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveSystemLocale } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';
import { ko } from '../../src/i18n/locales/ko';
import { LOCALES, LOCALE_LABEL, type Dict, type Locale } from '../../src/i18n/types';

const EXPECTED_LOCALES = ['en', 'ko'];
const RETIRED_KEYS = [
  'settings.installLatest',
  'settings.alreadyLatest',
  'entry.helpWhatsNew',
  'entry.helpDownloadDesktop',
  'socialShare.openDesignSection',
  'socialShare.openDesignTitle',
  'socialShare.openDesignText',
  'socialShare.openDesignCopyText',
  'assistant.shareToOpenDesign',
] as const;

function placeholders(value: string): string[] {
  const names: string[] = [];
  for (const match of value.matchAll(/\{(\w+)\}/g)) {
    if (match[1]) {
      names.push(match[1]);
    }
  }
  return names.sort();
}

async function loadDict(locale: Locale): Promise<Dict> {
  const module = await import(`../../src/i18n/locales/${locale}.ts`);
  const dict = Object.values(module).find((value): value is Dict => {
    return Boolean(value) && typeof value === 'object';
  });
  if (!dict) {
    throw new Error(`No dictionary export found for locale ${locale}`);
  }
  return dict;
}

function explicitLocaleKeys(locale: Locale): string[] {
  const source = readFileSync(new URL(`../../src/i18n/locales/${locale}.ts`, import.meta.url), 'utf8');
  return Array.from(source.matchAll(/'([^']+)':/g), (match) => match[1] ?? '').filter(Boolean);
}

describe('i18n locales', () => {
  it('resolves the initial locale from browser language preferences', () => {
    expect(resolveSystemLocale(['ko-KR', 'en-US'])).toBe('ko');
    expect(resolveSystemLocale(['en-US', 'ko-KR'])).toBe('en');
    expect(resolveSystemLocale(['nl-NL', 'en-US'])).toBe('en');
    expect(resolveSystemLocale(['nl-NL'])).toBeNull();
  });

  it('registers every supported locale in the language menu', () => {
    expect(LOCALES).toEqual(EXPECTED_LOCALES);
    expect((LOCALE_LABEL as Record<string, string>).en).toBe('English');
    expect((LOCALE_LABEL as Record<string, string>).ko).toBe('한국어');
  });

  it('keeps canonical product identity and retired keys out of every complete dictionary', async () => {
    for (const locale of LOCALES) {
      const dict = await loadDict(locale);
      expect(dict['app.brand'], `${locale}.app.brand`).toBe('Readable Studio');
      expect(explicitLocaleKeys(locale)).not.toEqual(expect.arrayContaining([...RETIRED_KEYS]));
    }
  });

  it('keeps locale dictionaries aligned with English keys and placeholders', async () => {
    const englishKeys = Object.keys(en).sort();

    for (const locale of LOCALES) {
      const dict = await loadDict(locale);
      expect(Object.keys(dict).sort()).toEqual(englishKeys);

      for (const key of englishKeys) {
        const dictKey = key as keyof Dict;
        expect(placeholders(dict[dictKey]), `${locale}.${key}`).toEqual(
          placeholders(en[dictKey]),
        );
      }
    }
  });

  // Brand / proper-noun lock: these labels are product or technical proper
  // nouns and must stay verbatim English in EVERY locale, never translated.
  it('keeps brand/proper-noun labels verbatim English across every locale', async () => {
    const verbatim: Array<{ key: keyof Dict; value: string }> = [
      { key: 'plugins.availableDetails.integrity', value: 'Integrity' },
    ];
    for (const locale of LOCALES) {
      const dict = await loadDict(locale);
      for (const { key, value } of verbatim) {
        expect(dict[key], `${locale}.${String(key)}`).toBe(value);
      }
    }
  });
});
