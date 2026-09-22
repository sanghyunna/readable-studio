import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

describe('localized content index initialization', () => {
  it('does not enumerate catalogues when importing localization helpers', async () => {
    // Given real catalogues and a call-through observer of enumeration.
    const catalogues = await import('../../src/i18n/content.ko');
    const keys = vi.spyOn(Object, 'keys');
    // When loading the helper module without requesting its coverage indexes.
    await import('../../src/i18n/content');
    // Then no catalogue was enumerated during evaluation.
    for (const catalogue of Object.values(catalogues)) {
      expect(keys).not.toHaveBeenCalledWith(catalogue);
    }
  });

  it.each([
    ['skills', 'KO_SKILL_COPY'],
    ['designSystems', 'KO_DESIGN_SYSTEM_SUMMARIES'],
    ['designSystemCategories', 'KO_DESIGN_SYSTEM_CATEGORIES'],
  ] as const)('initializes only %s when that index is first read', async (field, catalogue) => {
    // Given an imported module whose indexes have not been consumed.
    const catalogues = await import('../../src/i18n/content.ko');
    const expected = Object.keys(catalogues[catalogue]);
    const { KOREAN_CONTENT_IDS } = await import('../../src/i18n/content');
    const catalogueValues = Object.values(catalogues);
    const keys = vi.spyOn(Object, 'keys');
    // When reading one public index.
    const ids = KOREAN_CONTENT_IDS[field];
    const enumerations = keys.mock.calls.filter(([value]) => catalogueValues.some((item) => item === value));
    // Then the same catalogue keys are produced by exactly one enumeration.
    expect(ids).toEqual(expected);
    expect(enumerations).toEqual([[catalogues[catalogue]]]);
  });

  it.each(['skills', 'designSystems', 'designSystemCategories'] as const)('preserves assignment when a caller replaces %s', async (field) => {
    // Given the existing writable index surface and a caller-owned replacement.
    const { KOREAN_CONTENT_IDS } = await import('../../src/i18n/content');
    const replacement = ['caller-defined-id'];
    // When replacing an index before its first read.
    KOREAN_CONTENT_IDS[field] = replacement;
    // Then the same assigned array remains visible to subsequent readers.
    expect(KOREAN_CONTENT_IDS[field]).toBe(replacement);
  });

  it('reuses the index array when a caller reads it again', async () => {
    // Given a previously consumed public index.
    const { KOREAN_CONTENT_IDS } = await import('../../src/i18n/content');
    const first = KOREAN_CONTENT_IDS.skills;
    const keys = vi.spyOn(Object, 'keys');
    // When another caller requests the same index.
    const second = KOREAN_CONTENT_IDS.skills;
    // Then identity is retained without another enumeration.
    expect(second).toBe(first);
    expect(keys).not.toHaveBeenCalled();
  });
});
