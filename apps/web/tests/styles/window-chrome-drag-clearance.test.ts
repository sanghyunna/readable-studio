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
 *  2. The rail toggle once lived in that title row through a portalled chrome
 *     slot. It now belongs to the rail's own brand row BELOW the band, and the
 *     slot is gone: the strip holds only the drag filler and the traffic
 *     lights, so no rail control can ever sit under the drag surface.
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
  // Resolve the shell origin and any rail-local inset from their real tokens,
  // then fold the `calc(<px> + <px>)` shape the offsets use.
  const substituted = value.replace(
    /var\(--app-window-chrome-height(?:,\s*([^)]+))?\)/g,
    (_match, fallback: string | undefined) => `${chromeHeight ?? Number.parseFloat(fallback ?? '')}px`,
  ).replace(
    /var\(--project-rail-inset\)/g,
    () => projectRailCss.match(/--project-rail-inset:\s*([\d.]+px)/)?.[1] ?? '',
  );
  const calc = substituted.match(/^calc\(\s*([\d.]+)px\s*\+\s*([\d.]+)px\s*\)$/);
  if (calc) return Number.parseFloat(calc[1] as string) + Number.parseFloat(calc[2] as string);
  const parsed = Number.parseFloat(substituted);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** The single source of truth for the band and the shell's content origin. */
function readChromeHeightToken(): number | null {
  const declared = shellCss.match(/--app-window-chrome-height:\s*([\d.]+)px/);
  return declared ? Number.parseFloat(declared[1] as string) : null;
}

