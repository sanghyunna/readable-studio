// @vitest-environment jsdom

/**
 * Rail head geometry and shell canvas continuity.
 *
 * Four defects, one root: the rail's box began at the physical window top
 * (y=0), INSIDE the 36px frameless chrome row, and faked its clearance with a
 * 40px top padding inside the head row. Because the expanded panel also
 * floated 10px down while the collapsed strip stayed flush, the head row's
 * content - and with it the collapse toggle - rode with the panel: collapsing
 * moved the toggle diagonally (10px up) instead of purely horizontally. The
 * toggle also hugged the wordmark instead of sharing the New Project button's
 * trailing edge, and the Hub's ambient wash carriers were scoped to the
 * content column, so the rail column sat on bare canvas and its glass read as
 * flat clay on wide windows.
 *
 * The contract pinned here:
 *
 *  - ONE content origin: the shell body starts BELOW the chrome row, so the
 *    rail's top edge never intrudes into the drag band in either state, and
 *    the head row needs no internal chrome clearance of its own.
 *  - Expanded rail top = content origin + shared inset; collapsed top =
 *    content origin. The toggle's vertical centre is ONE value in both states:
 *    collapsed head clearance compensates for the expanded panel's inset,
 *    retaining the brand's content height when only the smaller toggle remains.
 *  - The toggle's RIGHT edge shares the New Project button's trailing edge:
 *    both are inset from the rail's trailing edge by the same 12px, derived
 *    from the actions block's own padding token - so the alignment holds at
 *    every track width from 262 to 420px, not just the default.
 *  - The rail paints no opaque background of its own: it is a translucent
 *    glass rider over the ONE shell canvas, and the shell's three ambient
 *    carriers span the full window INCLUDING the rail column.
 *
 * Geometry is asserted through `getComputedStyle` against the real
 * stylesheets, with `var()` resolved against the single declaration sites -
 * never against a hardcoded literal that would drift if the chrome height or
 * the inset changes.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const styles = resolve(process.cwd(), 'src/styles');
const read = (relative: string) => readFileSync(resolve(styles, relative), 'utf8');

const projectRailCss = read('home/project-rail.css');
const entryLayoutCss = read('home/entry-layout.css');
const hubCss = read('home/hub.css');
const shellCss = read('shell.css');
const routinesCss = read('viewer/routines.css');
const baseCss = read('base.css');
const primitivesCss = read('primitives.css');

/** The shared rail tokens, taken from their single declaration sites. */
const SHARED_INSET = /--project-rail-inset:\s*([\d.]+px)/.exec(projectRailCss)?.[1];
const SHELL_CHROME = /--app-window-chrome-height:\s*([\d.]+px)/.exec(shellCss)?.[1];

/** Resolve `var()` against the real declaration sites, then parse a length. */
function pixels(value: string): number {
  const substituted = value.replace(
    /var\(--hub-rail-inline-inset,\s*var\(--space-3\)\)/g,
    () => /--hub-rail-inline-inset:\s*([\d.]+px)/.exec(hubCss)?.[1] ?? '',
  ).replace(
    /var\((--project-rail-[a-z-]+|--app-window-chrome-height)(?:,\s*([^)]+))?\)/g,
    (_match, property: string, fallback: string | undefined) => {
      const declared = new RegExp(`${property}:\\s*([\\d.]+px)`).exec(
        property === '--app-window-chrome-height' ? shellCss : projectRailCss,
      )?.[1];
      if (declared) return declared;
      if (fallback) return fallback.trim();
      throw new Error(`Could not resolve ${property}`);
    },
  );
  const calc = /^calc\(\s*([\d.]+)px\s*\+\s*([\d.]+)px\s*\)$/.exec(substituted);
  if (calc) return Number(calc[1]) + Number(calc[2]);
  const parsed = Number.parseFloat(substituted);
  if (!Number.isFinite(parsed)) throw new Error(`Not a length: ${value}`);
  return parsed;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Base cascade only: `@media` blocks dropped so a lookup reads the rest state. */
