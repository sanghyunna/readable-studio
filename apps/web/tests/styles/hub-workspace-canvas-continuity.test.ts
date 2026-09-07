// @vitest-environment jsdom

/**
 * The Hub -> workspace swap "blinks once, like entering a new window".
 *
 * A one-shot entrance animation on the incoming surface
 * (`WorkspaceTransition.module.css`) cannot fix that, because the blink is not
 * the surface: it is the CANVAS UNDERNEATH the surface changing identity in a
 * single frame. Three independent paints produced it, and this file pins all
 * three as computed-cascade facts rather than as string greps:
 *
 *  1. `.workspace-shell` declared `background: var(--bg-app)` and only swapped
 *     to the shared `--hub-canvas-background` through a `:has()` match on the
 *     Home body. Leaving Home therefore dropped the match and repainted the
 *     whole window from the radial canvas to a flat solid — the shell itself
 *     blinked, beneath whatever the child was animating.
 *  2. `.app` (the ProjectView root) painted its own opaque `var(--bg-app)`, so
 *     even a continuous shell canvas could not survive to the eye: the
 *     workspace covered it with a solid slab on arrival.
 *  3. The pending-project route (`.readable-loading-shell`) painted a THIRD,
 *     unrelated opaque canvas at full viewport height between the two
 *     surfaces. That is a literal blank frame, and it is on the hot path every
 *     time a project route resolves before `ProjectView` mounts.
 *
 * Continuity here means exactly one canvas is painted for the whole session
 * and every surface that rides on it is transparent, so no boundary exists to
 * flash. jsdom resolves the real author cascade, so a selector that stops
 * matching (the exact defect in 1) fails these tests instead of passing them.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

const styles = resolve(process.cwd(), 'src/styles');
const shellCss = readFileSync(resolve(styles, 'shell.css'), 'utf8');
const baseCss = readFileSync(resolve(styles, 'base.css'), 'utf8');
const entryLayoutCss = readFileSync(resolve(styles, 'home/entry-layout.css'), 'utf8');

/**
 * Mounts the shell exactly as App.tsx renders it for one surface, with the real
 * stylesheets applied, and returns the resolved background of each layer the
 * user actually sees stacked at the window origin.
 */
function paintedStack(surface: 'hub' | 'workspace' | 'pending'): {
  shell: string;
  root: string;
} {
  document.head.innerHTML = '';
  document.body.innerHTML = '';

  for (const css of [shellCss, baseCss, entryLayoutCss]) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  const body =
    surface === 'hub'
      ? `<div class="entry-shell entry-shell--no-header">
           <div class="entry">
             <div class="entry-main entry-main--scroll">
               <div class="entry-main__inner entry-main__inner--home">
                 <div data-testid="entry-view-home"></div>
               </div>
             </div>
           </div>
         </div>`
      : surface === 'workspace'
        ? `<div class="entry-shell entry-shell--no-header entry-shell--workspace">
             <div class="entry">
               <div class="entry-main entry-main--workspace">
                 <div class="app" data-testid="project-root"></div>
               </div>
             </div>
           </div>`
        : `<div class="readable-loading-shell readable-loading-shell--surface" role="status" data-testid="project-route-loading"></div>`;

  document.body.innerHTML = `
    <div class="workspace-shell workspace-shell--desktop">
      <header class="app-chrome-header app-window-chrome"></header>
      <div class="workspace-shell__body">
        <div data-surface="${surface}">${body}</div>
      </div>
    </div>`;

  const shell = document.querySelector('.workspace-shell') as HTMLElement;
  const rootSelector =
    surface === 'hub'
      ? '.entry-main__inner--home'
      : surface === 'workspace'
        ? '.app'
        : '.readable-loading-shell';
  const root = document.querySelector(rootSelector) as HTMLElement;

  return {
    shell: getComputedStyle(shell).background || getComputedStyle(shell).backgroundImage,
    root: getComputedStyle(root).background || getComputedStyle(root).backgroundColor,
  };
}

beforeAll(() => {
  // jsdom resolves the cascade but not custom properties, so the assertions
  // below compare the WINNING DECLARATION text. That is precisely the axis the
  // defect lived on: the correct value was present the whole time, it just lost
  // the match when the surface changed.
});

