import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readExpandedIndexCss } from '../helpers/read-expanded-css';

const indexCss = readExpandedIndexCss();
const layoutTsx = readFileSync(new URL('../../app/layout.tsx', import.meta.url), 'utf8');
const fontsCss = readFileSync(new URL('../../src/styles/fonts.css', import.meta.url), 'utf8');

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(indexCss);
  if (!match) throw new Error(`Missing CSS block for ${selector}`);
  return match[1] ?? '';
}

describe('default app background colors', () => {
  it('uses the release light background color by default', () => {
    const root = cssBlock(':root');

    expect(root).toContain('--bg: #faf9f7;');
    expect(root).toContain('--bg-app: #faf9f7;');
  });

  it('keeps the dark theme background unchanged', () => {
    const dark = cssBlock('[data-theme="dark"]');

    expect(dark).toContain('--bg: #1a1917;');
    expect(dark).toContain('--bg-app: #1a1917;');
  });

  it('uses bundled Pretendard before platform fallback fonts', () => {
    const root = cssBlock(':root');
    const sans = /--sans:\s*([^;]+);/.exec(root)?.[1];

    expect(sans).toBeDefined();
    expect(sans).toContain("'Pretendard'");
    expect(sans).not.toContain("'Inter'");
    expect(sans).toMatch(/'Pretendard', 'Apple SD Gothic Neo', 'Malgun Gothic'/);
  });

  it('loads the Pretendard override after app surface styles', () => {
    const indexImport = layoutTsx.indexOf("import '../src/index.css';");
    const homeImport = layoutTsx.indexOf("import '../src/styles/home/index.css';");
    const fontsImport = layoutTsx.indexOf("import '../src/styles/fonts.css';");

    expect(indexImport).toBeGreaterThanOrEqual(0);
    expect(homeImport).toBeGreaterThan(indexImport);
    expect(fontsImport).toBeGreaterThan(homeImport);
    expect(indexCss).not.toContain("@import './styles/fonts.css';");
  });

  it('prehydrates legacy custom accents before React loads', () => {
    expect(layoutTsx).toContain(
      "var m=c.accentColorMode;var custom=m==='custom'||(m!=='theme'&&a!=='#c96442')",
    );
  });

  it('forces app text to Pretendard without clobbering Remix Icon glyphs', () => {
    expect(fontsCss).toContain("format('woff2')");
    expect(fontsCss).not.toContain('woff2-variations');
    expect(fontsCss).toContain('body *:not([class^=\'ri-\']):not([class*=\' ri-\'])');
    expect(fontsCss).toContain("font-family: 'Pretendard'");
    expect(fontsCss).not.toContain('font-family: var(--sans) !important;');
  });
});
