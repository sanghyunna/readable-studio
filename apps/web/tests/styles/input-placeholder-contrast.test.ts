import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { EXPLICIT_THEME_OPTIONS } from '../../src/state/themes';

const stylesRoot = resolve(import.meta.dirname, '../../src/styles');
const tokens = readFileSync(resolve(stylesRoot, 'tokens.css'), 'utf8');
const componentsRoot = resolve(stylesRoot, '../../../../packages/components/src');
type Rgb = readonly number[];

function declarations(source: string, selector?: string): Record<string, string> {
  const result: Record<string, string> = {};
  postcss.parse(source).walkRules(rule => {
    if (selector && rule.selector !== selector) return;
    rule.walkDecls(decl => { result[decl.prop] = decl.value; });
  });
  return result;
}

function color(value: string, vars: Record<string, string>): Rgb {
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  if (alias) return color(vars[alias[1]!]!, vars);
  const hex = /^#([\da-f]{6})$/i.exec(value);
  if (!hex) throw new Error(`Unsupported input color: ${value}`);
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

const controls = [
  { file: 'form-controls.module.css', field: '.control', placeholder: '.control::placeholder' },
  { file: 'styles.css', field: 'input, textarea, select', placeholder: 'input::placeholder, textarea::placeholder' },
].map(control => {
  const css = readFileSync(resolve(componentsRoot, control.file), 'utf8');
  return { ...control, fieldPaint: declarations(css, control.field), hintPaint: declarations(css, control.placeholder) };
});

const measurements = EXPLICIT_THEME_OPTIONS.flatMap(({ id }) => {
  const vars = {
    ...declarations(tokens, ':root'),
    ...(id === 'light' ? {} : id === 'dark'
      ? declarations(tokens, '[data-theme="dark"]')
      : declarations(readFileSync(resolve(stylesRoot, `themes/${id}.css`), 'utf8'))),
  };
  return controls.map(({ file, fieldPaint, hintPaint }) => {
    const bg = color(fieldPaint.background!, vars);
    const ink = color(fieldPaint.color!, vars);
    const hint = color(hintPaint.color!, vars);
    return {
      theme: id, file,
      placeholder: contrast(hint, bg),
      typed: contrast(ink, bg),
      separation: contrast(ink, hint),
      opacity: Number(hintPaint.opacity ?? 1),
      oldFaint: contrast(color(vars['--text-faint']!, vars), bg),
    };
  });
});

describe('shared input placeholder contrast', () => {
  it.each(measurements)('$theme / $file is legible and fainter than typed text', sample => {
    expect(sample.placeholder).toBeGreaterThanOrEqual(3);
    expect(sample.placeholder).toBeLessThan(sample.typed);
    expect(sample.separation).toBeGreaterThanOrEqual(1.4);
    expect(sample.opacity).toBe(1);
  });

  it('covers the system-dark token branch with the same input paints', () => {
    const system = declarations(tokens, 'html:not([data-theme])');
    const explicit = declarations(tokens, '[data-theme="dark"]');
    const base = declarations(tokens, ':root');
    for (const { fieldPaint, hintPaint } of controls) {
      for (const paint of [fieldPaint.background!, fieldPaint.color!, hintPaint.color!]) {
        expect(color(paint, { ...base, ...system })).toEqual(color(paint, { ...base, ...explicit }));
      }
    }
  });

  it('reports resolved token contrast for every palette and shared selector', () => {
    process.stdout.write(`${JSON.stringify({ placeholderContrast: measurements })}\n`);
  });
});
