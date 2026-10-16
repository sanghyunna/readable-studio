import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { EXPLICIT_THEME_OPTIONS } from '../../src/state/themes';

const root = resolve(import.meta.dirname, '../../src/styles');
const source = (file: string) => readFileSync(resolve(root, file), 'utf8');
const tokens = source('tokens.css');
const hub = source('home/hub.css');
const hero = source('home/home-hero.css');
const chat = source('chat.css');
type Rgb = readonly number[];

function declarations(css: string, selector?: string): Record<string, string> {
  const result: Record<string, string> = {};
  postcss.parse(css).walkRules(rule => {
    if (selector && !rule.selectors.includes(selector)) return;
    if (selector && rule.parent?.type === 'atrule') return;
    rule.walkDecls(decl => { result[decl.prop] = decl.value; });
  });
  return result;
}

function color(value: string, vars: Record<string, string>): Rgb {
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  if (alias) return color(vars[alias[1]!]!, vars);
  const mix = /^color-mix\(in srgb, (var\(--[\w-]+\)) (\d+)%, (var\(--[\w-]+\))\)$/.exec(value);
  if (mix) {
    const a = color(mix[1]!, vars), b = color(mix[3]!, vars), share = Number(mix[2]) / 100;
    return a.map((channel, i) => channel * share + b[i]! * (1 - share));
  }
  const hex = /^#([\da-f]{6})$/i.exec(value);
  if (!hex) throw new Error(`Unsupported placeholder color: ${value}`);
  return [0, 2, 4].map(offset => parseInt(hex[1]!.slice(offset, offset + 2), 16));
}

function over(recipe: string, vars: Record<string, string>, base: Rgb): Rgb {
  const mix = /^color-mix\(in srgb, (var\(--[\w-]+\)) (\d+)%, transparent\)$/.exec(recipe);
  if (!mix) throw new Error(`Unsupported surface recipe: ${recipe}`);
  const ink = color(mix[1]!, vars), alpha = Number(mix[2]) / 100;
  return ink.map((channel, i) => channel * alpha + base[i]! * (1 - alpha));
}

function luminance(rgb: Rgb): number {
  return rgb.map(channel => {
    const v = channel / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i]!, 0);
}

function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const measurements = EXPLICIT_THEME_OPTIONS.flatMap(({ id }) => {
  const vars = {
    ...declarations(tokens, ':root'),
    ...(id === 'light' ? {} : id === 'dark'
      ? declarations(tokens, '[data-theme="dark"]')
      : declarations(source(`themes/${id}.css`))),
    ...declarations(source('themes/recipes.css'), ':root'),
  };
  const canvas = color(vars['--bg-app']!, vars);
  const glass = over(vars['--hub-glass-fill']!, vars, canvas);
  const searchBg = over(vars['--hub-control-surface']!, vars, glass);
  const composerBg = over(vars['--hub-composer-fill']!, vars, canvas);
  const searchPaint = declarations(hub, '.hub__search::placeholder').color
    ?? declarations(source('primitives.css'), 'input::placeholder').color!;
  const heroPaint = {
    ...declarations(hero, '.home-hero__lexical .composer-input-placeholder'),
    ...(id === 'dark' ? declarations(hero, "[data-theme='dark'] .home-hero__lexical .composer-input-placeholder") : {}),
  }.color!;
  return [
    { selector: '.hub__search::placeholder', paint: searchPaint, bg: searchBg },
    { selector: '.home-hero__lexical .composer-input-placeholder', paint: heroPaint, bg: composerBg },
    { selector: '.composer-input-placeholder', paint: declarations(chat, '.composer-input-placeholder').color!, bg: composerBg },
  ].map(({ selector, paint, bg }) => ({
    theme: id, selector, background: bg,
    placeholder: contrast(color(paint, vars), bg),
    typed: contrast(color(vars['--text']!, vars), bg),
    separation: contrast(color(paint, vars), color(vars['--text']!, vars)),
    measuredDark: id === 'dark' ? contrast(color(paint, vars), selector.startsWith('.hub__search') ? [39, 40, 46] : [32, 31, 29]) : undefined,
  }));
});

describe('Hub and workspace placeholder contrast', () => {
  it.each(measurements)('$theme / $selector remains readable but fainter than input', sample => {
    const floor = sample.theme === 'dark' || sample.theme === 'light' ? 4.5 : 3;
    expect(sample.placeholder).toBeGreaterThanOrEqual(floor);
    expect(sample.placeholder).toBeLessThan(sample.typed);
    expect(sample.separation).toBeGreaterThanOrEqual(1.4);
    if (sample.measuredDark !== undefined) expect(sample.measuredDark).toBeGreaterThanOrEqual(4.5);
  });

  it('uses text spacing instead of a visual-only chip qualifier margin', () => {
    expect(declarations(chat, '.staged-context-kind')['margin-right'] ?? '0').toBe('0');
  });

  it('reports contrast derived from the actual selector and theme tokens', () => {
    process.stdout.write(`${JSON.stringify({ composerPlaceholderContrast: measurements })}\n`);
  });
});
