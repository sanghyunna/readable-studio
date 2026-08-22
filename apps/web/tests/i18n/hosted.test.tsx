// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOSTED_LOCALES,
  HOSTED_MESSAGE_KEYS,
  HOSTED_MESSAGES,
  HOSTED_RUN_KEYS,
  HostedI18nProvider,
  hostedDirection,
  resolveHostedLocale,
  translateHosted,
  useHostedT,
} from '../../src/i18n/hosted';
import { LOCALES } from '../../src/i18n/types';

function TranslationProbe() {
  return <p>{useHostedT()('hosted.provider.title')}</p>;
}

describe('hosted-only i18n', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    document.documentElement.setAttribute('lang', 'en');
    document.documentElement.setAttribute('dir', 'ltr');
  });

  it('keeps the local app catalogue limited to its complete locales', () => {
    expect(LOCALES).toEqual(['en', 'ko']);
  });

  it('ships every hosted message in all 18 hosted locales', () => {
    expect(HOSTED_LOCALES).toEqual([
      'ar', 'de', 'en', 'es-ES', 'fa', 'fr', 'hu', 'id', 'ja', 'ko', 'pl',
      'pt-BR', 'ru', 'th', 'tr', 'uk', 'zh-CN', 'zh-TW',
    ]);
    for (const locale of HOSTED_LOCALES) {
      expect(Object.keys(HOSTED_MESSAGES[locale]).sort()).toEqual(
        [...HOSTED_MESSAGE_KEYS].sort(),
      );
      for (const key of HOSTED_MESSAGE_KEYS) {
        expect(translateHosted(locale, key).trim(), `${locale}.${key}`).not.toBe('');
      }
    }
  });

  it('resolves canonical product identity without copied English run fallbacks', () => {
    for (const locale of HOSTED_LOCALES) {
      expect(
        translateHosted(locale, 'hosted.provider.eyebrow'),
        `${locale}.hosted.provider.eyebrow`,
      ).toContain('Readable Studio');
      if (locale === 'en') continue;
      const copiedFallbacks = HOSTED_RUN_KEYS.filter(
        (key) => translateHosted(locale, key) === translateHosted('en', key),
      ).filter((key) => !(locale === 'fr' && key === 'hosted.run.conversation'));
      expect(copiedFallbacks, `${locale} copied hosted run fallbacks`).toEqual([]);
    }
  });

  it('uses formal German provider copy', () => {
    expect(translateHosted('de', 'hosted.provider.description')).toContain('Ihr Schlüssel');
    expect(translateHosted('de', 'hosted.provider.error')).toContain('Versuchen Sie');
  });

  it('interpolates hosted content labels', () => {
    expect(translateHosted('ko', 'hosted.content.previewTitle', { path: 'index.html' }))
      .toBe('index.html 미리보기');
  });

  it('resolves hosted browser locales without consulting local app persistence', () => {
    expect(resolveHostedLocale(['fa-IR', 'en-US'])).toBe('fa');
    expect(resolveHostedLocale(['pt-PT'])).toBe('pt-BR');
    expect(resolveHostedLocale(['nl-NL'])).toBe('en');
    expect(hostedDirection('ar')).toBe('rtl');
    expect(hostedDirection('fa')).toBe('rtl');
    expect(hostedDirection('de')).toBe('ltr');
  });

  it('owns hosted document language and direction independently', async () => {
    const storageRead = vi.spyOn(Storage.prototype, 'getItem');
    render(
      <HostedI18nProvider initial="ar">
        <TranslationProbe />
      </HostedI18nProvider>,
    );

    expect(await screen.findByText(translateHosted('ar', 'hosted.provider.title'))).toBeTruthy();
    expect(document.documentElement.getAttribute('lang')).toBe('ar');
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    expect(storageRead).not.toHaveBeenCalled();
    storageRead.mockRestore();
  });
});
