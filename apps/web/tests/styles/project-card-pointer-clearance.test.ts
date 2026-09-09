// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss, { type Declaration, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const styles = resolve(process.cwd(), 'src/styles');
const shell = postcss.parse(readFileSync(resolve(styles, 'shell.css'), 'utf8'));
const entryLayout = postcss.parse(readFileSync(resolve(styles, 'home/entry-layout.css'), 'utf8'));
const drawer = postcss.parse(readFileSync(resolve(styles, 'workspace/drawer.css'), 'utf8'));

function ruleFor(root: postcss.Root, selector: string): Rule | undefined {
  let match: Rule | undefined;
  root.walkRules((rule) => {
    if (rule.parent === root && rule.selector === selector) match = rule;
  });
  return match;
}

function declaration(rule: Rule | undefined, property: string): Declaration | undefined {
  return rule?.nodes.find(
    (node): node is Declaration => node.type === 'decl' && node.prop === property,
  );
}

describe('project card pointer clearance from frameless chrome', () => {
  it('starts every scrollable entry surface below the native drag region', () => {
    const scrollViewport = ruleFor(
      entryLayout,
      '.entry-shell--no-header .entry-main--scroll:not(:has(.entry-main__inner--home))',
    );

    const entryShell = ruleFor(
      entryLayout,
      '.workspace-shell:has(> .workspace-shell__body .entry-shell--no-header)',
    );
    const body = ruleFor(shell, '.workspace-shell__body');

    // Clearance belongs to the shell's first grid track, outside the scroll
    // viewport. A second chrome-height margin would now double the gap.
    expect(declaration(entryShell, 'grid-template-rows')?.value).toBe(
      'var(--app-window-chrome-height, 36px) minmax(0, 1fr)',
    );
    expect(declaration(body, 'grid-row')?.value).toBe('2');
    expect(declaration(scrollViewport, 'margin-block-start')?.value).toBe('0');
  });

  it('prevents programmatic scrolling from placing controls under adjacent chrome', () => {
    const scrollViewport = ruleFor(entryLayout, '.entry-main--scroll');

    // `overflow-x: hidden` still creates a programmatically scrollable axis.
    // Playwright's actionability scroll could therefore move the far-right
    // kanban card under the neighbouring rail/logo even though no horizontal
    // scrollbar was painted.
    expect(declaration(scrollViewport, 'overflow-x')?.value).toBe('clip');
    expect(declaration(scrollViewport, 'scroll-padding-block-start')?.value).toBe(
      'var(--entry-topbar-h)',
    );
  });

  it('does not let empty sticky-topbar space consume the surface hit region', () => {
    const topbar = ruleFor(entryLayout, '.entry-main__topbar');
    const chips = ruleFor(entryLayout, '.entry-main__topbar-chips');

    expect(declaration(topbar, 'padding')?.value).toBe('12px 16px 0');
    expect(declaration(topbar, 'pointer-events')?.value).toBe('none');
    expect(declaration(chips, 'pointer-events')?.value).toBe('auto');
  });

  it('keeps the kanban action reachable without requiring pointer hover first', () => {
    const action = ruleFor(drawer, '.design-kanban-card .design-card-close');
    const cardName = ruleFor(drawer, '.design-kanban-card-name');

    expect(declaration(action, 'opacity')?.value).toBe('1');
    expect(declaration(action, 'pointer-events')?.value).toBe('auto');
    expect(declaration(cardName, 'pointer-events')).toMatchObject({ value: 'none' });
  });
});
