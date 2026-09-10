import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPLICIT_THEME_OPTIONS } from '../../src/state/themes';

const root = resolve(import.meta.dirname, '../../src/styles');
const tokens = readFileSync(resolve(root, 'tokens.css'), 'utf8');
const recipes = readFileSync(resolve(root, 'themes/recipes.css'), 'utf8');
const css = readFileSync(resolve(root, '../components/QuestionsPanel.css'), 'utf8');
type Color = [number, number, number, number];
function declarations(source: string): Record<string, string> {
  return Object.fromEntries([...source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1]!, m[2]!.trim()]));
}
function block(source: string, selector: string) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const start = clean.indexOf(selector);
  if (start < 0) throw new Error(`Missing theme selector: ${selector}`);
  const open = clean.indexOf('{', start);
  return clean.slice(open + 1, clean.indexOf('}', open));
}
function resolveColor(value: string, vars: Record<string, string>): Color {
  if (value.startsWith('var(')) return resolveColor(vars[value.slice(4, -1)]!, vars);
  if (value === 'transparent') return [0, 0, 0, 0];
  const hex = /^#([\da-f]{6})$/i.exec(value);
  if (hex) return [...[0, 2, 4].map(offset => parseInt(hex[1]!.slice(offset, offset + 2), 16)), 1] as Color;
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value);
  if (rgba) { const channels = rgba[1]!.split(/[, /]+/).map(Number); return [channels[0]!, channels[1]!, channels[2]!, channels[3] ?? 1]; }
  const mix = /^color-mix\(in srgb, (var\([^)]+\)) (\d+)%, (.+)\)$/.exec(value);
  if (mix) {
    const a = resolveColor(mix[1]!, vars), b = resolveColor(mix[3]!, vars), p = Number(mix[2]) / 100;
    const alpha = a[3] * p + b[3] * (1 - p);
    return [...[0, 1, 2].map(i => (a[i]! * a[3] * p + b[i]! * b[3] * (1 - p)) / alpha), alpha] as Color;
  }
  throw new Error(`Unsupported rendered color recipe: ${value}`);
}
function over(a: Color, b: Color): Color { return [...[0, 1, 2].map(i => a[i]! * a[3] + b[i]! * (1 - a[3])), 1] as Color; }
function luminance(color: Color) {
  return color.slice(0, 3).map(x => { const v = x / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i]!, 0);
}
function contrast(a: Color, b: Color) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
const measurements = EXPLICIT_THEME_OPTIONS.map(({ id }) => {
  const source = id === 'light' ? block(tokens, ':root') : id === 'dark' ? block(tokens, '[data-theme="dark"]') : readFileSync(resolve(root, `themes/${id}.css`), 'utf8');
  const vars = { ...declarations(block(tokens, ':root')), ...declarations(source), ...declarations(recipes) };
  const get = (name: string) => resolveColor(vars[name]!, vars);
  const ink = get('--text-strong');
  const field = over(get('--hub-control-engraved'), get('--bg'));
  const surfaces = [field, get('--bg'), get('--bg-panel')];
  return { id, text: Math.min(...surfaces.map(bg => contrast(ink, bg))), focus: contrast(ink, field), old: contrast(get('--text-faint'), field) };
});

describe('Questions actual bundled theme contrast recipes', () => {
  it('binds measured ink and layered surfaces to the shipped field, placeholder and selection styles', () => {
    expect(css).toContain('linear-gradient(var(--hub-control-engraved), var(--hub-control-engraved)), var(--bg)');
    expect(css).toContain('outline: 2px solid var(--text-strong)');
    expect(css).toContain('inset 0 -2px 0 var(--text-strong)');
    expect(css).not.toMatch(/color:\s*var\(--text-(muted|faint|soft)\)/);
    expect(css).toMatch(/::placeholder\s*\{\s*color:\s*var\(--text-strong\)/);
    expect(measurements).toHaveLength(12);
    expect(measurements[0]!.text).not.toBe(measurements[1]!.text);
  });
  it.each(measurements)('$id normal/value/placeholder text >=4.5; focus and selected markers >=3', ({ text, focus }) => {
    expect(text).toBeGreaterThanOrEqual(4.5);
    expect(focus).toBeGreaterThanOrEqual(3);
  });
  it('rejects the old low-contrast group and label ink (negative control)', () => {
    const solarized = measurements.find(m => m.id === 'solarized-dark')!;
    expect(() => expect(solarized.old).toBeGreaterThanOrEqual(4.5)).toThrow();
  });
  it('reports every resolved recipe, including base light and dark', () => {
    process.stdout.write(`${JSON.stringify(measurements.map(m => ({ theme: m.id, text: m.text.toFixed(2), focus: m.focus.toFixed(2), oldFaint: m.old.toFixed(2) })))}\n`);
  });
});
