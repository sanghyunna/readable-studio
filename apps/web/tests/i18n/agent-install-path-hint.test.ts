import { describe, expect, it } from 'vitest';
import { getEn } from '../../src/i18n/locales/en';
import { getKo } from '../../src/i18n/locales/ko';

const KEY = 'settings.agentInstall.pathHint' as const;
const NON_WINDOWS = /Homebrew|macOS|brew |Terminal|QUICKSTART\.md/;
const BARE_WHERE = /\bwhere (?!\.exe)/;

describe('settings.agentInstall.pathHint', () => {
  it('is Windows-appropriate in every locale', () => {
    for (const dict of [getEn(), getKo()]) {
      const value = dict[KEY];
      expect(typeof value).toBe('string');
      expect(value).not.toMatch(NON_WINDOWS);
      expect(value).toMatch(/npm/);
      expect(value).toContain('npm.cmd install -g');
      expect(value).not.toMatch(/\bnpm install\b/);
      expect(value).toContain('where.exe');
      expect(value).not.toMatch(BARE_WHERE);
    }
  });

  it('leaves no untranslated English labels in Korean', () => {
    expect(getKo()[KEY]).not.toMatch(/daemon|\bbin\b|Local agent CLI and PATH/);
  });
});
