import { describe, expect, it } from 'vitest';

import { getEn } from '../../src/i18n/locales/en';
import { getKo } from '../../src/i18n/locales/ko';
const en = getEn();
const ko = getKo();

const LOCALE_DICTS = {
  en,
  ko,
};

describe('Design Files agent copy', () => {
  it('uses neutral agent wording in shared helper text', () => {
    for (const [locale, dict] of Object.entries(LOCALE_DICTS)) {
      expect(dict['designFiles.dropDesc'], locale).not.toMatch(/claude/i);
    }
  });
});
