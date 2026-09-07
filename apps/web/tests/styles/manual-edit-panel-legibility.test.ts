import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { collectCssHardcodedColorMatches } from '../../../../scripts/style-policy';

/**
 * Direct-edit left panel legibility.
 *
 * The reported defect: in light theme the control cards sat on the pane at
 * 1.03:1, so a card edge — and therefore whether a component existed at a
 * given position at all — was invisible. The remedy is an engraved (음각)
 * control tier: a recessed ink wash in light, a raised warm-glass wash in
 * dark, both carried by depth (inset shadow + rim light) rather than a border,
 * because outlines are refused by the house style even at 1px.
 *
 * These assertions are numeric on purpose. "Visible on my monitor" is not a
 * result; the separation ratios below are.
 */

const inspectorCss = readFileSync(
  new URL('../../src/components/ManualEditLeftInspector.module.css', import.meta.url),
  'utf8',
);
const textControlsCss = readFileSync(
  new URL('../../src/components/ManualEditTextControls.module.css', import.meta.url),
  'utf8',
);
const shapeControlsCss = readFileSync(
  new URL('../../src/components/ManualEditShapeControls.module.css', import.meta.url),
  'utf8',
);
const geometryCss = readFileSync(
  new URL('../../src/components/ManualEditGeometryControls.module.css', import.meta.url),
  'utf8',
);
const tokensCss = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8');
const recipesCss = readFileSync(
  new URL('../../src/styles/themes/recipes.css', import.meta.url),
  'utf8',
);

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  return match?.[1] ?? '';
}

type Rgb = readonly [number, number, number];

function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [
    fg[0] * alpha + bg[0] * (1 - alpha),
    fg[1] * alpha + bg[1] * (1 - alpha),
    fg[2] * alpha + bg[2] * (1 - alpha),
  ];
}

