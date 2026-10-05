// Hub template carousel card titles come from the bundled manifests'
// `title_i18n` (see `localizePluginTitle`). A generated manifest used to carry
// the humanized directory slug ("Html Ppt Zhangzara Scatterbrain") in EVERY
// locale, so the Korean rail showed raw id-like English next to proper titles.
// This walks the whole bundled catalogue through the exact selector the rail
// uses and rejects any title that still reads like an id.

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { InstalledPluginRecord } from '@readable-studio/contracts';

import { homeHeroExamplePluginsForChip } from '../../src/components/HomeHero';
import { HUB_TEMPLATE_TAB_IDS } from '../../src/components/home-hero/templateCarousel';
import { localizePluginTitle } from '../../src/components/plugins-home/localization';

const EXAMPLES_DIR = resolve(__dirname, '../../../../plugins/_official/examples');

function catalogueRecord(slug: string): InstalledPluginRecord {
  const manifest = JSON.parse(
    readFileSync(resolve(EXAMPLES_DIR, slug, 'readable-studio.json'), 'utf8'),
  ) as InstalledPluginRecord['manifest'];
  const id = `example-${slug}`;
  return {
    id,
    title: manifest.title ?? slug,
    version: manifest.version,
    sourceKind: 'bundled',
    source: EXAMPLES_DIR,
    trust: 'bundled',
    capabilitiesGranted: ['prompt:inject'],
    manifest: { ...manifest, name: id },
    fsPath: resolve(EXAMPLES_DIR, slug),
    installedAt: 0,
    updatedAt: 0,
  };
}

// What the manifest generator produced from a kebab-case directory name.
function humanizedSlug(slug: string): string {
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Tokens that only ever came from a directory slug, never from a human.
const RAW_ID_TOKEN = /^html ppt\b|\b(zhangzara|xhs|taste)\b/i;
// Acronyms the slug humanizer title-cased into nonsense ("Ib Pitch Book").
const MISCASED_ACRONYM = /\b(Ib|Dcf|Hr|Pm|Saas|Github|Okrs|Eguide|Last30days)\b/;

const CATALOGUE = readdirSync(EXAMPLES_DIR).map(catalogueRecord);

function railTitles(locale: 'ko' | 'en'): Array<{ tab: string; id: string; title: string }> {
  const rows: Array<{ tab: string; id: string; title: string }> = [];
  for (const tab of HUB_TEMPLATE_TAB_IDS) {
    const items = homeHeroExamplePluginsForChip(tab, CATALOGUE, locale, { limit: Infinity });
    expect(items.length).toBeGreaterThan(0);
    for (const record of items) {
      rows.push({ tab, id: record.id, title: localizePluginTitle(locale, record) });
    }
  }
  expect(rows.length).toBeGreaterThan(100);
  return rows;
}

describe('Hub template carousel titles', () => {
  it('every ko card title in all three tabs is a human title, not a humanized id', () => {
    const offenders = railTitles('ko')
      .filter(({ id, title }) => (
        title.trim() === '' ||
        title === humanizedSlug(id.replace(/^example-/, '')) ||
        RAW_ID_TOKEN.test(title) ||
        MISCASED_ACRONYM.test(title)
      ))
      .map(({ tab, id, title }) => `${tab}/${id}: "${title}"`);
    expect(offenders).toEqual([]);
  });

  // Plain English titles legitimately coincide with their slug ("Simple
  // Deck"), so en only rejects slug-only tokens and mis-cased acronyms.
  it('every en card title in all three tabs is free of raw id tokens', () => {
    const offenders = railTitles('en')
      .filter(({ title }) => title.trim() === '' || RAW_ID_TOKEN.test(title) || MISCASED_ACRONYM.test(title))
      .map(({ tab, id, title }) => `${tab}/${id}: "${title}"`);
    expect(offenders).toEqual([]);
  });

  it('ko card titles are short enough for the single-line card label', () => {
    const long = railTitles('ko')
      .filter(({ title }) => title.length > 32)
      .map(({ tab, id, title }) => `${tab}/${id}: "${title}"`);
    expect(long).toEqual([]);
  });
});
