// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { afterEach, describe, expect, it } from 'vitest';

const readStyle = (path: string) => readFileSync(resolve(process.cwd(), 'src/styles', path), 'utf8');
const hub = readStyle('home/hub.css');
const entry = readStyle('home/entry-layout.css');
const homeShell = '.workspace-shell:has(> .workspace-shell__body .entry-main__inner--home)';
afterEach(() => { document.head.innerHTML = ''; document.body.innerHTML = ''; });

function declarations(css: string, selector: string, media = '') {
  const values: Record<string, string> = {};
  parse(css).walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    const parent = rule.parent;
    const query = parent?.type === 'atrule' && parent.name === 'media' ? parent.params : '';
    if (query !== media) return;
    rule.walkDecls((decl) => { values[decl.prop] = decl.value; });
  });
  return values;
}

describe('Hub ambient ownership at the shell boundary', () => {
  it('keeps every routed wrapper transparent through the real opaque base rules', () => {
    for (const css of [readStyle('shell.css'), readStyle('workspace/artifacts.css'), entry, hub]) {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.append(style);
    }
    document.body.innerHTML = `<div class="workspace-shell"><div class="workspace-shell__body">
      <aside class="hub__nav"></aside><div data-surface="hub"><div class="entry-shell entry-shell--no-header">
      <div class="entry"><div class="entry-main entry-main--scroll"><div class="entry-main__inner entry-main__inner--home">
      <div class="hub"><div class="hub__wash"></div><main class="hub__stage"></main></div>
      </div></div></div></div></div></div></div>`;
    for (const selector of ['.entry-shell', '.entry', '.entry-main--scroll', '.hub', '.hub__stage']) {
      // jsdom keeps unresolved custom properties in the shorthand, while its
      // backgroundColor alone defaults to transparent even for var(--bg).
      expect(getComputedStyle(document.querySelector(selector)!).background, selector)
        .toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
    }
    // Negative control: the original opaque declaration must be observable,
    // not mistaken for transparency because jsdom cannot resolve its token.
    const opaque = document.createElement('style');
    opaque.textContent = '.workspace-shell .entry-shell { background: var(--bg); }';
    document.head.append(opaque);
    expect(getComputedStyle(document.querySelector('.entry-shell')!).background).toContain('--bg');
  });

  it('paints each Hub bloom once on shell-owned carriers, not inside the routed surface', () => {
    const carriers = [
      [homeShell + '::before', 'accent'],
      [homeShell + ' > .workspace-shell__body::before', 'warm'],
      [homeShell + '::after', 'cool'],
    ];
    for (const [selector, bloom] of carriers) {
      const rule = declarations(hub, selector!);
      expect(rule.background).toBe(`var(--hub-wash-bloom-${bloom})`);
      expect(rule.position).toBe('fixed');
      expect(rule['pointer-events']).toBe('none');
      expect(rule['z-index']).toBe('-1');
      expect(declarations(hub, selector!, '(prefers-reduced-transparency: reduce)').display).toBe('none');
    }
    expect(declarations(hub, '.hub__wash').display).toBe('none');
    expect(declarations(hub, homeShell).isolation).toBe('isolate');
    // Workspace warm light still reads its live pane width from .split.
    expect(declarations(readStyle('shell.css'), '.split::after').inset)
      .toContain('--project-chat-panel-width');
  });

  it('centres the body-portalled confirmation and uses product overlay tokens', () => {
    const backdrop = declarations(hub, '.hub-delete-backdrop');
    expect(backdrop.position).toBe('fixed');
    expect(backdrop.inset).toBe('0');
    expect(backdrop['place-items']).toBe('center');
    expect(backdrop.background).toBe('var(--scrim)');
    expect(Number(backdrop['z-index'])).toBeGreaterThan(80);
    expect(declarations(hub, '.hub-delete-confirm').background).toBe('var(--hub-glass-fill-strong)');
    const fallback = declarations(hub, '.hub-delete-confirm', '(prefers-reduced-transparency: reduce)');
    expect(fallback.background).toBe('var(--bg-panel)');
    expect(fallback['backdrop-filter']).toBe('none');
  });
});