function toLinear(channel: number): number {
  const v = channel / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Reads `--name: rgba(r, g, b, a)` out of a themed token block. */
function readRgbaToken(css: string, blockStart: string, name: string): { rgb: Rgb; alpha: number } {
  const from = css.indexOf(blockStart);
  expect(from, `token block ${blockStart} must exist`).toBeGreaterThanOrEqual(0);
  const block = css.slice(from, css.indexOf('\n}', from));
  const match = new RegExp(
    `--${name}:\\s*rgba\\(\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*\\)`,
  ).exec(block);
  expect(match, `--${name} must be declared in ${blockStart} as an rgba() literal`).not.toBeNull();
  const [, r, g, b, a] = match as RegExpExecArray;
  return { rgb: [Number(r), Number(g), Number(b)], alpha: Number(a) };
}

const LIGHT_ROOT = ':root {';
const DARK_BLOCK = '[data-theme="dark"] .hub,';

// The composited pane the inspector body sits on: --hub-glass-fill over the
// canvas base, per shell.css `.split-chat-slot > .manual-edit-left-host`.
const LIGHT_CANVAS: Rgb = [231, 236, 245]; // --hub-canvas-base
const DARK_CANVAS: Rgb = [26, 25, 23];
const LIGHT_PANE = over([255, 255, 255], 0.55, LIGHT_CANVAS);
const DARK_PANE = over([38, 36, 33], 0.62, DARK_CANVAS);

const LIGHT_TEXT: Rgb = [31, 30, 27]; // --text
const LIGHT_TEXT_MUTED: Rgb = [99, 96, 90]; // --text-muted
const DARK_TEXT: Rgb = [237, 235, 231];
const DARK_TEXT_MUTED: Rgb = [168, 164, 158];

/**
 * The separation floor. 1.03:1 shipped and was unreadable; the two prior
 * contrast regressions in this project were 1.081 and 1.09. A control tier has
 * to clear those decisively to be a distinction rather than a rounding error.
 */
const MIN_SURFACE_SEPARATION = 1.15;
const MIN_SELECTED_SEPARATION = 1.2;
const WCAG_AA = 4.5;

describe('direct-edit panel legibility — engraved control tier', () => {
  it('declares an engraved control tier in both themes, deliberately per scheme', () => {
    // Light engraves by recessing (an ink wash *below* the pane); dark engraves
    // by raising a warm glass wash, because a black wash on a near-black pane
    // is the flat "clay" reading that was rejected before.
    const light = readRgbaToken(tokensCss, LIGHT_ROOT, 'hub-control-engraved');
    const dark = readRgbaToken(tokensCss, DARK_BLOCK, 'hub-control-engraved');

    expect(relativeLuminance(light.rgb)).toBeLessThan(relativeLuminance(LIGHT_PANE));
    expect(relativeLuminance(dark.rgb)).toBeGreaterThan(relativeLuminance(DARK_PANE));

    // Every theme resolves the tier through the shared recipe, not a per-theme
    // invented palette.
    expect(recipesCss).toMatch(/--hub-control-engraved:\s*color-mix\(/);
    expect(recipesCss).toMatch(/--hub-control-engraved-hover:\s*color-mix\(/);
    expect(recipesCss).toMatch(/--hub-control-engraved-shadow:/);
  });

  it('separates a control card from the pane above the contrast floor in BOTH themes', () => {
    const light = readRgbaToken(tokensCss, LIGHT_ROOT, 'hub-control-engraved');
    const dark = readRgbaToken(tokensCss, DARK_BLOCK, 'hub-control-engraved');

    const lightCard = over(light.rgb, light.alpha, LIGHT_PANE);
    const darkCard = over(dark.rgb, dark.alpha, DARK_PANE);

    expect(contrast(lightCard, LIGHT_PANE)).toBeGreaterThanOrEqual(MIN_SURFACE_SEPARATION);
    expect(contrast(darkCard, DARK_PANE)).toBeGreaterThanOrEqual(MIN_SURFACE_SEPARATION);

    // The engraving must not eat the text it frames: AA on the new surface.
    expect(contrast(LIGHT_TEXT, lightCard)).toBeGreaterThanOrEqual(WCAG_AA);
    expect(contrast(LIGHT_TEXT_MUTED, lightCard)).toBeGreaterThanOrEqual(WCAG_AA);
    expect(contrast(DARK_TEXT, darkCard)).toBeGreaterThanOrEqual(WCAG_AA);
    expect(contrast(DARK_TEXT_MUTED, darkCard)).toBeGreaterThanOrEqual(WCAG_AA);
  });

  it('hover stays a distinct step, not another 1.09:1 non-event', () => {
    const light = readRgbaToken(tokensCss, LIGHT_ROOT, 'hub-control-engraved');
    const lightHover = readRgbaToken(tokensCss, LIGHT_ROOT, 'hub-control-engraved-hover');
    const dark = readRgbaToken(tokensCss, DARK_BLOCK, 'hub-control-engraved');
    const darkHover = readRgbaToken(tokensCss, DARK_BLOCK, 'hub-control-engraved-hover');

    const lightRest = over(light.rgb, light.alpha, LIGHT_PANE);
    const darkRest = over(dark.rgb, dark.alpha, DARK_PANE);

    expect(contrast(over(lightHover.rgb, lightHover.alpha, LIGHT_PANE), lightRest)).toBeGreaterThan(
      1.05,
    );
    expect(contrast(over(darkHover.rgb, darkHover.alpha, DARK_PANE), darkRest)).toBeGreaterThan(
      1.05,
    );
  });

  it('binds the inspector field material to the engraved tier, borderlessly', () => {
    const root = ruleBody(inspectorCss, '.root');
    expect(root).toMatch(/--manual-edit-field-bg:\s*var\(--hub-control-engraved\)/);
    expect(root).toMatch(/--manual-edit-field-bg-hover:\s*var\(--hub-control-engraved-hover\)/);
    expect(root).toMatch(/--manual-edit-field-border:\s*transparent/);
    // Depth, not chrome: the rest shadow is an engraving recipe.
    expect(root).toMatch(/--manual-edit-field-shadow:\s*var\(--hub-control-engraved-shadow\)/);

    // Every surface in the panel's own stacked-card tier is borderless. The
    // docked toolbar and the detached popovers in the *-Controls modules are a
    // different tier and out of scope here; these are the rules the report is
    // about.
    for (const selector of [
      '.dimension,\n.offset',
      '.segment',
      '.positionState',
    ]) {
      const body = ruleBody(geometryCss, selector);
      expect(body, `${selector} must be declared`).not.toBe('');
      expect(body).toMatch(/border:\s*0/);
      expect(body).not.toMatch(/border:\s*1px solid/);
    }
    for (const selector of ['.cc-row', '.cc-quad-cell']) {
      const body = ruleBody(inspectorCss, `.root :global(${selector})`);
      expect(body, `${selector} must be declared`).not.toBe('');
      expect(body).toMatch(/border:\s*0/);
      expect(body).toMatch(/background:\s*var\(--manual-edit-field-bg\)/);
      expect(body).toMatch(/box-shadow:\s*var\(--manual-edit-field-shadow\)/);
    }
    for (const css of [inspectorCss, textControlsCss, shapeControlsCss, geometryCss]) {
      expect(css).not.toMatch(/border-color:\s*var\(--border-control\)/);
    }
  });

  it('gives an empty field its own affordance so it still reads as an input', () => {
    // An engraved well plus a lit lower lip: the input is legible as an input
    // when it holds no value at all.
    expect(tokensCss).toMatch(/--hub-control-engraved-shadow:\s*inset 0 1px 2px/);
    expect(tokensCss).toMatch(/--hub-control-engraved-shadow:[^;]*inset 0 -1px 0/);
    for (const css of [geometryCss, textControlsCss, shapeControlsCss]) {
      expect(css).toMatch(/var\(--manual-edit-field-shadow[,)]/);
    }
    // Placeholder ink must stay legible inside the well.
    expect(geometryCss).toMatch(/::placeholder/);
  });

  it('makes the selected segmented option unmistakable against its unselected siblings', () => {
    const segment = ruleBody(geometryCss, '.segment');
    expect(segment).toMatch(/border:\s*0/);
    expect(segment).toMatch(/background:\s*var\(--hub-control-engraved/);

    const active = ruleBody(geometryCss, '.segmentButton.active,\n.aspect.active');
    expect(active).toMatch(/var\(--hub-segment-selected\)/);

    const selected = readRgbaToken(tokensCss, LIGHT_ROOT, 'hub-segment-selected');
    const darkSelected = readRgbaToken(tokensCss, DARK_BLOCK, 'hub-segment-selected');
    const light = readRgbaToken(tokensCss, LIGHT_ROOT, 'hub-control-engraved');
    const dark = readRgbaToken(tokensCss, DARK_BLOCK, 'hub-control-engraved');

    const lightTrack = over(light.rgb, light.alpha, LIGHT_PANE);
    const darkTrack = over(dark.rgb, dark.alpha, DARK_PANE);
    const lightSelected = over(selected.rgb, selected.alpha, lightTrack);
    const darkSelectedSurface = over(darkSelected.rgb, darkSelected.alpha, darkTrack);

    expect(contrast(lightSelected, lightTrack)).toBeGreaterThanOrEqual(MIN_SELECTED_SEPARATION);
    expect(contrast(darkSelectedSurface, darkTrack)).toBeGreaterThanOrEqual(
      MIN_SELECTED_SEPARATION,
    );

    // And the label on the selected chip clears AA in both themes.
    expect(contrast([30, 58, 138], lightSelected)).toBeGreaterThanOrEqual(WCAG_AA);
    expect(contrast([197, 210, 255], darkSelectedSurface)).toBeGreaterThanOrEqual(WCAG_AA);
  });

  it('keeps the reduced-transparency fallback coherent with the engraved tier', () => {
    const fallback = inspectorCss.slice(
      inspectorCss.indexOf('@media (prefers-reduced-transparency: reduce)'),
    );
    expect(fallback).toMatch(/--manual-edit-field-bg:\s*var\(--bg-subtle\)/);
    // Opaque mode still has to carry the well; a flat fill on a flat panel is
    // the original defect wearing a different hat.
    expect(fallback).toMatch(/--manual-edit-field-shadow:[^;]*inset 0 1px 2px/);
    expect(geometryCss).toMatch(/@media \(prefers-reduced-transparency: reduce\)/);
  });

  it('introduces no hardcoded colour literals in the panel modules', () => {
    for (const css of [inspectorCss, textControlsCss, shapeControlsCss, geometryCss]) {
      expect(collectCssHardcodedColorMatches(css)).toEqual([]);
    }
  });
});
