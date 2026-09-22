import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveSystemLocale } from '../../src/i18n';
import { getEn } from '../../src/i18n/locales/en';
import { getKo } from '../../src/i18n/locales/ko';
const en = getEn();
const ko = getKo();
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
  'settings.codeAgentDefault',
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

function loadDict(locale: Locale): Dict {
  return { en: getEn, ko: getKo }[locale]();
}

function explicitLocaleKeys(locale: Locale): string[] {
  const source = readFileSync(new URL(`../../src/i18n/locales/${locale}.ts`, import.meta.url), 'utf8');
  return Array.from(source.matchAll(/'([^']+)':/g), (match) => match[1] ?? '').filter(Boolean);
}

describe('i18n locales', () => {
  it('keeps personal-name fallbacks out of shipped product UI copy', () => {
    // Given: every shipped product UI locale source.
    const shippedCopy = [...Object.values(en), ...Object.values(ko)].join(' ');

    // When: local identity is unavailable.

    // Then: no historical personal-name fallback can ship.
    expect(shippedCopy).not.toContain('Sanghyeon');
    expect(shippedCopy).not.toContain('상현');
  });

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
      const localeKeys = explicitLocaleKeys(locale);
      for (const retiredKey of RETIRED_KEYS) {
        expect(localeKeys, `${locale}.${retiredKey}`).not.toContain(retiredKey);
      }
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
