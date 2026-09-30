import { expect, test } from '@playwright/test';
import { widthResizeCss, widthResizeFixtures } from '../resources/width-resize.js';

type Measurement = {
  case: string; recipe: string; supportsStretch: boolean; supportsMozAvailable: boolean;
  maxWidth: string; available: number; cssWidth: number; contentWidth: number;
  padding: number; borderWidth: number; leftOverflow: number; rightOverflow: number;
};

const recipes = {
  'percent-only': 'box-sizing:content-box;max-width:none',
  stretch: 'box-sizing:content-box;max-width:stretch',
  'border-box': 'box-sizing:border-box;max-width:100%',
  'percent-fallback-stretch': 'box-sizing:content-box;max-width:100%;max-width:stretch',
  'border-box-fallback-stretch': 'box-sizing:border-box;max-width:100%;max-width:stretch',
  'cross-engine-layered': 'box-sizing:border-box;max-width:100%;max-width:-moz-available;max-width:stretch',
} as const;

test('[P0] responsive width recipes measured in browser CSS space and at content edges', async ({ page, browser }, testInfo) => {
  const rows: Measurement[] = [];
  for (const [name, parentWidth, childClass, wrapper, margins] of [
    ['content-box', 920, 'content-edges', '', ''],
    ['border-box', 920, 'border-edges', '', ''],
    ['margin', 920, 'content-edges', '', 'margin-left:24px;margin-right:18px'],
    ['auto-center', 920, 'content-edges', '', 'margin-inline:auto'],
    ['q3', 920, 'content-edges', '', ''],
    ['scale-.75', 920, 'content-edges', 'transform:scale(.75);transform-origin:top left', ''],
    ['zoom-1.25', 920, 'content-edges', 'zoom:1.25', ''],
    ['narrow-320', 320, 'content-edges', '', ''],
    ['narrow-margin-320', 320, 'content-edges', '', 'margin-left:24px;margin-right:18px'],
  ] as const) {
    for (const [recipe, declarations] of Object.entries(recipes)) {
      const nested = name === 'scale-.75';
      await page.setContent(`<style>${widthResizeCss}</style><div id="parent" style="box-sizing:border-box;width:${parentWidth}px;padding-inline:64px;${nested ? '' : wrapper}">${nested ? `<div id="scaled" style="${wrapper}">` : ''}<div id="target" class="${childClass}" style="width:min(720px, 100%);${declarations};${margins}">Content</div>${nested ? '</div>' : ''}</div>`);
      const row = await page.evaluate(({ caseName, recipeName }) => {
        const parent = document.querySelector<HTMLElement>('#parent')!;
        const target = document.querySelector<HTMLElement>('#target')!;
        const p = parent.getBoundingClientRect();
        const t = target.getBoundingClientRect();
        const ps = getComputedStyle(parent);
        const ts = getComputedStyle(target);
        const scale = p.width / parent.offsetWidth;
        const targetScale = document.querySelector('#scaled') ? 0.75 * scale : scale;
        const left = p.left + (parent.clientLeft + Number.parseFloat(ps.paddingLeft)) * scale;
        const right = p.right - (parent.offsetWidth - parent.clientWidth - parent.clientLeft + Number.parseFloat(ps.paddingRight)) * scale;
        const padding = Number.parseFloat(ts.paddingLeft) + Number.parseFloat(ts.paddingRight);
        const borders = Number.parseFloat(ts.borderLeftWidth) + Number.parseFloat(ts.borderRightWidth);
        const cssWidth = Number.parseFloat(ts.width);
        return {
          case: caseName, recipe: recipeName,
          supportsStretch: CSS.supports('max-width', 'stretch'),
          supportsMozAvailable: CSS.supports('max-width', '-moz-available'),
          maxWidth: ts.maxWidth,
          available: (right - left) / scale,
          cssWidth,
          contentWidth: cssWidth - (ts.boxSizing === 'border-box' ? padding + borders : 0),
          padding,
          borderWidth: t.width / targetScale,
          leftOverflow: (left - t.left) / scale,
          rightOverflow: (t.right - right) / scale,
        };
      }, { caseName: name, recipeName: recipe });
      rows.push(row);
      if (recipe === 'cross-engine-layered') {
        expect(row.leftOverflow, `${name}: left edge`).toBeLessThanOrEqual(1);
        expect(row.rightOverflow, `${name}: right edge`).toBeLessThanOrEqual(1);
        expect(row.maxWidth, `${name}: effective fallback`).toMatch(/^(stretch|-moz-available)$/);
      }
    }
  }
  const get = (caseName: string, recipe: string) => rows.find((row) => row.case === caseName && row.recipe === recipe)!;
  expect(get('q3', 'percent-only').available).toBeCloseTo(792, 0);
  expect(get('narrow-320', 'percent-only').available).toBeCloseTo(192, 0);
  expect(get('narrow-320', 'percent-only').rightOverflow).toBeCloseTo(44, 0);
  expect(get('narrow-320', 'border-box').rightOverflow).toBeLessThanOrEqual(1);
  expect(get('narrow-320', 'percent-fallback-stretch').rightOverflow)
    .toBeCloseTo(get('narrow-320', 'stretch').rightOverflow, 0);
  expect(get('content-box', 'border-box').padding).toBe(40);
  expect(get('content-box', 'border-box').contentWidth).toBe(676);
  expect(get('content-box', 'percent-only').contentWidth).toBe(720);
  expect(get('narrow-margin-320', 'border-box').rightOverflow).toBeGreaterThan(1);
  if (!get('narrow-320', 'stretch').supportsStretch) {
    expect(get('narrow-320', 'stretch').rightOverflow).toBeCloseTo(44, 0);
    expect(get('narrow-320', 'percent-fallback-stretch').maxWidth).toBe('100%');
    expect(get('narrow-margin-320', 'border-box-fallback-stretch').rightOverflow).toBeGreaterThan(1);
  }
  expect(widthResizeFixtures.flexOverflow).toContain('711px');
  console.log(`WIDTH_PLATFORM_ENGINE ${browser.browserType().name()} ${browser.version()} ${JSON.stringify(rows)}`);
  await testInfo.attach('measurements.json', { body: JSON.stringify(rows, null, 2), contentType: 'application/json' });
});
