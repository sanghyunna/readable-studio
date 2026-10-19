import { expect, it } from 'vitest';
import { sortHubTemplateItemsByFavorite, userTemplateTab } from '../../../src/components/home-hero/templateCarousel';

it('orders favorites, then newest uploaded templates, then built-ins', () => {
  const builtin = { record: { id: 'builtin' } };
  const old = { record: { id: 'old' }, userTemplate: { name: 'Old template', importedAt: '2026-01-01' } };
  const recent = { record: { id: 'new' }, userTemplate: { name: 'New template', importedAt: '2026-10-19' } };
  expect(sortHubTemplateItemsByFavorite([builtin, old, recent], []).map((item) => item.record.id))
    .toEqual(['new', 'old', 'builtin']);
  expect(sortHubTemplateItemsByFavorite([builtin, old, recent], ['builtin']).map((item) => item.record.id))
    .toEqual(['builtin', 'new', 'old']);
});
it('maps imported template types onto the existing Hub tabs', () => {
  expect(userTemplateTab({ templateType: 'website' })).toBe('prototype');
  expect(userTemplateTab({ templateType: 'report' })).toBe('report');
  expect(userTemplateTab({})).toBe('deck');
});
