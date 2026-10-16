import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { EXPLICIT_THEME_OPTIONS } from '../../src/state/themes';

const stylesRoot = resolve(import.meta.dirname, '../../src/styles');
const tokens = readFileSync(resolve(stylesRoot, 'tokens.css'), 'utf8');
const base = readFileSync(resolve(stylesRoot, 'base.css'), 'utf8');
type Rgb = readonly number[];

function declarations(source: string, selector?: string): Record<string, string> {
  const result: Record<string, string> = {};
  postcss.parse(source).walkRules(rule => {
    if (selector && rule.selector !== selector) return;
    rule.walkDecls(decl => { result[decl.prop] = decl.value; });
  });
  return result;
}

function over(ink: Rgb, alpha: number, surface: Rgb): Rgb {
  return ink.map((channel, index) => channel * alpha + surface[index]! * (1 - alpha));
}

function color(value: string, vars: Record<string, string>, surface: Rgb): Rgb {
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  if (alias) return color(vars[alias[1]!]!, vars, surface);
  const mix = /^color-mix\(in srgb, (var\(--[\w-]+\)) (\d+)%, transparent\)$/.exec(value);
  if (mix) return over(color(mix[1]!, vars, surface), Number(mix[2]) / 100, surface);
  const hex = /^#([\da-f]{6})$/i.exec(value);
  if (!hex) throw new Error(`Unsupported loading shell color: ${value}`);
  return [0, 2, 4].map(offset => parseInt(hex[1]!.slice(offset, offset + 2), 16));
}

function luminance(rgb: Rgb): number {
  return rgb.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
}

function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const shell = declarations(base, '.readable-loading-shell');
const palettes = EXPLICIT_THEME_OPTIONS.map(({ id }) => ({
  id,
  vars: {
    ...declarations(tokens, ':root'),
    ...(id === 'light' ? {} : id === 'dark'
      ? declarations(tokens, '[data-theme="dark"]')
      : declarations(readFileSync(resolve(stylesRoot, `themes/${id}.css`), 'utf8'))),
  },
}));
palettes.push({
  id: 'system-dark' as typeof palettes[number]['id'],
  vars: { ...declarations(tokens, ':root'), ...declarations(tokens, 'html:not([data-theme])') },
});

describe('boot loading shell contrast', () => {
  it.each(palettes)('$id keeps normal-size loading text at least 4.5:1', ({ vars }) => {
    const layers = postcss.list.comma(shell.background!);
    const canvas = layers.pop()!;
    let backgrounds = [color(canvas, vars, [0, 0, 0])];
    // Check all gradient stop combinations, a conservative superset of the
    // backgrounds possible at the text position on desktop and mobile.
    for (const layer of layers.reverse()) {
      const stops = [...layer.matchAll(/color-mix\(in srgb, var\(--[\w-]+\) \d+%, transparent\)/g)]
        .map(match => match[0]);
      expect(stops.length).toBeGreaterThan(0);
      backgrounds = backgrounds.flatMap(bg => stops.map(stop => color(stop, vars, bg)));
    }
    const minimum = Math.min(...backgrounds.map(bg => contrast(color(shell.color!, vars, bg), bg)));
    expect(minimum).toBeGreaterThanOrEqual(4.5);
  });
});