function baseCascade(css: string): string {
  const source = stripComments(css);
  let result = '';
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf('@media', index);
    if (start < 0) {
      result += source.slice(index);
      break;
    }
    result += source.slice(index, start);
    let cursor = source.indexOf('{', start) + 1;
    let depth = 1;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === '{') depth += 1;
      if (source[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    index = cursor;
  }
  return result;
}

/** Concatenated declarations of every rule whose selector list contains `selector` exactly. */
function declarations(css: string, selector: string): string {
  const bodies: string[] = [];
  const rule = /([^{}]+)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rule.exec(css)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((part) => part.trim());
    if (selectors.includes(selector)) bodies.push(match[2] ?? '');
  }
  return bodies.join('\n');
}

function lastValue(block: string, property: string): string | undefined {
  const matches = [...block.matchAll(new RegExp(`(?:^|[;\\n])\\s*${property}\\s*:\\s*([^;]+);`, 'g'))];
  return matches.at(-1)?.[1]?.trim();
}

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

const HEAD_ROW = `
  <div class="hub__nav-head" data-project-rail-head>
    <button class="hub__brand" data-testid="hub-brand">
      <img class="hub__brand-mark" alt="" />
      <span class="hub__brand-name">Readable Studio</span>
    </button>
    <button class="hub__rail-toggle" data-project-rail-toggle data-testid="hub-rail-toggle"></button>
  </div>`;

beforeAll(() => {
  const style = document.createElement('style');
  // jsdom drops padding shorthands containing nested var() rather than
  // retaining them for computed style. Substitute the real rail token before
  // parsing so actions padding participates in the cascade, not a fake zero.
  const resolvedHubCss = hubCss.replace(
    /var\(--hub-rail-inline-inset,\s*var\(--space-3\)\)/g,
    (value) => `${pixels(value)}px`,
  );
  // Include the later viewer cascade: its legacy 34px shell row used to
  // override shell.css on workspace routes, while Home's :has() hid the bug.
  style.textContent = `${baseCss}\n${primitivesCss}\n${shellCss}\n${routinesCss}\n${projectRailCss}\n${entryLayoutCss}\n${resolvedHubCss}`;
  document.head.append(style);
});

