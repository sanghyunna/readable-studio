import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import postcss from 'postcss';
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
const buttonCss = readFileSync(resolve(root, '../../../../packages/components/src/button.module.css'), 'utf8');
const primitivesCss = readFileSync(resolve(root, 'primitives.css'), 'utf8');
const hoverSelector = '.questions-panel .questions-panel__row:hover:not(:disabled)';

// jsdom does not resolve var() in backgrounds. Resolve only paint declarations
// before handing the REAL selectors/shorthands to its specificity-aware cascade.
// State attributes have the same specificity as the pseudo-classes they replace.
function paintCss(source: string, vars: Record<string, string>) {
  const sheet = postcss.parse(source);
  sheet.walkDecls(decl => {
    if (!['color', 'background', 'background-color', 'background-image', 'outline', 'opacity'].includes(decl.prop)) {
      decl.remove();
      return;
    }
    decl.value = decl.value.replace(/var\((--[\w-]+)\)/g, (_, token: string) => `rgba(${resolveColor(vars[token]!, vars).join(', ')})`);
  });
  sheet.walkRules(rule => { rule.selector = rule.selector.replace(/:(hover|active|focus-visible)\b/g, '[data-$1]'); });
  // The tested paint is identical across container widths; forced-colors owns
  // system colors rather than the bundled palette measured here.
  sheet.walkAtRules(rule => { rule.remove(); });
  return sheet.toString();
}
function rowSamples(vars: Record<string, string>, source = css, reverseOrder = false) {
  const dom = new JSDOM(`<section class="questions-panel"><div class="questions-panel__content">
    <button class="button questions-panel__row"><span class="questions-panel__key">Key</span>
    <span class="questions-panel__value">Value</span><span class="questions-panel__provenance">Source</span></button>
    </div></section>`);
  const { document } = dom.window;
  const sources = [primitivesCss, buttonCss, source];
  if (reverseOrder) sources.reverse();
  for (const contents of sources) {
    const style = document.createElement('style');
    style.textContent = paintCss(contents, vars);
    document.head.append(style);
  }
  const row = document.querySelector('button')!;
  function background(node: Element): Color {
    const style = dom.window.getComputedStyle(node);
    let result = resolveColor(style.backgroundColor, vars);
    if (style.backgroundImage !== 'none') {
      const colors = style.backgroundImage.match(/rgba?\([^)]+\)/g) ?? [];
      expect(colors).toHaveLength(2);
      expect(colors[0]).toBe(colors[1]);
      result = over(resolveColor(colors[0]!, vars), result);
    }
    if (result[3] < 1) {
      if (!node.parentElement) throw new Error('Missing opaque field backing');
      result = over(result, background(node.parentElement));
    }
    return result;
  }
  const samples = ['rest', 'hover', 'active', 'expanded'].map(state => {
    row.toggleAttribute('data-hover', state === 'hover' || state === 'active');
    row.toggleAttribute('data-active', state === 'active');
    row.setAttribute('aria-expanded', String(state === 'expanded'));
    row.setAttribute('data-focus-visible', '');
    const surface = background(row);
    const text = Math.min(...[...row.children].map(node => {
      const style = dom.window.getComputedStyle(node);
      const ink = resolveColor(style.color, vars);
      ink[3] *= Number(style.opacity || 1);
      return contrast(over(ink, surface), surface);
    }));
    // jsdom retains outline shorthand without expanding its longhands.
    const outline = dom.window.getComputedStyle(row).outline;
    expect(outline).toMatch(/^2px solid /);
    const focus = contrast(resolveColor(outline.match(/rgba?\([^)]+\)/)![0], vars), surface);
    return { state, text, focus, surface };
  });
  dom.window.close();
  return samples;
}
function themeVars(id: string) {
  const source = id === 'light' ? block(tokens, ':root') : id === 'dark' ? block(tokens, '[data-theme="dark"]') : readFileSync(resolve(root, `themes/${id}.css`), 'utf8');
  // The recipe branches on the palette's own polarity: the shared block is the
  // light derivation, and dark palettes (`color-scheme: dark`) take the later
  // `[data-theme='<id>']` block as their cascade winner.
  const dark = id === 'dark' || (id !== 'light' && /color-scheme:\s*dark/.test(source));
  const recipeBlocks = [...recipes.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}@]*?)\{([^{}]*)\}/g)];
  const themeRecipes = recipeBlocks.filter(([, selectors = '']) => selectors.includes(':root') || (dark && selectors.includes(`[data-theme='${id}']`)));
  return { ...declarations(block(tokens, ':root')), ...declarations(source), ...Object.assign({}, ...themeRecipes.map(([, , body]) => declarations(body!))) };
}
const measurements = EXPLICIT_THEME_OPTIONS.map(({ id }) => {
  const vars = themeVars(id);
  const get = (name: string) => resolveColor(vars[name]!, vars);
  const ink = get('--text-strong');
  // Input wells and popover options: engraved wash over the opaque `--bg`.
  const field = over(get('--hub-control-engraved'), get('--bg'));
  // Ledger sheet (`--bg`) and the hovered/open row + count pill: the same
  // wash composited over the sheet. `--bg-panel` stays measured for the
  // raised Skip/editor buttons that sit on the sheet.
  const sheet = get('--bg');
  const well = over(get('--hub-control-engraved'), sheet);
  const surfaces = [field, sheet, get('--bg-panel'), well];
  const rows = [...rowSamples(vars), ...rowSamples(vars, css, true)];
  const hovered = rows.find(row => row.state === 'hover')!;
  const expanded = rows.find(row => row.state === 'expanded')!;
  return { id, text: Math.min(...surfaces.map(bg => contrast(ink, bg)), ...rows.map(row => row.text)),
    label: Math.min(...rows.map(row => row.text)), focus: Math.min(...rows.map(row => row.focus)),
    rest: rows.find(row => row.state === 'rest')!.text, hover: hovered.text, expanded: expanded.text,
    hoverSurface: hovered.surface, wellSurface: well,
    selection: contrast(ink, field), old: contrast(get('--text-faint'), field), oldBody: contrast(get('--text'), field) };
});