let shell: HTMLElement;
let chrome: HTMLElement;
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
        <div class="app-window-chrome__drag app-chrome-drag"></div>
        <div class="window-controls" data-testid="window-controls"></div>
      </header>
      <div class="workspace-shell__body">
        <nav class="hub__nav" data-project-rail="hub" data-project-rail-state="expanded">
          <div class="hub__nav-head" data-project-rail-head>
            <button class="hub__brand"></button>
            <button class="hub__rail-toggle" data-project-rail-toggle data-testid="hub-rail-toggle"></button>
          </div>
        </nav>
        <div data-surface="home:home">
          <main class="entry-main--scroll">
            <div class="entry-main__inner entry-main__inner--home">
              <div class="hub"></div>
            </div>
          </main>
        </div>
      </div>
    </div>
  `;

  shell = document.querySelector('.workspace-shell') as HTMLElement;
  chrome = document.querySelector('.app-window-chrome') as HTMLElement;
  toggle = document.querySelector('.hub__rail-toggle') as HTMLElement;
});

describe('frameless window chrome drag clearance', () => {
  it('paints a faint canvas veil on the titlebar, continuous with the shared canvas behind it', () => {
    const chromeStyle = getComputedStyle(chrome);
    const homeScroll = document.querySelector('.entry-main--scroll') as HTMLElement;

    // The veil is a gradient only: no background-color slab, no border, no
    // shadow. The later shared `.app-chrome-header { background: var(--bg) }`
    // must still lose this cascade - that was the opaque white bar.
    expect(chromeStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(chromeStyle.borderBottomWidth).toBe('0px');
    expect(chromeStyle.boxShadow).toBe('none');

    // One gradient recipe belongs to the shell containing BOTH grid rows. The
    // body is paintless, so there is no seam or restarted gradient at y=36.
    expect(entryLayoutCss).toMatch(
      /\.workspace-shell:has\(> \.workspace-shell__body \.entry-main__inner--home\)\s*\{[^}]*background:\s*var\(--hub-canvas-background\)/s,
    );
    const recipesCss = readFileSync(resolve(styles, 'themes/recipes.css'), 'utf8');
    expect(recipesCss).toMatch(
      /--hub-canvas-background:\s*radial-gradient\(1100px 640px at 10% -8%[\s\S]*?var\(--hub-canvas-base\);/,
    );
    expect(getComputedStyle(homeScroll).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(entryLayoutCss).toMatch(
      /\.entry-main--scroll:has\(\.entry-main__inner--home\)\s*\{[^}]*background:\s*transparent/s,
    );
  });

  it('flattens the veil to the same opaque canvas token under reduced transparency', () => {
    const reducedChrome = shellCss.match(
      /@media \(prefers-reduced-transparency: reduce\)\s*\{[\s\S]*?\.app-chrome-header\.app-window-chrome\s*\{([^}]*)\}/,
    )?.[1] ?? '';
    // The veil cannot refract when transparency is reduced, so the strip takes
    // the shell's own flat fallback token - the SAME paint the shell canvas
    // collapses to, which keeps the band continuous instead of resurrecting a
    // separate strip, and it resolves opaque rather than dropping the veil to
    // bare transparency.
    expect(reducedChrome).toMatch(/background:\s*var\(--hub-canvas\)/);
    expect(reducedChrome).not.toMatch(/background:\s*transparent/);
    expect(hubCss).toMatch(
      /@media \(prefers-reduced-transparency: reduce\)[\s\S]*?\.workspace-shell:has\(> \.workspace-shell__body \.entry-main__inner--home\),\s*\.hub\s*\{[^}]*background:\s*var\(--hub-canvas\)/,
    );
  });

  it('veils the titlebar with the shared canvas top-edge order at one calibrated alpha step', () => {
    // The strip was fully transparent (alpha 0): the canvas showed through
    // untouched. The veil is a single material step MORE opaque than that -
    // built from the canvas's own top-edge stops, never a new palette:
    // `--hub-canvas-blue` at the rail end, `--hub-canvas-pink` at the content
    // end, the same accent -> warm order the wash blooms paint below the band
    // (accent upper-left over the rail, warm toward the pane boundary).
    const chromeRule = shellCss.match(
      /\.app-chrome-header\.app-window-chrome\s*\{([^}]*)\}/,
    )?.[1] ?? '';
    const background = /(?:^|[;\n])\s*background:\s*([^;]+);/.exec(chromeRule)?.[1]?.trim() ?? '';

    expect(background).toContain('linear-gradient(');
    // Order: the blue (accent-side) stop is declared before the pink
    // (warm-side) stop, matching the canvas's top edge and the wash order.
    const blueIndex = background.indexOf('var(--hub-canvas-blue)');
    const pinkIndex = background.indexOf('var(--hub-canvas-pink)');
    expect(blueIndex).toBeGreaterThanOrEqual(0);
    expect(pinkIndex).toBeGreaterThan(blueIndex);
    // Placement: the stops sit at the canvas blooms' own x-positions (10% /
    // 92%), so the veil continues the shared canvas instead of re-rolling a
    // generic 0 -> 100 sweep.
    expect(background).toMatch(/var\(--hub-canvas-blue\)[^)]*\)\s*10%/);
    expect(background).toMatch(/var\(--hub-canvas-pink\)[^)]*\)\s*92%/);

    // Alpha: one calibrated step. Both stops share a single mix ratio that is
    // measurably above the old transparent band (0%) and slightly so - well
    // under halfway, never an opaque bar.
    const ratios = [...background.matchAll(/color-mix\(in srgb,\s*var\(--hub-canvas-(?:blue|pink)\)\s*(\d+)%/g)].map(
      (match) => Number(match[1]),
    );
    expect(ratios).toHaveLength(2);
    expect(ratios[0]).toBe(ratios[1]);
    expect(ratios[0]!).toBeGreaterThan(0);
    expect(ratios[0]!).toBeLessThanOrEqual(40);

    // Tokens only: no raw color literals in the veil.
    expect(background).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i);
  });

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

  it('keeps the title row to the drag filler and the traffic lights - the rail toggle is not in it', () => {
    const traffic = chrome.querySelector('.window-controls') as HTMLElement;

    expect(chrome.querySelector('.app-window-chrome__rail-toggle')).toBeNull();
    expect(document.getElementById('app-window-chrome-rail-toggle')).toBeNull();
    expect(chrome.contains(toggle)).toBe(false);
    expect(chrome.children).toHaveLength(2);
    expect(chrome.children[0]).toBe(chrome.querySelector('.app-window-chrome__drag'));
    expect(chrome.children[1]).toBe(traffic);
  });

  it.each(['expanded', 'collapsed'] as const)(
    'keeps the %s rail toggle below the 36px band at its full hit target',
    (state) => {
      const head = toggle.parentElement as HTMLElement;
      const rail = head.parentElement as HTMLElement;
      const body = rail.parentElement as HTMLElement;
      rail.dataset.projectRailState = state;

      const shellStyle = getComputedStyle(shell);
      const bodyStyle = getComputedStyle(body);
      const railStyle = getComputedStyle(rail);
      const headStyle = getComputedStyle(head);
      const toggleStyle = getComputedStyle(toggle);
      const bandHeight = px(getComputedStyle(chrome).height);

      expect(head.hasAttribute('data-project-rail-head')).toBe(true);
      expect(rail.hasAttribute('data-project-rail')).toBe(true);
      expect(body.classList.contains('workspace-shell__body')).toBe(true);
      expect(toggle.previousElementSibling).toBe(head.querySelector('.hub__brand'));
      expect(shellStyle.display).toBe('grid');
      expect(bodyStyle.gridRow).toBe('2');
      expect(getComputedStyle(chrome).gridRow).toBe('1');
      expect(railStyle.gridRow).toBe('1');

      // jsdom has no layout boxes. Resolve the first track as the body's
      // viewport origin, then add rail-local clearance. The old assertion
      // mistook the head's 4px padding for a viewport Y coordinate.
      const firstTrack = shellStyle.gridTemplateRows.match(/^var\(--app-window-chrome-height(?:,\s*36px)?\)/)?.[0];
      expect(firstTrack).toBeDefined();
      const contentTop = px(firstTrack ?? '');
      const railTop = contentTop + px(railStyle.marginBlockStart || railStyle.marginTop);
      const headPadding = px(headStyle.paddingBlockStart || headStyle.paddingTop);
      // The static, centred flex child cannot start above its content box;
      // flex centring may add clearance, so this is a lower bound, not a rect.
      expect(headStyle.display).toBe('flex');
      expect(headStyle.alignItems).toBe('center');
      expect(toggleStyle.position).toBe('static');
      expect(bandHeight).toBe(36);
      expect(contentTop).toBe(bandHeight);
      expect(railTop).toBeGreaterThanOrEqual(bandHeight);
      expect(headPadding).toBeLessThan(bandHeight);
      expect(railTop + headPadding).toBeGreaterThanOrEqual(bandHeight);
      expect(px(toggleStyle.blockSize || toggleStyle.height)).toBe(28);
      expect(px(toggleStyle.inlineSize || toggleStyle.width)).toBe(28);
    },
  );

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