describe('rail head: one content origin below the chrome row', () => {
  it('starts the shell body BELOW the chrome row, so the rail never owns the drag band', () => {
    // The defect: the body spanned the chrome row (`grid-row: 1 / -1`) and the
    // rail's box began at y=0. The body must occupy the content row only, so
    // the rail's top edge - expanded inset or collapsed flush - is measured
    // from the shared content origin, never inside the 36px band.
    const body = declarations(baseCascade(shellCss), '.workspace-shell__body');
    expect(lastValue(body, 'grid-row')).toBe('2');

    // The chrome strip keeps its own row above the body.
    const chrome = declarations(baseCascade(shellCss), '.app-window-chrome');
    expect(lastValue(chrome, 'grid-row')).toBe('1');
    expect(SHELL_CHROME).toBe('36px');
  });

  it('clears the drag band by layout, not by a padding hack inside the head row', () => {
    const host = mount(`
      <div class="workspace-shell__body">
        <nav class="hub__nav" data-project-rail="hub" data-project-rail-state="expanded">${HEAD_ROW}</nav>
      </div>
    `);
    const head = getComputedStyle(host.querySelector('.hub__nav-head') as HTMLElement);

    // Once the rail itself starts below the chrome, the head row's top
    // clearance is one small breathing step - NOT the chrome height restated
    // inside the row. A `calc(36px + 4px)` here is the old double origin.
    const topClearance = pixels(head.paddingBlockStart || head.paddingTop);
    expect(topClearance).toBeLessThan(pixels(SHELL_CHROME ?? ''));
    host.remove();
  });

  it.each([262, 292, 420].flatMap(track => (['home', 'workspace'] as const).map(route => ({ track, route }))))(
    'insets only the expanded rail while keeping toggle centre-Y equal on $route at $track px',
    ({ track, route }) => {
    const geometry = (state: 'expanded' | 'collapsed') => {
      const host = mount(`<div class="workspace-shell" style="--hub-rail-expanded: ${track}px">
        <header class="app-chrome-header app-window-chrome"></header>
        <div class="workspace-shell__body">
          <nav class="hub__nav" data-project-rail="hub" data-project-rail-state="${state}">${HEAD_ROW}</nav>
          <div data-surface="${route}">${route === 'home'
            ? '<div class="entry-shell entry-shell--no-header"><main class="entry-main__inner--home"></main></div>'
            : '<div class="app"><div class="split"></div></div>'}</div>
        </div>
      </div>`);
      const computed = (selector: string) => getComputedStyle(host.querySelector(selector) as HTMLElement);
      const shell = computed('.workspace-shell');
      const body = computed('.workspace-shell__body');
      const rail = computed('.hub__nav');
      const head = computed('.hub__nav-head');
      const brand = computed('.hub__brand');
      const toggle = computed('[data-project-rail-toggle]');
      expect(shell.display).toBe('grid');
      expect(body.gridRow).toBe('2');
      const firstTrack = shell.gridTemplateRows.match(/^(?:var\(--app-window-chrome-height(?:,\s*36px)?\)|[\d.]+px)/)?.[0];
      const contentOrigin = pixels(firstTrack ?? '');
      expect(contentOrigin).toBe(36);
      expect(contentOrigin).toBe(pixels(computed('.app-window-chrome').height));
      expect(computed('[data-surface]').gridRow).toBe('1');
      expect(rail.gridRow).toBe('1');
      const railTop = contentOrigin + pixels(rail.marginBlockStart || rail.marginTop);
      const top = pixels(head.paddingBlockStart || head.paddingTop);
      const bottom = pixels(head.paddingBlockEnd || head.paddingBottom);
      const toggleHeight = pixels(toggle.blockSize || toggle.height);
      const brandHeight = brand.display === 'none' ? 0 : pixels(brand.height);
      // jsdom has no layout engine. Derive the flex content box from the REAL
      // winning border-box minimum, padding and visible child heights. Equal
      // padding alone misses the 34px brand -> 28px toggle sizing change.
      expect(head.boxSizing).toBe('border-box');
      expect(head.display).toBe('flex');
      expect(head.alignItems).toBe('center');
      expect(toggle.position).toBe('static');
      expect(toggleHeight).toBe(28);
      expect(pixels(toggle.inlineSize || toggle.width)).toBe(28);
      const contentHeight = Math.max(
        pixels(head.minBlockSize || head.minHeight) - top - bottom,
        brandHeight,
        toggleHeight,
      );
      const centreY = railTop + top + contentHeight / 2;
      expect(centreY - toggleHeight / 2).toBeGreaterThanOrEqual(contentOrigin);
      expect(rail.blockSize).toBe('auto');
      expect(pixels(rail.marginBlockEnd || rail.marginBottom))
        .toBe(state === 'expanded' ? pixels(SHARED_INSET ?? '') : 0);
      host.remove();
      return { contentOrigin, railTop, top, contentHeight, centreY };
    };

    const expanded = geometry('expanded');
    const collapsed = geometry('collapsed');
    const inset = pixels(SHARED_INSET ?? '');
    expect(expanded.contentOrigin).toBe(36);
    expect(collapsed.contentOrigin).toBe(expanded.contentOrigin);
    expect(expanded.railTop).toBe(expanded.contentOrigin + inset);
    expect(collapsed.railTop).toBe(collapsed.contentOrigin);
    expect(collapsed.top - expanded.top).toBe(inset);
    expect(expanded.contentHeight).toBe(34);
    expect(collapsed.contentHeight).toBe(expanded.contentHeight);
    expect(collapsed.centreY).toBe(expanded.centreY);
  });

  it.each(['expanded', 'collapsed'])('synchronizes %s head compensation with the rail margin transition', (state) => {
    const host = mount(`<nav class="hub__nav" data-project-rail="hub" data-project-rail-state="${state}">${HEAD_ROW}</nav>`);
    const rail = getComputedStyle(host.querySelector('.hub__nav') as HTMLElement);
    const head = getComputedStyle(host.querySelector('.hub__nav-head') as HTMLElement);
    const timing = rail.transition.replace(/^margin\s+/, '');
    expect(head.transition).toContain(`padding-block-start ${timing}`);
    expect(head.transition).toContain(`min-block-size ${timing}`);
    expect(head.transitionDuration).toBe(rail.transitionDuration);
    host.remove();
  });
});