describe('Questions actual bundled theme contrast recipes', () => {
  it('binds measured ink and layered surfaces to the shipped field, placeholder and selection styles', () => {
    expect(css).toContain('linear-gradient(var(--hub-control-engraved), var(--hub-control-engraved)), var(--bg)');
    expect(css).toContain('outline: 2px solid var(--text-strong)');
    expect(css).toContain('inset 0 -2px 0 var(--text-strong)');
    expect(css).not.toMatch(/color:\s*var\(--text-(muted|faint|soft)\)/);
    // Token-only paint: no literal colours of any notation and no `--bg-subtle`
    // (the opaque grey that failed Solarized when Button's hover fill won).
    const paintOnly = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(paintOnly).not.toMatch(/#[\da-f]{3,8}\b/i);
    expect(paintOnly).not.toMatch(/\b(?:rgba?|hsla?|oklch|oklab|color-mix)\(/);
    expect(paintOnly).not.toMatch(/[:(,]\s*(?:white|black|gr[ae]y|silver|gainsboro|whitesmoke)(?![\w-])/i);
    expect(paintOnly).not.toContain('--bg-subtle');
    // Rest rows are lines of the sheet; hover and the open row lift the
    // theme-derived engraved wash rather than an opaque fill.
    expect(paintOnly).toMatch(/\.questions-panel \.questions-panel__row\s*\{[^}]*background:\s*transparent/);
    expect(paintOnly).toMatch(/\.questions-panel \.questions-panel__row:hover:not\(:disabled\),\s*\.questions-panel \.questions-panel__row\[aria-expanded='true'\]\s*\{[^}]*background:\s*var\(--hub-control-engraved\)/);
    expect(paintOnly).toMatch(/\.questions-panel__content\s*\{[^}]*background:\s*var\(--bg\)/);
    // Motion: repository easing and the enter/exit pair, with a reduced-motion
    // variant that drops every row transition.
    expect(paintOnly).toMatch(/transition:[^;]*var\(--dur-quick\) var\(--ease-out\)/);
    expect(paintOnly).toMatch(/transition-duration:\s*var\(--dur-enter\)/);
    expect(paintOnly).toMatch(/transition:\s*transform var\(--dur-exit\) var\(--ease-out\)/);
    expect(paintOnly).not.toMatch(/cubic-bezier|\d+ms/);
    expect(paintOnly).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.questions-panel__row > svg\s*\{\s*transition:\s*none/);
    expect(paintOnly).toMatch(/@media \(prefers-reduced-transparency: reduce\)/);
    // Keep the row inks bound to the measured semantic token. The regression
    // below removes only the hover BACKGROUND fix, not these ink selectors.
    expect(css).toMatch(/\.questions-panel \.questions-panel__key\s*\{[^}]*color:\s*var\(--text-strong\)/);
    expect(css).toMatch(/\.questions-panel \.questions-panel__value\s*\{[^}]*color:\s*var\(--text-strong\)/);
    expect(css).toMatch(/\.questions-panel \.questions-panel__provenance\s*\{[^}]*color:\s*var\(--text-strong\)/);
    expect(css).toMatch(/::placeholder\s*\{\s*color:\s*var\(--text-strong\)/);
    expect(measurements).toHaveLength(12);
    expect(measurements[0]!.text).not.toBe(measurements[1]!.text);
  });
  it.each(measurements)('$id rest/hover/active/expanded text >=4.5; focus and selected markers >=3 in either stylesheet order', ({ text, focus, selection, hoverSurface, wellSurface }) => {
    expect(text).toBeGreaterThanOrEqual(4.5);
    expect(focus).toBeGreaterThanOrEqual(3);
    expect(selection).toBeGreaterThanOrEqual(3);
    // The cascaded hover row lands on the derived well, so the count pill and
    // the open row (same recipe) are covered by the same measurement. jsdom
    // quantises the substituted rgba() channels, so identity is within half a
    // channel step rather than float-exact.
    hoverSurface.forEach((channel, i) => expect(channel).toBeCloseTo(wellSurface[i]!, 0));
  });
  it('reproduces the exact browser failure when the old Button hover surface wins (negative control)', () => {
    const oldCss = postcss.parse(css);
    oldCss.walkRules(rule => { if (rule.selectors.includes(hoverSelector)) rule.walkDecls('background', decl => { decl.remove(); }); });
    const vars = themeVars('solarized-dark');
    for (const reverse of [false, true]) {
      const samples = rowSamples(vars, oldCss.toString(), reverse);
      expect(samples[0]!.text).toBeGreaterThanOrEqual(4.5);
      expect(samples[1]!.surface).toEqual(resolveColor(vars['--bg-subtle']!, vars));
      expect(samples[1]!.text).toBeCloseTo(4.207877101125791, 10);
      expect(samples[1]!.text).toBeLessThan(4.5);
    }
  });
  it('rejects the old low-contrast group and label ink (negative control)', () => {
    const solarized = measurements.find(m => m.id === 'solarized-dark')!;
    expect(() => expect(solarized.old).toBeGreaterThanOrEqual(4.5)).toThrow();
    // Base body ink also fails on the resting well, independently of hover.
    expect(() => expect(solarized.oldBody).toBeGreaterThanOrEqual(4.5)).toThrow();
  });
  it('reports every resolved recipe, including base light and dark', () => {
    process.stdout.write(`${JSON.stringify(measurements.map(m => ({ theme: m.id, text: m.text.toFixed(4), rest: m.rest.toFixed(4), hover: m.hover.toFixed(4), expanded: m.expanded.toFixed(4), focus: m.focus.toFixed(4), selection: m.selection.toFixed(4), oldFaint: m.old.toFixed(4), oldBody: m.oldBody.toFixed(4) })))}\n`);
  });
});
