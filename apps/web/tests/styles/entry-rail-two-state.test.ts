// @vitest-environment jsdom

// Exercise the shipped shell grid, not the retired EntryNavRail layout.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { clampHubRailWidth } from '../../src/components/hub/HubHome';

const styles = resolve(process.cwd(), 'src/styles');
const shellCss = readFileSync(resolve(styles, 'shell.css'), 'utf8');
const entryLayoutCss = readFileSync(resolve(styles, 'home/entry-layout.css'), 'utf8');
const hubCss = readFileSync(resolve(styles, 'home/hub.css'), 'utf8');
const projectRailCss = readFileSync(resolve(styles, 'home/project-rail.css'), 'utf8');
const SHARED_COLLAPSED = Number.parseFloat(/--project-rail-collapsed:\s*([\d.]+)px/.exec(projectRailCss)?.[1] ?? '');
const SHARED_EXPANDED = Number.parseFloat(/--project-rail-expanded:\s*([\d.]+)px/.exec(projectRailCss)?.[1] ?? '');

function substituteVars(value: string, element: HTMLElement, depth = 0): string {
  if (depth > 8) throw new Error(`Custom property chain did not terminate: ${value}`);
  const next = value.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/g,
    (_match, property: string, fallback: string | undefined) => {
      for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        const inherited = getComputedStyle(node).getPropertyValue(property).trim();
        if (inherited) return inherited;
      }
      const declared = new RegExp(`${property}:\\s*([^;]+);`).exec(projectRailCss)?.[1];
      if (declared) return declared.trim();
      if (fallback) return fallback.trim();
      throw new Error(`Could not resolve ${property}`);
    });
  return next === value ? next : substituteVars(next, element, depth + 1);
}

function resolvedFirstTrack(element: HTMLElement): number {
  const value = substituteVars(getComputedStyle(element).gridTemplateColumns, element);
  const first = value.trim().split(/\s+(?![^(]*\))/)[0] ?? '';
  if (!first.endsWith('px')) throw new Error(`Not a pixel rail track: ${value}`);
  return Number.parseFloat(first);
}

function mount(state: 'collapsed' | 'expanded', width?: number) {
  const host = document.createElement('div');
  host.className = 'workspace-shell__body';
  if (width !== undefined) host.style.setProperty('--hub-rail-expanded', `${width}px`);
  host.innerHTML = `
    <nav class="hub__nav" data-project-rail="hub" data-project-rail-state="${state}"></nav>
    <div class="hub__rail-resizer"></div>
    <div data-surface="hub"><div class="entry-shell entry-shell--no-header"><div class="entry">
      <main class="entry-main"><div class="hub"><div class="hub__stage"></div></div></main>
    </div></div></div>`;
  document.body.append(host);
  return host;
}

beforeAll(() => {
  const style = document.createElement('style');
  style.textContent = `${projectRailCss}\n${shellCss}\n${entryLayoutCss}\n${hubCss}`;
  document.head.append(style);
});

describe('project rail: exactly two persistent shell states', () => {
  it('reserves the non-zero shared collapsed strip', () => {
    const host = mount('collapsed');
    expect(SHARED_COLLAPSED).toBe(44);
    expect(resolvedFirstTrack(host)).toBe(SHARED_COLLAPSED);
    host.remove();
  });

  it('resolves the expanded state to the shared full panel width', () => {
    const host = mount('expanded');
    expect(SHARED_EXPANDED).toBe(292);
    expect(resolvedFirstTrack(host)).toBe(SHARED_EXPANDED);
    expect(resolvedFirstTrack(host)).toBeGreaterThan(SHARED_COLLAPSED);
    host.remove();
  });

  it('resolves both states through the single shared token declarations', () => {
    expect(shellCss).toContain('var(--hub-rail-expanded, var(--project-rail-expanded))');
    expect(shellCss).toContain('grid-template-columns: var(--project-rail-collapsed)');
    expect(entryLayoutCss).not.toMatch(/--entry-rail-(?:width|strip-width):/);
    expect([...projectRailCss.matchAll(/--project-rail-expanded:/g)]).toHaveLength(1);
    expect([...projectRailCss.matchAll(/--project-rail-collapsed:/g)]).toHaveLength(1);
  });

  it('keeps only content in the second track and drops the local Hub/entry rail tracks', () => {
    const host = mount('expanded');
    expect(getComputedStyle(host.querySelector('[data-surface]')!).gridColumn).toBe('2');
    expect(getComputedStyle(host.querySelector('.entry')!).gridTemplateColumns).toBe('minmax(0, 1fr)');
    expect(getComputedStyle(host.querySelector('.hub')!).gridTemplateColumns).toBe('minmax(0, 1fr)');
    expect(getComputedStyle(host.querySelector('.hub__stage')!).gridColumn).toBe('1');
    host.remove();
  });

  it('uses the resized shell width on either route without changing collapsed width', () => {
    const host = mount('expanded', 377);
    expect(resolvedFirstTrack(host)).toBe(377);
    host.querySelector('[data-surface]')!.setAttribute('data-surface', 'project:p1');
    expect(resolvedFirstTrack(host)).toBe(377);
    host.querySelector('[data-project-rail]')!.setAttribute('data-project-rail-state', 'collapsed');
    expect(resolvedFirstTrack(host)).toBe(44);
    host.remove();
  });

  it('clamps expanded drag to [262, 420], never to a collapsed or absent state', () => {
    expect(clampHubRailWidth(-9000)).toBe(262);
    expect(clampHubRailWidth(261)).toBe(262);
    expect(clampHubRailWidth(9000)).toBe(420);
    expect(clampHubRailWidth(421)).toBe(420);
    expect(clampHubRailWidth(SHARED_EXPANDED)).toBe(SHARED_EXPANDED);
    expect(clampHubRailWidth(377.4)).toBe(377);
    expect(clampHubRailWidth(262)).toBeGreaterThan(SHARED_COLLAPSED * 4);
  });

  it('keeps the resizer outside the clipped rail and keyed content, on the shared width', () => {
    const host = mount('expanded');
    const resizer = host.querySelector('.hub__rail-resizer')!;
    expect(resizer.parentElement).toBe(host);
    expect(getComputedStyle(host).position).toBe('relative');
    expect(getComputedStyle(resizer).position).toBe('absolute');
    expect(getComputedStyle(resizer).insetInlineStart).toContain('var(--hub-rail-expanded');
    expect(getComputedStyle(resizer).insetInlineStart).toContain('- 4px');
    host.remove();
  });

  it('keeps the collapsed strip interactive and removes the floating workspace toggle', () => {
    const host = mount('collapsed');
    expect(getComputedStyle(host.querySelector('[data-project-rail]')!).pointerEvents).toBe('auto');
    expect(shellCss).not.toMatch(/\.entry-rail-toggle--workspace\s*\{[^}]*position:\s*absolute/);
    host.remove();
  });

  it('animates only track width with the product duration and easing', () => {
    const rule = /\.workspace-shell__body\s*\{([^}]*)\}/.exec(shellCss)?.[1] ?? '';
    expect(rule).toMatch(/transition:\s*grid-template-columns\s+var\(--dur-enter\)\s+var\(--ease-out\)/);
    expect(rule).not.toMatch(/transition:[^;]*opacity/);
  });

  it('disables track movement under reduced motion', () => {
    expect(shellCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.workspace-shell__body\s*\{\s*transition:\s*none/);
  });
});