describe('rail head: the toggle shares the New Project trailing edge', () => {
  it('insets the head row and the actions block from the rail\'s trailing edge by the SAME derived value', () => {
    // The alignment rule: the rail's trailing content edge is ONE vertical
    // line. The actions block owns it through its inline padding; the head row
    // derives its own trailing inset from the SAME declaration so the toggle's
    // right edge lands exactly on the New Project button's right edge at every
    // track width (262-420px), with no hardcoded pixel that drifts on resize.
    const actions = declarations(baseCascade(hubCss), '.hub__nav-actions');
    const head = declarations(baseCascade(hubCss), '.hub__nav-head');

    const actionsInline = lastValue(actions, 'padding-inline')
      ?? lastValue(actions, 'padding')
      ?? (() => { throw new Error('.hub__nav-actions must own the trailing inset'); })();
    const headInline = lastValue(head, 'padding-inline')
      ?? (() => { throw new Error('.hub__nav-head must derive the trailing inset'); })();

    // One shared token, declared once: the head reads the actions' inline
    // padding through it, so a future spacing change cannot fork the line.
    const shared = /var\(--hub-rail-inline-inset,\s*var\(--space-3\)\)/;
    expect(actionsInline).toMatch(shared);
    expect(headInline).toMatch(shared);

    // The head row packs its cluster to the start and lets the toggle take the
    // row's trailing slot: the toggle's right edge IS the row's trailing inset.
    const host = mount(`
      <div class="workspace-shell__body">
        <nav class="hub__nav" data-project-rail="hub" data-project-rail-state="expanded">${HEAD_ROW}</nav>
      </div>
    `);
    const computedHead = getComputedStyle(host.querySelector('.hub__nav-head') as HTMLElement);
    const toggle = host.querySelector('[data-project-rail-toggle]') as HTMLElement;
    expect(computedHead.justifyContent).toBe('space-between');
    expect(pixels(getComputedStyle(toggle).marginLeft || '0')).toBe(0);
    host.remove();
  });

  it('holds the shared trailing line across the whole 262-420px resize range', () => {
    // The alignment is a DERIVATION, not a constant: both insets resolve
    // through the same token, so for any track width W the toggle's right edge
    // (W - inset) equals the New Project button's right edge (W - inset).
    // Pin the arithmetic at the default and both clamps.
    for (const track of [262, 292, 420]) {
      const host = mount(`<div class="workspace-shell__body" style="--hub-rail-expanded: ${track}px">
        <nav class="hub__nav" data-project-rail="hub" data-project-rail-state="expanded">${HEAD_ROW}
          <div class="hub__nav-actions"><button class="hub__new-project"></button></div>
        </nav>
      </div>`);
      const computed = (selector: string) => getComputedStyle(host.querySelector(selector) as HTMLElement);
      const rail = computed('.hub__nav');
      const head = computed('.hub__nav-head');
      const actions = computed('.hub__nav-actions');
      const button = computed('.hub__new-project');
      expect(rail.inlineSize).toBe('auto');
      expect(pixels(rail.getPropertyValue('--hub-rail-inline-inset'))).toBe(12);
      expect(head.justifyContent).toBe('space-between');
      expect(button.width).toBe('100%');
      expect(button.boxSizing).toBe('border-box');
      const railLeft = pixels(rail.marginLeft);
      const railWidth = track - railLeft;
      const toggleRight = railLeft + railWidth - pixels(head.paddingInline);
      const newProjectRight = railLeft + railWidth - pixels(actions.paddingInline || actions.paddingRight);
      expect(toggleRight).toBe(newProjectRight);
      expect(toggleRight).toBe(track - 12);
      host.remove();
    }
  });
});

