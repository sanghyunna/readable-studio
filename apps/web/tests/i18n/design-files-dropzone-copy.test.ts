import { describe, expect, it } from 'vitest';

import { en } from '../../src/i18n/locales/en';
import { ko } from '../../src/i18n/locales/ko';

const LOCALE_DICTS = {
  en,
  ko,
};

describe('Design Files dropzone copy', () => {
  it('does not advertise unsupported Figma link drops', () => {
    for (const [locale, dict] of Object.entries(LOCALE_DICTS)) {
      expect(dict['designFiles.dropDesc'], locale).not.toMatch(/figma/i);
    }
  });
});
