// @vitest-environment jsdom

/**
 * The desktop window is frameless, so `.app-window-chrome` IS the title bar and
 * its `.app-window-chrome__drag` filler is a live `-webkit-app-region: drag`
 * surface painted at `z-index: 120`. Anything that renders underneath that band
 * is not merely obscured - the drag surface eats its clicks outright, and the
 * control becomes unusable with no visual hint that anything is wrong.
 *
 * Two independent defects produced exactly that, and this file pins both:
 *
 *  1. `.app-chrome-header` (the taller 48px project chrome) is declared LATER in
 *     shell.css than `.app-window-chrome` and shares the same element. At equal
 *     specificity source order wins, so its `min-height: 48px` beat the strip's
 *     `height: 36px`; the band overflowed its 36px grid row by 12px and covered
 *     the top of the surface below.
 *  2. The rail toggle used to float against the viewport, allowing its box to
 *     enter the title bar. It is now an in-flow child of the rail header, which
 *     itself lives in the shell body's second grid row.
 *
 * These are geometric facts, so the assertions are geometric: the real
 * stylesheets are loaded into jsdom and `getComputedStyle` resolves the actual
 * author cascade, then the resulting boxes are compared numerically. A test that
 * merely grepped for `36px` would have passed all the way through defect 1,
 * because the losing declaration was present and correct the entire time.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// Under the jsdom environment `import.meta.url` is not a file: URL, so the
// stylesheets are resolved from the package root instead.
const styles = resolve(process.cwd(), 'src/styles');
const shellCss = readFileSync(resolve(styles, 'shell.css'), 'utf8');
const projectRailCss = readFileSync(resolve(styles, 'home/project-rail.css'), 'utf8');
const hubCss = readFileSync(resolve(styles, 'home/hub.css'), 'utf8');
const entryLayoutCss = readFileSync(resolve(styles, 'home/entry-layout.css'), 'utf8');

/**
 * jsdom resolves the CASCADE (which declaration wins) but does not evaluate
 * `var()` or `calc()`. The cascade is precisely what defect 1 broke, so the
 * winning declaration is read from `getComputedStyle` and only its arithmetic is
 * evaluated here.
 */
function px(value: string): number {
  const chromeHeight = readChromeHeightToken();
  // Substitute the one custom property this geometry depends on, then fold the
  // `calc(<px> + <px>)` shape the offsets use.
  const substituted = value.replace(
    /var\(--app-window-chrome-height(?:,\s*([^)]+))?\)/g,
    (_match, fallback: string | undefined) => `${chromeHeight ?? Number.parseFloat(fallback ?? '')}px`,
  );
  const calc = substituted.match(/^calc\(\s*([\d.]+)px\s*\+\s*([\d.]+)px\s*\)$/);
  if (calc) return Number.parseFloat(calc[1] as string) + Number.parseFloat(calc[2] as string);
  const parsed = Number.parseFloat(substituted);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** The single source of truth both the band and the toggle offset read. */
function readChromeHeightToken(): number | null {
  const declared = shellCss.match(/--app-window-chrome-height:\s*([\d.]+)px/);
  return declared ? Number.parseFloat(declared[1] as string) : null;
}

function reservedChromeTrack(element: HTMLElement): number {
  const rows = getComputedStyle(element).gridTemplateRows;
  const firstTrack = rows.match(/^var\(--app-window-chrome-height(?:,[^)]+)?\)/)?.[0] ?? '';
  return px(firstTrack);
}

let shell: HTMLElement;
let chrome: HTMLElement;
let body: HTMLElement;
let toggle: HTMLElement;

beforeAll(() => {
  const style = document.createElement('style');
  // The sheets that own this geometry, concatenated in their real @import order
  // so both the shell.css-internal source-order conflict and entry-layout.css's
  // later grid override are reproduced exactly as they reach the browser.
  style.textContent = `${shellCss}\n${projectRailCss}\n${entryLayoutCss}\n${hubCss}`;
  document.head.append(style);

  document.body.innerHTML = `
    <div class="workspace-shell workspace-shell--desktop">
      <header class="app-chrome-header app-window-chrome" data-testid="app-window-chrome">
        <div class="window-controls" data-testid="window-controls"></div>
        <div class="app-window-chrome__drag app-chrome-drag"></div>
      </header>
      <div class="workspace-shell__body">
        <main class="entry-main--scroll">
          <div class="entry-main__inner entry-main__inner--home">
            <div class="hub">
              <nav class="hub__nav" data-project-rail="hub" data-project-rail-state="expanded">
                <div class="hub__nav-head">
                  <button class="hub__rail-toggle" data-project-rail-toggle data-testid="hub-rail-toggle"></button>
                </div>
              </nav>
            </div>
          </nav>
        </div>
      </div>
    </div>
  `;

  shell = document.querySelector('.workspace-shell') as HTMLElement;
  chrome = document.querySelector('.app-window-chrome') as HTMLElement;
  body = document.querySelector('.workspace-shell__body') as HTMLElement;
  toggle = document.querySelector('.hub__rail-toggle') as HTMLElement;
});