describe('shell canvas: one continuous surface behind the rail', () => {
  it('keeps the rail a translucent glass rider - never an opaque panel of its own', () => {
    const host = mount(`
      <div class="workspace-shell__body">
        <nav class="hub__nav" data-project-rail="hub" data-project-rail-state="expanded"></nav>
      </div>
    `);
    const rail = getComputedStyle(host.querySelector('.hub__nav') as HTMLElement);

    // The fill is the shared glass token: translucent, so the shell canvas and
    // its blooms refract through. An opaque fill here is what cut the window
    // into two surfaces.
    expect(rail.background).toContain('var(--hub-glass-fill)');
    const fill = /--hub-glass-fill:\s*([^;]+);/.exec(read('themes/recipes.css'))?.[1]
      ?? /--hub-glass-fill:\s*([^;]+);/.exec(read('tokens.css'))?.[1];
    expect(fill).toBeDefined();
    expect(fill).toMatch(/color-mix|rgba/);
    expect(fill).not.toMatch(/100%|,\s*1\)/);
    // The blur is what turns the blooms behind into refraction, not a flat tint.
    expect(rail.backdropFilter || rail.getPropertyValue('-webkit-backdrop-filter'))
      .toBe('var(--hub-glass-blur)');
    host.remove();
  });

  it('spans the shell\'s ambient carriers behind the FULL window, including the rail column', () => {
    // The carriers are fixed to the viewport and owned by the SHELL, so the
    // rail column sits on the same saturated blooms as the content column.
    // Scoping them to the content column (or to a transformed wrapper that
    // re-origins `fixed`) is what left the rail on bare canvas.
    const base = baseCascade(shellCss);
    const carriers = ['.app::before', '.split::after', '.split::before'];
    for (const carrier of carriers) {
      const block = declarations(base, carrier);
      expect(lastValue(block, 'position'), carrier).toBe('fixed');
      // The accent and cool carriers anchor to the window's left edge - the
      // rail's own column - so the rail always has saturated light behind it.
      if (carrier !== '.split::after') {
        expect(lastValue(block, 'inset'), carrier).toMatch(/-1\d\dpx|-6vw/);
      }
    }
    // The warm carrier keeps its live chat-panel anchoring; that ownership
    // stays with `.split` and is not moved by this fix.
    expect(lastValue(declarations(base, '.split::after'), 'inset'))
      .toContain('var(--project-chat-panel-width');
  });

  it('flattens the rail and the content column consistently under reduced transparency', () => {
    const hubReduced = (() => {
      const source = stripComments(hubCss);
      const needle = '@media (prefers-reduced-transparency: reduce)';
      const bodies: string[] = [];
      let cursor = 0;
      while (cursor < source.length) {
        const start = source.indexOf(needle, cursor);
        if (start < 0) break;
        const open = source.indexOf('{', start);
        let depth = 1;
        let index = open + 1;
        for (; index < source.length && depth > 0; index += 1) {
          if (source[index] === '{') depth += 1;
          if (source[index] === '}') depth -= 1;
        }
        bodies.push(source.slice(open + 1, index - 1));
        cursor = index;
      }
      return bodies.join('\n');
    })();

    // The rail drops its blur and takes the same opaque panel fallback as the
    // content panes - one flat neutral composition, not a translucent rail
    // floating over a flattened stage.
    const rail = declarations(hubReduced, '.hub__nav');
    expect(lastValue(rail, 'backdrop-filter')).toBe('none');
    expect(lastValue(rail, 'background')).toMatch(/var\(--bg-(panel|elevated)\)/);
  });
});