describe('Hub <-> workspace canvas continuity', () => {
  it('paints the shared canvas on the shell for the workspace, not only for Home', () => {
    const hub = paintedStack('hub');
    const workspace = paintedStack('workspace');

    // The shell is the element spanning BOTH grid rows for BOTH surfaces. If
    // its canvas differs between them, the window repaints on the swap and the
    // user sees one blink no matter what the incoming child animates.
    expect(workspace.shell).toContain('--hub-canvas-background');
    expect(workspace.shell).toBe(hub.shell);
  });

  it('never repaints the shell canvas as a flat solid on any surface', () => {
    // The original `.workspace-shell { background: var(--bg-app) }` is what the
    // Home `:has()` was overriding. A base declaration that still resolves to a
    // flat solid means the swap is a hard colour cut whenever any future
    // surface fails to match the Home condition.
    const base = /\.workspace-shell\s*\{[^}]*\}/.exec(shellCss)?.[0] ?? '';
    expect(base).not.toMatch(/background:\s*var\(--bg-app\)/);
    expect(base).toMatch(/background:\s*var\(--hub-canvas-background\)/);
  });

  it('keeps the workspace surface roots transparent so the shared canvas shows through', () => {
    const workspace = paintedStack('workspace');

    // `.app` painting its own opaque fill re-creates the blink one layer down:
    // the shell canvas would be continuous but invisible behind a solid slab
    // that appears in the same frame the workspace mounts.
    expect(workspace.root).not.toMatch(/var\(--bg-app\)/);
    expect(workspace.root).toMatch(/transparent|^$|rgba\(0, 0, 0, 0\)/);
  });

  it('paints no opaque interstitial canvas on the pending-project route', () => {
    // The fixture must render the class App.tsx actually emits, or this test
    // measures a variant nothing ships. Read it from the source rather than
    // restating it.
    const appTsx = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    const emitted = /className="(readable-loading-shell[^"]*)"/.exec(appTsx)?.[1];
    expect(emitted).toBe('readable-loading-shell readable-loading-shell--surface');

    const pending = paintedStack('pending');

    // This is the blank frame itself. The pending route keeps project surface
    // identity (do not regress that), but it must not paint its own full-height
    // canvas between the two surfaces.
    expect(pending.root).not.toMatch(/var\(--black\)/);
    expect(pending.root).not.toMatch(/radial-gradient/);
  });

  it('collapses the canvas for every surface under reduced transparency, not only Home', () => {
    const hubCss = readFileSync(resolve(styles, 'home/hub.css'), 'utf8');
    const start = hubCss.lastIndexOf('@media (prefers-reduced-transparency: reduce)');
    expect(start).toBeGreaterThan(-1);
    const block = hubCss.slice(start);
    // The rule that repaints the SHELL. Anchored on `.workspace-shell` so it
     // cannot accidentally match `.hub__stage` or the topbar rule, which also
     // fall back to `--hub-canvas` but are not the continuous canvas layer.
    const fallback =
      /((?:[^{}]*\.workspace-shell[^{}]*))\{\s*background:\s*var\(--hub-canvas\)\s*;?\s*\}/.exec(
        block,
      )?.[1] ?? '';
    // Comments are not selectors; drop them before splitting.
    const selectorText = fallback.replace(/\/\*[\s\S]*?\*\//g, '');

    // The shell paints the shared gradient unconditionally now. A fallback
    // scoped to Home alone would flatten the Hub while leaving the workspace
    // on the gradient - reintroducing the exact one-frame repaint this work
    // removes, for the users least able to tolerate it.
    const selectors = selectorText.split(',').map((part) => part.trim());
    expect(selectors).toContain('.workspace-shell');
    // The Home-scoped selector must remain too: other tests pin it, and it is
    // what keeps the fallback correct if the base rule is ever re-scoped.
    expect(selectors).toContain(
      '.workspace-shell:has(> .workspace-shell__body .entry-main__inner--home)',
    );
  });

  it('keeps the standalone boot shell opaque — only the in-app route variant is transparent', () => {
    // `.readable-loading-shell` is ALSO the pre-mount boot shell rendered by
    // app/[[...slug]]/client-app.tsx, where there is no canvas behind it yet.
    // Making the base class transparent would replace the blink with an actual
    // white screen at startup, so the transparent behaviour must be scoped to
    // the in-app variant only.
    const boot = /\.readable-loading-shell\s*\{[^}]*\}/.exec(baseCss)?.[0] ?? '';
    expect(boot).toMatch(/background:/);
    expect(boot).toMatch(/var\(--black\)/);
  });
});
