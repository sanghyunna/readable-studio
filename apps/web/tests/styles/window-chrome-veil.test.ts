import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const styles = new URL('../../src/styles/', import.meta.url);
const shell = readFileSync(new URL('shell.css', styles), 'utf8');
const tokens = postcss.parse(readFileSync(new URL('tokens.css', styles), 'utf8'));
const recipes = postcss.parse(readFileSync(new URL('themes/recipes.css', styles), 'utf8'));
type Color = [number, number, number, number];

function palette(dark: boolean) {
  const vars: Record<string, string> = {};
  tokens.walkRules(rule => {
    if (rule.selector === ':root' || (dark && rule.selector === '[data-theme="dark"]')) {
      rule.walkDecls(/^--/, decl => { vars[decl.prop] = decl.value; });
    }
  });
  recipes.walkDecls(/^--/, decl => { vars[decl.prop] = decl.value; });
  return vars;
}

/** Split CSS function arguments without confusing nested mixes with stops. */
function args(value: string): string[] {
  let depth = 0, start = 0;
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++;
    if (value[i] === ')') depth--;
    if (value[i] === ',' && depth === 0) { result.push(value.slice(start, i).trim()); start = i + 1; }
  }
  return [...result, value.slice(start).trim()];
}

/** sRGB arithmetic on the shipped tokens, not a claim about browser rasterization. */
function color(value: string, vars: Record<string, string>): Color {
  if (value.startsWith('var(')) {
    const [name, fallback] = args(value.slice(4, -1));
    const resolved = vars[name!] || fallback;
    if (!resolved) throw new Error(`Missing token ${name}`);
    return color(resolved, vars);
  }
  if (value === 'transparent') return [0, 0, 0, 0];
  if (/^#[\da-f]{6}$/i.test(value)) return [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)).concat(1) as Color;
  if (value.startsWith('color-mix(')) {
    const [space, first, second] = args(value.slice(10, -1));
    expect(space).toBe('in srgb');
    const match = /^(.*) (\d+)%$/.exec(first!);
    if (!match) throw new Error(`Unsupported mix ${value}`);
    const a = color(match[1]!, vars), b = color(second!, vars), ratio = Number(match[2]) / 100;
    const alpha = a[3] * ratio + b[3] * (1 - ratio);
    return [0, 1, 2].map(i => (a[i]! * a[3] * ratio + b[i]! * b[3] * (1 - ratio)) / alpha).concat(alpha) as Color;
  }
  throw new Error(`Unsupported color ${value}`);
}

const chroma = (paint: Color) => Math.max(...paint.slice(0, 3)) - Math.min(...paint.slice(0, 3));
const composite = (paint: Color, backing: readonly number[]) =>
  paint.slice(0, 3).map((channel, i) => channel * paint[3] + backing[i]! * (1 - paint[3]));

interface Chrome {
  background: string;
  endpoints: Color[];
  canvasStops: Color[];
  glass: string;
}

/**
 * The real cascade for the chrome strip: jsdom cannot evaluate media queries,
 * so the requested media state is unwrapped first (system dark, reduced
 * transparency), then the real selector cascade resolves the chrome-local
 * endpoint tokens and the winning background declaration.
 */
function chrome(dark: boolean, attributes: string, systemDark = false, reducedTransparency = false): Chrome {
  const sheet = postcss.parse(shell);
  sheet.walkAtRules('media', rule => {
    if (systemDark && rule.params === '(prefers-color-scheme: dark)') {
      if (!rule.nodes) throw new Error('Missing system-dark media body');
      rule.replaceWith(...rule.nodes);
    } else if (reducedTransparency && rule.params === '(prefers-reduced-transparency: reduce)') {
      if (!rule.nodes) throw new Error('Missing reduced-transparency media body');
      rule.replaceWith(...rule.nodes);
    } else rule.remove();
  });
  const dom = new JSDOM(`<html ${attributes}><head><style>${sheet.toString()}</style></head><body><header class="app-chrome-header app-window-chrome"></header></body></html>`);
  try {
    const style = dom.window.getComputedStyle(dom.window.document.querySelector('header')!);
    const vars = palette(dark);
    for (const name of ['blue', 'pink']) vars[`--app-window-chrome-${name}`] = style.getPropertyValue(`--app-window-chrome-${name}`).trim();
    const glass = style.getPropertyValue('--app-window-chrome-glass').trim();
    let background = '';
    sheet.walkRules('.app-chrome-header.app-window-chrome', rule => {
      rule.walkDecls('background', decl => { background = decl.value; });
    });
    if (background.startsWith('linear-gradient(')) {
      const [angle, ...stops] = args(background.slice('linear-gradient('.length, -1));
      expect(angle).toBe('90deg');
      expect(stops.map(stop => stop.match(/ (\d+)%$/)?.[1])).toEqual(['10', '92']);
      return {
        background,
        glass,
        endpoints: stops.map(stop => color(stop.replace(/ \d+%$/, ''), vars)),
        canvasStops: [color('var(--hub-canvas-blue)', vars), color('var(--hub-canvas-pink)', vars)],
      };
    }
    return { background, glass, endpoints: [], canvasStops: [] };
  } finally { dom.window.close(); }
}

/** The shipped ribbon recipe, resolved against one scheme's palette. */
function ribbonEndpoints(dark: boolean): Color[] {
  const vars = palette(dark);
  return [
    color('color-mix(in srgb, color-mix(in srgb, var(--hub-canvas-blue) 70%, var(--blue)) 72%, transparent)', vars),
    color('color-mix(in srgb, color-mix(in srgb, var(--hub-canvas-pink) 70%, var(--purple)) 72%, transparent)', vars),
  ];
}

describe('window chrome ribbon separation', () => {
  it('light theme: both endpoints resolve to the saturated recipe at the strong-glass alpha', () => {
    const actual = chrome(false, 'data-theme="light" data-theme-scheme="light"');
    const expected = ribbonEndpoints(false);
    for (const [i, name] of ['blue', 'pink'].entries()) {
      expect(actual.endpoints[i]).toEqual(expected[i]);
      expect(actual.endpoints[i]![3]).toBe(0.72);
      // Saturation is the separation story: the band must be measurably more
      // chromatic than the canvas stop it continues, in the light scheme too.
      expect(chroma(actual.endpoints[i]!)).toBeGreaterThanOrEqual(1.6 * chroma(actual.canvasStops[i]!));
      process.stdout.write(`${JSON.stringify({ kind: 'sRGB calculation, not browser pixels', theme: 'light', endpoint: name, before: actual.canvasStops[i], after: actual.endpoints[i] })}\n`);
    }
  });

  it.each([
    ['explicit dark', 'data-theme="dark"', false],
    ['scheme dark', 'data-theme="dark" data-theme-scheme="dark"', false],
    ['named dark scheme', 'data-theme="nord" data-theme-scheme="dark"', false],
    ['system dark', '', true],
  ] as const)('%s separates both endpoints with the same saturated recipe', (_name, attributes, systemDark) => {
    const actual = chrome(true, attributes, systemDark);
    const expected = ribbonEndpoints(true);
    for (const [i] of ['blue', 'pink'].entries()) {
      expect(actual.endpoints[i]).toEqual(expected[i]);
      expect(actual.endpoints[i]![3]).toBe(0.72);
      expect(chroma(actual.endpoints[i]!)).toBeGreaterThanOrEqual(1.6 * chroma(actual.canvasStops[i]!));
      // Even directly over the same canvas stop, the band must move by a
      // clearly visible amount, not the old rounding error.
      const painted = composite(actual.endpoints[i]!, actual.canvasStops[i]!);
      const shift = Math.max(...painted.map((value, channel) => value - actual.canvasStops[i]![channel]!));
      expect(shift).toBeGreaterThanOrEqual(24);
    }
  });

  it('clears the reported Chromium dark-blue backing by an obvious step', () => {
    const backing = [47, 56, 78];
    const actual = chrome(true, 'data-theme="dark"').endpoints[0]!;
    const painted = composite(actual, backing);
    for (const [i, channel] of painted.entries()) expect(channel - backing[i]!).toBeGreaterThan(12);
    // The rejected 30% veil moved this same backing by under 1.6 per channel.
    const old = color('color-mix(in srgb, var(--hub-canvas-blue) 30%, transparent)', palette(true));
    expect(Math.max(...composite(old, backing).map((value, i) => value - backing[i]!))).toBeLessThan(1.6);
    process.stdout.write(`${JSON.stringify({ kind: 'sRGB calculation, not browser pixels', backing, oldEndpoint: old.slice(0, 3), newEndpoint: actual.slice(0, 3), oldComposite: composite(old, backing), newComposite: painted })}\n`);
  });

  it('refracts the backdrop hard through a chrome-local glass token in both schemes', () => {
    for (const [dark, attributes] of [
      [false, 'data-theme="light" data-theme-scheme="light"'],
      [true, 'data-theme="dark"'],
    ] as const) {
      const { glass } = chrome(dark, attributes);
      expect(glass).toBe('blur(32px) saturate(240%)');
      // Hard means well above the shared glass tier (blur 22px, saturate 165%).
      const blur = Number(/blur\((\d+)px\)/.exec(glass)?.[1]);
      const saturate = Number(/saturate\((\d+)%\)/.exec(glass)?.[1]);
      expect(blur).toBeGreaterThanOrEqual(28);
      expect(saturate).toBeGreaterThanOrEqual(200);
    }
  });

  it('keeps the reduced-transparency fallback opaque and unfiltered in both schemes', () => {
    for (const [dark, attributes] of [
      [false, 'data-theme="light" data-theme-scheme="light"'],
      [true, 'data-theme="dark"'],
    ] as const) {
      const actual = chrome(dark, attributes, false, true);
      expect(actual.background).toBe('var(--hub-canvas)');
      expect(color(actual.background, palette(dark))[3]).toBe(1);
      // The fallback rule must also drop the refraction: no backdrop filter
      // survives the media block for the chrome strip.
      const sheet = postcss.parse(shell);
      sheet.walkAtRules('media', rule => {
        if (rule.params === '(prefers-reduced-transparency: reduce)') rule.replaceWith(...(rule.nodes ?? []));
        else rule.remove();
      });
      const dom = new JSDOM(`<html ${attributes}><head><style>${sheet.toString()}</style></head><body><header class="app-chrome-header app-window-chrome"></header></body></html>`);
      try {
        const style = dom.window.getComputedStyle(dom.window.document.querySelector('header')!);
        expect(style.getPropertyValue('backdrop-filter')).toBe('none');
      } finally { dom.window.close(); }
    }
  });
});
