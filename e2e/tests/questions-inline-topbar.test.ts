import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { placePopover } from '../../apps/web/src/components/popoverPlacement.ts';
import { anchoredPosition, assertIndicatorContrast, assertVeilComposite, assertVeilContract, assertVeilMixAlpha, bundledThemes, outsidePoints } from '../lib/playwright/questions-inline-topbar.ts';

test('outside candidates avoid a title-covering 375px portal and remain in the visible panel', () => {
  const surface = { x: 44, y: 90, width: 331, height: 980 };
  const layer = { x: 12, y: 100, width: 351, height: 240 };
  const points = outsidePoints(surface, layer, { width: 375, height: 900 });
  expect(points.length).toBeGreaterThan(0);
  expect(points.some(({ y }) => y > layer.y + layer.height)).toBe(true);
  for (const { x, y } of points) {
    expect(x).toBeGreaterThan(surface.x); expect(x).toBeLessThan(375);
    expect(y).toBeGreaterThan(surface.y); expect(y).toBeLessThan(900);
    expect(x < layer.x || x > layer.x + layer.width || y < layer.y || y > layer.y + layer.height).toBe(true);
  }
});

test('outside candidates fail closed when the panel is fully covered or offscreen', () => {
  const layer = { x: 12, y: 100, width: 351, height: 240 };
  expect(outsidePoints(layer, layer, { width: 375, height: 900 })).toEqual([]);
  expect(outsidePoints({ x: 0, y: 950, width: 375, height: 40 }, layer, { width: 375, height: 900 })).toEqual([]);
});

// Machine-consumed computed CSS, deliberately not a test of stylesheet prose.
const blue = 'color(srgb 0.72 0.81 0.94 / 0.3)';
const pink = 'color(srgb 0.86 0.76 0.91 / 0.3)';
const veil = `linear-gradient(90deg, ${blue} 10%, ${pink} 92%)`;
test('veil contract accepts intact browser color serialization', () => {
  expect(() => assertVeilContract(veil, veil)).not.toThrow();
});
test.each([
  `linear-gradient(90deg, ${pink} 10%, ${blue} 92%)`,
  veil.replaceAll('/ 0.3)', '/ 0.29)'),
  veil.replaceAll('/ 0.3)', '/ 0.3001)'),
  veil.replace('10%', '11%'),
  veil.replace('92%', '91%'),
])('veil negative control rejects changed order, alpha or positions: %s', mutated => {
  expect(() => assertVeilContract(mutated, veil)).toThrow();
});

test('composite rejects the reported invisible dark veil even within rounding tolerance', () => {
  expect(() => assertVeilComposite([47, 56, 78, 255], [47, 56, 78, 255], [48, 58, 81, 255])).toThrow();
});
test('composite accepts a subtle lifted endpoint but rejects no-op and opaque paint', () => {
  // Calculated fixtures, not new browser measurements.
  const backing = [47, 56, 78, 255], opaque = [71, 78, 98, 255];
  expect(() => assertVeilComposite([54, 63, 84, 255], backing, opaque)).not.toThrow();
  expect(() => assertVeilComposite(backing, backing, opaque)).toThrow();
  expect(() => assertVeilComposite(opaque, backing, opaque)).toThrow();
});

const preservedBlue = 'color-mix(in srgb, rgb(185, 207, 251) 30%, rgba(0, 0, 0, 0))';
const preservedPink = 'color-mix(in srgb, rgb(249, 201, 220) 30%, rgba(0, 0, 0, 0))';
const preservedVeil = `linear-gradient(90deg, ${preservedBlue} 10%, ${preservedPink} 92%)`;
test('preserved color-mix is declaration evidence, not resolved raster alpha', () => {
  expect(() => assertVeilContract(preservedVeil, preservedVeil)).not.toThrow();
  expect(() => assertVeilMixAlpha(preservedBlue, 0)).not.toThrow();
  expect(() => assertVeilMixAlpha(preservedPink, 0)).not.toThrow();
});
test.each([
  `linear-gradient(90deg, ${preservedPink} 10%, ${preservedBlue} 92%)`,
  preservedVeil.replaceAll('30%', '29%'),
  preservedVeil.replaceAll('30%', '30.01%'),
])('preserved color-mix negative control rejects changed order or alpha: %s', mutated => {
  expect(() => assertVeilContract(mutated, preservedVeil)).toThrow();
});
const resolvedColors = [
  'rgba(185, 207, 251, 0.3)', 'rgb(185 207 251 / 0.3)', 'rgb(72% 81% 94% / 30%)', blue,
  'color(display-p3 0.72 0.81 0.94 / 0.3)', 'hsl(215 50% 80% / 0.3)', 'hsla(215, 50%, 80%, 0.3)',
  'hwb(215 72% 6% / 0.3)', 'lab(80 0 -20 / 0.3)', 'lch(80 20 270 / 0.3)',
  'oklab(0.8 0 -0.1 / 0.3)', 'oklch(0.8 0.1 270 / 0.3)',
];
test.each(resolvedColors)('resolved serialization checks exact and quantized alpha: %s', css => {
  for (const alpha of [76, 77]) expect(() => assertVeilMixAlpha(css, alpha)).not.toThrow();
  for (const alpha of [0, 74, 78, 255, undefined]) expect(() => assertVeilMixAlpha(css, alpha)).toThrow();
  for (const value of ['0.29', '0.3001', '1']) {
    const mutated = css.replace(/(?:0\.3|30%)\)$/, `${css.includes('30%') ? `${Number(value) * 100}%` : value})`);
    // Close alpha mutations can quantize to the SAME byte: CSS must reject them.
    expect(() => assertVeilMixAlpha(mutated, 77)).toThrow();
  }
});
test.each(['', 'transparent', 'rgb(185 207 251)', 'color(srgb 0.72 0.81 0.94)', 'unknown(1 2 3 / 0.3)'])(
  'unsupported or opaque serialization fails with its actual representation: %s', css => {
    expect(() => assertVeilMixAlpha(css, 77)).toThrow(JSON.stringify(css));
  },
);

