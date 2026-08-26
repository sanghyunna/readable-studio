// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  BRAND_SEED_BY_PLUGIN_ID,
  deriveBrandHue,
  resolveScheme,
} from '../../../src/components/composer/mentionBrandHue';

const PANEL_HEX = '#222120';

function displayLuminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

describe('mention brand hue', () => {
  it('contains exactly the curated plugin seeds', () => {
    expect(BRAND_SEED_BY_PLUGIN_ID).toEqual({
      notion: '#0b0b0b',
      slack: '#4a154b',
      github: '#181717',
      linear: '#5e6ad2',
      dropbox: '#0061ff',
      jira: '#0052cc',
      confluence: '#1868db',
      trello: '#0c66e4',
      miro: '#ffd02f',
      zapier: '#ff4a00',
      discord: '#5865f2',
      asana: '#f06a6a',
      airtable: '#18bfff',
    });
  });

  it.each([
    ['#000000', 'dark', '#888888'],
    ['#808080', 'dark', '#888888'],
    ['#ffffff', 'light', '#fefefe'],
    ['#0b0b0b', 'light', '#0b0b0b'],
  ] as const)('derives %s in %s mode as %s', (seed, scheme, expected) => {
    expect(deriveBrandHue(seed, scheme, PANEL_HEX)).toBe(expected);
  });

  it.each(Object.entries(BRAND_SEED_BY_PLUGIN_ID))(
    'derives a strictly brighter dark hue for %s (%s)',
    (_id, seed) => {
      const lightHue = deriveBrandHue(seed, 'light', PANEL_HEX);
      const darkHue = deriveBrandHue(seed, 'dark', PANEL_HEX);
      expect(displayLuminance(darkHue)).toBeGreaterThan(displayLuminance(lightHue));
    },
  );

  it('prefers the explicit scheme, then the theme, then light', () => {
    const root = document.createElement('html');
    expect(resolveScheme(root)).toBe('light');
    root.setAttribute('data-theme', 'dark');
    expect(resolveScheme(root)).toBe('dark');
    root.setAttribute('data-theme-scheme', 'light');
    expect(resolveScheme(root)).toBe('light');
  });
});
