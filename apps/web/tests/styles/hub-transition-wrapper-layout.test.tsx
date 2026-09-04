// @vitest-environment jsdom

// Header-less Hub layout must survive the transition wrapper.
//
// App.tsx mounts a keyed wrapper (`WorkspaceTransition.module.css` `.surface`)
// between `.workspace-shell__body` and the view root so the Hub <-> workspace
// swap can animate. entry-layout.css hides the tabs chrome row and collapses
// the shell to a single grid row via a `:has()` condition on the Hub surface.
// When that condition was written as a direct child it stopped matching the
// moment the wrapper appeared, which re-showed the chrome row and shifted the
// Hub grid.
//
// These assertions run against the DOM the app actually renders and against
// the condition text pulled out of the shipped stylesheet, so neither a
// selector regression nor a DOM restructure can pass silently.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Under the jsdom environment `import.meta.url` is not a file: URL, so the
// stylesheets are resolved from the vitest root (apps/web) instead.
const entryLayoutCss = readFileSync(
  resolve(process.cwd(), 'src/styles/home/entry-layout.css'),
  'utf8',
);
const transitionCss = readFileSync(
  resolve(process.cwd(), 'src/components/WorkspaceTransition.module.css'),
  'utf8',
);

/**
 * The `:has()` argument exactly as shipped. Reading it from the stylesheet
 * (rather than restating it here) means the test exercises the real selector.
 */
function hubCondition(): string {
  const match = /\.workspace-shell:has\(([^)]+)\)\s*\{\s*grid-template-rows/.exec(entryLayoutCss);
  if (!match?.[1]) throw new Error('Missing header-less Hub :has() rule in entry-layout.css');
  return match[1].trim();
}

/** The chrome-row rule's `:has()` argument, which must stay in lockstep. */
function chromeRowCondition(): string {
  const match = /\.workspace-shell:has\(([^)]+)\)\s*>\s*\.workspace-tabs-chrome/.exec(
    entryLayoutCss,
  );
  if (!match?.[1]) throw new Error('Missing chrome-row :has() rule in entry-layout.css');
  return match[1].trim();
}

/**
 * The shell App.tsx renders. `surface` mirrors the keyed transition wrapper;
 * `view` picks the Hub (header-less entry) or a project workspace.
 */
function shell(options: { surface: boolean; view: 'hub' | 'workspace' }): HTMLElement {
  const root = document.createElement('div');
  root.className = 'workspace-shell';

  const chrome = document.createElement('div');
  chrome.className = 'workspace-tabs-chrome';
  root.append(chrome);

  const body = document.createElement('div');
  body.className = 'workspace-shell__body';
  root.append(body);

  const viewRoot = document.createElement('div');
  viewRoot.className =
    options.view === 'hub' ? 'entry-shell entry-shell--no-header' : 'app';

  if (options.surface) {
    const wrapper = document.createElement('div');
    wrapper.className = 'surface';
    wrapper.append(viewRoot);
    body.append(wrapper);
  } else {
    body.append(viewRoot);
  }

  return root;
}

/** Does the shipped `:has()` condition select anything in this shell? */
function conditionMatches(root: HTMLElement, condition: string): boolean {
  return root.querySelector(`:scope ${condition}`) !== null;
}

describe('header-less Hub layout through the transition wrapper', () => {
  it('matches the Hub rendered inside the transition wrapper', () => {
    // This is the DOM shipped today. Before the fix this was false, which is
    // exactly what re-showed the chrome row and shifted the grid.
    const root = shell({ surface: true, view: 'hub' });

    expect(conditionMatches(root, hubCondition())).toBe(true);
    expect(conditionMatches(root, chromeRowCondition())).toBe(true);
  });

  it('still matches a Hub mounted without the wrapper', () => {
    // The fix must not be depth-locked the other way: a Hub rendered as a
    // direct child (no transition wrapper) must keep the same layout.
    const root = shell({ surface: false, view: 'hub' });

    expect(conditionMatches(root, hubCondition())).toBe(true);
    expect(conditionMatches(root, chromeRowCondition())).toBe(true);
  });

  it('does not match a workspace surface, so the chrome row returns in a project', () => {
    const root = shell({ surface: true, view: 'workspace' });

    expect(conditionMatches(root, hubCondition())).toBe(false);
    expect(conditionMatches(root, chromeRowCondition())).toBe(false);
  });

  it('keeps the chrome-row and grid-row rules on one identical condition', () => {
    // Two rules, one condition. If they ever diverge the chrome row and the
    // grid height can disagree, which is the exact bug this replaced.
    expect(chromeRowCondition()).toBe(hubCondition());
  });

  it('states the Hub layout rules in exactly one stylesheet', () => {
    // The transition module used to restate both rules at the wrapper depth as
    // a workaround. entry-layout.css owns them now; a copy would drift.
    expect(transitionCss).not.toMatch(/entry-shell--no-header/);
    expect(transitionCss).not.toMatch(/workspace-tabs-chrome/);

    const hubRules = entryLayoutCss.match(
      /\.workspace-shell:has\([^)]+\)\s*(?:>\s*\.workspace-tabs-chrome\s*)?\{/g,
    );
    expect(hubRules).toHaveLength(2);
  });
});