const requiredIndicators = ['focus:textbox:Who is this for?', 'selected-check:option:Delivery format:HTML'];
const indicators = requiredIndicators.map(selector => ({ selector, kind: 'indicator' as const, ratio: 3 }));
test('the two required semantic indicators suffice without manufacturing a third', () => {
  expect(() => assertIndicatorContrast(indicators, requiredIndicators)).not.toThrow();
});
test.each(requiredIndicators)('indicator negative control rejects low contrast on %s', selector => {
  const low = indicators.map(sample => sample.selector === selector ? { ...sample, ratio: 2.99 } : sample);
  expect(() => assertIndicatorContrast(low, requiredIndicators)).toThrow();
});
test('indicator coverage rejects missing identities and checks additional present indicators', () => {
  expect(() => assertIndicatorContrast(indicators.slice(1), requiredIndicators)).toThrow();
  expect(() => assertIndicatorContrast([...indicators, { selector: 'focus:option:Delivery format:HTML', kind: 'indicator', ratio: 2.99 }], requiredIndicators)).toThrow();
});

test('theme sampling covers exactly the bundled explicit CSS themes', () => {
  const imports = readFileSync(new URL('../../apps/web/src/styles/themes/index.css', import.meta.url), 'utf8');
  const ids = [...imports.matchAll(/@import '\.\/([^']+)\.css'/g)].map(match => match[1]!).filter(id => id !== 'recipes');
  const themes = bundledThemes();
  expect(themes.map(theme => theme.id).sort()).toEqual(['light', 'dark', ...ids].sort());
  expect(new Set(themes.map(theme => theme.id)).size).toBe(themes.length);
  expect(themes.every(theme => theme.scheme === 'light' || theme.scheme === 'dark')).toBe(true);
});

test.each([
  { anchor: { x: 100, y: 100, width: 200, height: 48 }, panel: { x: 0, y: 0, width: 240, height: 180 }, viewport: { width: 768, height: 900 }, expected: { x: 60, y: 156 } },
  { anchor: { x: 12, y: 730, width: 351, height: 48 }, panel: { x: 0, y: 0, width: 351, height: 220 }, viewport: { width: 375, height: 900 }, expected: { x: 12, y: 502 } },
  { anchor: { x: 1000, y: 100, width: 260, height: 48 }, panel: { x: 0, y: 0, width: 400, height: 220 }, viewport: { width: 1280, height: 900 }, expected: { x: 860, y: 156 } },
  { anchor: { x: 0, y: 50, width: 200, height: 48 }, panel: { x: 0, y: 0, width: 351, height: 876 }, viewport: { width: 375, height: 900 }, expected: { x: 12, y: 12 } },
])('anchor oracle handles measured boxes and viewport clamping: $expected', ({ anchor, panel, viewport, expected }) => {
  expect(anchoredPosition(anchor, panel, viewport)).toEqual(expected);
});

test.each([375, 768, 1280])('oracle matches shared placement for viewport %ipx, including flip and clamp boundaries', width => {
  const viewport = { width, height: 900 };
  for (const panelWidth of [192, Math.min(400, width - 24), width + 20]) {
    for (const panelHeight of [180, 220, 876, 920]) {
      for (const x of [-20, 0, 12, 44, width - 200, width - 12]) {
        for (const y of [0, 12, 100.25, 660 - panelHeight, 700, 850]) {
          const anchor = { x, y, width: 200.25, height: 48 };
          const panel = { width: panelWidth, height: panelHeight };
          const actual = placePopover({ left: x, top: y, width: anchor.width, height: anchor.height }, panel, viewport);
          expect(anchoredPosition(anchor, panel, viewport)).toEqual({ x: actual.left, y: actual.top });
        }
      }
    }
  }
});