describe('frameless window chrome drag clearance', () => {
  it('keeps the drag band pinned to the height its grid row reserves', () => {
    // `.app-chrome-header` also matches this element and declares `min-height:
    // 48px` further down the same file. If the override is ever removed or
    // demoted, `min-height` re-inflates the band and it overflows the row.
    const height = px(getComputedStyle(chrome).height);
    const minHeight = px(getComputedStyle(chrome).minHeight);

    expect(height).toBe(36);
    // The real defect: an over-tall MINIMUM, not an over-tall height.
    expect(minHeight).toBeLessThanOrEqual(36);
  });

  it('keeps the Hub rail toggle in flow below the reserved drag-band row', () => {
    const bandBottom = Math.max(
      px(getComputedStyle(chrome).height),
      px(getComputedStyle(chrome).minHeight),
    );
    const bodyTop = reservedChromeTrack(shell);

    // Static positioning is the shared ProjectRail contract: because the rail
    // is inside the shell body (the second grid child), its control cannot
    // escape upward into the first-row drag surface via viewport offsets.
    expect(getComputedStyle(toggle).position).toBe('static');
    expect(shell.children[1]).toBe(body);
    expect(body.contains(toggle)).toBe(true);
    expect(bodyTop).toBeGreaterThanOrEqual(bandBottom);
  });

  it('leaves no vertical overlap between the drag band and the in-flow rail toggle', () => {
    // jsdom has no layout engine, so derive the body's real top boundary from
    // the winning first grid track rather than reading a fabricated offset from
    // a static element. This stays numeric and fails if the reserved row stops
    // resolving, if the band outgrows it, or if the toggle becomes floating.
    const bandTop = 0;
    const bandBottom = Math.max(
      px(getComputedStyle(chrome).height),
      px(getComputedStyle(chrome).minHeight),
    );
    const toggleTop = reservedChromeTrack(shell);
    const toggleBottom = toggleTop + px(getComputedStyle(toggle).height);

    expect(Number.isFinite(toggleTop)).toBe(true);
    expect(Number.isFinite(toggleBottom)).toBe(true);
    expect(getComputedStyle(toggle).position).toBe('static');
    const overlap = Math.min(bandBottom, toggleBottom) - Math.max(bandTop, toggleTop);
    expect(overlap).toBeLessThanOrEqual(0);
  });

  it('reserves exactly the band height in the shell grid row', () => {
    // If the row and the band ever disagree, the strip either overflows onto the
    // surface below (the original bug) or leaves a dead gap. Both read the token.
    const rows = getComputedStyle(shell).gridTemplateRows;
    expect(rows).toContain('var(--app-window-chrome-height)');
    expect(readChromeHeightToken()).toBe(36);
  });

  it('still reserves the band on header-less entry surfaces', () => {
    // Entry surfaces drop the TABS chrome row, and the rule that does so used to
    // collapse the shell to a single track. That put the title strip and the
    // body in the same cell: the body began at y=0 under the drag region, so the
    // sticky entry topbar pinned itself beneath it and lost every click. This is
    // a distinct element state from the fixture above, so it needs its own DOM.
    const host = document.createElement('div');
    host.innerHTML = `
      <div class="workspace-shell workspace-shell--web">
        <header class="app-chrome-header app-window-chrome"></header>
        <div class="workspace-shell__body">
          <div class="entry-shell entry-shell--no-header"></div>
        </div>
      </div>
    `;
    document.body.append(host);

    const shell = host.querySelector('.workspace-shell') as HTMLElement;
    const rows = getComputedStyle(shell).gridTemplateRows;

    // Two tracks, the first of which is the band - never a single collapsed row.
    expect(rows).toContain('var(--app-window-chrome-height, 36px)');
    expect(rows).toMatch(/minmax\(0,\s*1fr\)/);

    host.remove();
  });

  it('keeps the drag surface draggable and the traffic lights excluded from it', () => {
    // The fix must not have been bought by disabling the drag region: the strip
    // and its filler stay `drag`, and only the controls opt out.
    expect(shellCss).toMatch(/\.app-window-chrome\s*\{[^}]*-webkit-app-region:\s*drag/);
    expect(shellCss).toMatch(/\.app-window-chrome__drag\s*\{[^}]*-webkit-app-region:\s*drag/);
    expect(shellCss).toMatch(/\.window-controls\s*\{[^}]*-webkit-app-region:\s*no-drag/);

    // A pointer-events escape hatch would make the band unclickable AND
    // undraggable, which is why the fix restricts the box instead.
    const dragRule = shellCss.match(/\.app-window-chrome__drag\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(dragRule).not.toMatch(/pointer-events/);
  });
});
