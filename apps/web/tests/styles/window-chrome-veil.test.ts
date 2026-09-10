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

function endpoints(dark: boolean, attributes: string, systemDark = false) {
  const sheet = postcss.parse(shell);
  // jsdom cannot evaluate media queries: select the requested media state,
  // then let its real selector cascade resolve the chrome-local overrides.
  sheet.walkAtRules('media', rule => {
    if (systemDark && rule.params === '(prefers-color-scheme: dark)') {
      if (!rule.nodes) throw new Error('Missing system-dark media body');
      rule.replaceWith(...rule.nodes);
    } else rule.remove();
  });
  const dom = new JSDOM(`<html ${attributes}><head><style>${sheet.toString()}</style></head><body><header class="app-chrome-header app-window-chrome"></header></body></html>`);
  try {
    const style = dom.window.getComputedStyle(dom.window.document.querySelector('header')!);
    const vars = palette(dark);
    for (const name of ['blue', 'pink']) vars[`--app-window-chrome-${name}`] = style.getPropertyValue(`--app-window-chrome-${name}`).trim();
    let background = '';
    sheet.walkRules('.app-chrome-header.app-window-chrome', rule => {
      rule.walkDecls('background', decl => { background = decl.value; });
    });
    const [angle, ...stops] = args(background.slice('linear-gradient('.length, -1));
    expect(angle).toBe('90deg');
    expect(stops.map(stop => stop.match(/ (\d+)%$/)?.[1])).toEqual(['10', '92']);
    return stops.map(stop => color(stop.replace(/ \d+%$/, ''), vars));
  } finally { dom.window.close(); }
}

const composite = (paint: Color, backing: readonly number[]) => paint.slice(0, 3).map((channel, i) => channel * paint[3] + backing[i]! * (1 - paint[3]));

describe('window chrome veil separation', () => {
  it('keeps both light endpoint colors and their 30% alpha unchanged', () => {
    const actual = endpoints(false, 'data-theme="light" data-theme-scheme="light"');
    const vars = palette(false);
    for (const [i, name] of ['blue', 'pink'].entries()) {
      const original = color(`color-mix(in srgb, var(--hub-canvas-${name}) 30%, transparent)`, vars);
      expect(actual[i]).toEqual(original);
      process.stdout.write(`${JSON.stringify({ kind: 'sRGB calculation, not browser pixels', theme: 'light', endpoint: name, before: original, after: actual[i] })}\n`);
    }
  });

  it.each([
    ['explicit dark', 'data-theme="dark"', false],
    ['scheme dark', 'data-theme="dark" data-theme-scheme="dark"', false],
    ['named dark scheme', 'data-theme="nord" data-theme-scheme="dark"', false],
    ['system dark', '', true],
  ] as const)('%s separates both endpoints while retaining 70% backing', (_name, attributes, systemDark) => {
    const actual = endpoints(true, attributes, systemDark);
    const vars = palette(true);
    for (const [i, name] of ['blue', 'pink'].entries()) {
      const original = color(`var(--hub-canvas-${name})`, vars);
      expect(actual[i]![3]).toBe(0.3);
      // Even directly over the same canvas stop, every channel must move by
      // several bytes, not barely cross the screenshot's no-op assertion.
      const painted = composite(actual[i]!, original);
      for (const [channel, value] of painted.entries()) {
        expect(value - original[channel]!).toBeGreaterThanOrEqual(4);
        expect(value - original[channel]!).toBeLessThan(9);
      }
    }
  });

  it('clears the reported Chromium dark-blue backing by more than rounding tolerance', () => {
    const backing = [47, 56, 78];
    const actual = endpoints(true, 'data-theme="dark"')[0]!;
    const painted = composite(actual, backing);
    for (const [i, channel] of painted.entries()) expect(channel - backing[i]!).toBeGreaterThan(5);
    const old = color('color-mix(in srgb, var(--hub-canvas-blue) 30%, transparent)', palette(true));
    expect(Math.max(...composite(old, backing).map((value, i) => value - backing[i]!))).toBeLessThan(1.6);
    process.stdout.write(`${JSON.stringify({ kind: 'sRGB calculation, not browser pixels', backing, oldEndpoint: old.slice(0, 3), newEndpoint: actual.slice(0, 3), oldComposite: composite(old, backing), newComposite: painted })}\n`);
  });
});
