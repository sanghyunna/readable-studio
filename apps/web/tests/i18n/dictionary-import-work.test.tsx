// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { ModuleKind, transpileModule } from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Dict, Locale } from '../../src/i18n/types';

// Observe evaluation of the real dictionary literal, not calls to a mocked loader.
// The wrapper leaves the literal's contents and its evaluation position unchanged.
function observeDictionary(locale: Locale) {
  const source = readFileSync(resolve('src/i18n/locales', `${locale}.ts`), 'utf8');
  const observe = vi.fn((dict: Dict) => dict);
  const instrumented = source.replace(/(= )(\{[\s\S]*\})(;)/, '$1observe($2)$3');
  const exports: {
    en?: Dict;
    ko?: Dict;
    getEn?: () => Dict;
    getKo?: () => Dict;
  } = {};
  const { outputText } = transpileModule(instrumented, { compilerOptions: { module: ModuleKind.CommonJS } });
  runInNewContext(outputText, { exports, observe });
  return { exports, observe };
}

beforeEach(() => {
  vi.resetModules();
  vi.doMock('react', () => React);
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.doUnmock('../../src/i18n/locales/en');
  vi.doUnmock('../../src/i18n/locales/ko');
  vi.doUnmock('react');
  window.localStorage.clear();
});

it.each(['en', 'ko'] as const)('materialises only %s on first render, then the other dictionary on switch', async (initial) => {
  // Given fresh real locale modules with literal-evaluation observers.
  const english = observeDictionary('en');
  const korean = observeDictionary('ko');
  vi.doMock('../../src/i18n/locales/en', () => english.exports);
  vi.doMock('../../src/i18n/locales/ko', () => korean.exports);
  const { I18nProvider, useI18n } = await import('../../src/i18n');
  // Importing the sibling consumer must not bypass the same lazy boundary.
  await import('../../src/i18n/hosted');
  expect(english.observe).not.toHaveBeenCalled();
  expect(korean.observe).not.toHaveBeenCalled();
  const modules = { en: english, ko: korean };
  const next = initial === 'en' ? 'ko' : 'en';
  function Probe() {
    const { locale, setLocale, t } = useI18n();
    return <button onClick={() => setLocale(next)} data-locale={locale}>{t('common.save')}</button>;
  }
  render(<I18nProvider initial={initial}><Probe /></I18nProvider>);
  expect(modules[initial].observe).toHaveBeenCalledTimes(1);
  expect(modules[next].observe).not.toHaveBeenCalled();
  expect(screen.getByRole('button').textContent).toBe(modules[initial].observe.mock.results[0]?.value['common.save']);

  // When the provider receives a language switch through a synchronous UI event.
  fireEvent.click(screen.getByRole('button'));

  // Then the new copy is ready in that render, with one allocation per locale.
  expect(screen.getByRole('button').getAttribute('data-locale')).toBe(next);
  expect(screen.getByRole('button').textContent).toBe(modules[next].observe.mock.results[0]?.value['common.save']);
  expect(english.observe).toHaveBeenCalledTimes(1);
  expect(korean.observe).toHaveBeenCalledTimes(1);
});

it('reuses the materialised dictionary when requested repeatedly', async () => {
  // Given a fresh English dictionary module.
  const { getEn } = await import('../../src/i18n/locales/en');
  const first = getEn();
  // When another consumer requests English.
  const second = getEn();
  // Then callers share the same object rather than reallocating the table.
  expect(second).toBe(first);
});
