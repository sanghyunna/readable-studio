// @vitest-environment jsdom

/**
 * ONE project rail, not two.
 *
 * User, verbatim: "왜 워크스페이스에 있을 때의 좌측 프로젝트 관리바랑 메인 화면에서
 * 쓰는 걸 다른 걸 쳐쓰고 있냐? 너 SWE에서 쓰는 재사용이 뭔지 몰라?"
 *
 * The Hub's left project panel and the workspace's left project rail were two
 * independent implementations, and every place they disagreed produced a defect
 * the user had to report by hand:
 *
 *   - the collapse toggle floating on bare canvas, attached to nothing;
 *   - the rail's geometry against the window frame.
 *
 * The current, deliberate geometry: EXPANDED is a panel floating inside the
 * shell, inset by the ONE shared `--project-rail-inset` on its top, bottom and
 * start edges; COLLAPSED is the edge-anchored 44px strip, flush to the wall,
 * the window top and the window floor. The toggle lives in the rail's own
 * brand row - beside the wordmark expanded, in the brand's place collapsed -
 * and never in the window chrome.
 *
 * These assertions are read back through `getComputedStyle` against the REAL
 * stylesheets rather than grepped as text, because a losing declaration can be
 * present in the file and still lose the cascade - which is exactly how the
 * forked values survived earlier review.
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

/** The one shared collapsed width, taken from its single declaration site. */
const SHARED_COLLAPSED = /--project-rail-collapsed:\s*([\d.]+px)/.exec(projectRailCss)?.[1];
const SHARED_EXPANDED = /--project-rail-expanded:\s*([\d.]+px)/.exec(projectRailCss)?.[1];
/** The one shared inset every expanded gap (start, top, bottom) derives from. */
const SHARED_INSET = /--project-rail-inset:\s*([\d.]+px)/.exec(projectRailCss)?.[1];

/**
 * jsdom does not substitute `var()` and normalises `0px` to `0`, so a raw
 * string compare would fail on serialisation rather than on the geometry under
 * test. Resolve the custom property against its single declaration site and
 * compare NUMBERS - the assertion stays exactly as strict.
 */
function pixels(value: string): number {
  const substituted = value.replace(
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
  const parsed = Number.parseFloat(substituted);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Not a length: ${value}`);
  }
  return parsed;
}

/** The winning block-axis margin, whichever spelling jsdom serialises it under. */
function blockMargins(computed: CSSStyleDeclaration) {
  return {
    start: pixels(computed.getPropertyValue('margin-block-start') || computed.marginTop),
    end: pixels(computed.getPropertyValue('margin-block-end') || computed.marginBottom),
  };
}

function ruleBody(selector: string, css: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
  if (!body) throw new Error(`Missing rule ${selector}`);
  return body;
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
  // Same order the app uses: the shared contract loads before the surface skins.
  style.textContent = `${shellCss}\n${projectRailCss}\n${entryLayoutCss}\n${hubCss}`;
  document.head.append(style);
});

describe('project rail: one shared contract', () => {
  it('declares the collapsed width exactly once, in the shared module', () => {
    expect(SHARED_COLLAPSED).toBeDefined();

    // Neither surface may re-declare a literal collapsed width of its own; the
    // Hub alias must resolve THROUGH the shared custom property.
    expect(shellCss).toContain('grid-template-columns: var(--project-rail-collapsed)');
    expect(hubCss).not.toMatch(/--hub-rail-collapsed:/);
    expect(entryLayoutCss).not.toMatch(/--entry-rail-strip-width:/);
  });

  it('gives both surfaces the SAME collapsed width', () => {
    const stripWidth = /grid-template-columns:\s*(var\(--project-rail-collapsed\))/.exec(shellCss)?.[1];

    expect(stripWidth).toBe('var(--project-rail-collapsed)');
    expect(SHARED_COLLAPSED).toBe('44px');
  });

  it('expands the workspace rail to the shared full panel width, not the legacy icon width', () => {
    const expandedWidth = /var\(--hub-rail-expanded,\s*(var\(--project-rail-expanded\))/.exec(shellCss)?.[1];

    expect(SHARED_EXPANDED).toBe('292px');
    expect(expandedWidth).toBe('var(--project-rail-expanded)');
    expect(Number.parseFloat(SHARED_EXPANDED ?? '') - Number.parseFloat(SHARED_COLLAPSED ?? '')).toBe(248);
  });

  it('anchors the collapsed rail to the window bottom - no floating card gap', () => {
    const host = mount(`
      <div class="entry-shell entry-shell--no-header">
        <div class="entry">
          <nav class="entry-nav-rail"
               data-project-rail="workspace"
               data-project-rail-state="collapsed"></nav>
        </div>
      </div>
    `);
    const rail = host.querySelector('[data-project-rail]') as HTMLElement;
    const computed = getComputedStyle(rail);

    // The collapsed strip is edge-anchored: no gap under it, none above it.
    // Auto stretch with zero margins fills the track exactly like 100% did;
    // it is `auto` (not 100%) so the SAME sizing rule serves the inset
    // expanded panel without a state-only height snap.
    expect(blockMargins(computed)).toEqual({ start: 0, end: 0 });
    expect(computed.blockSize || computed.height).toBe('auto');
    host.remove();
  });

  it('floats the EXPANDED rail inset from the window top and floor by the one shared inset', () => {
    const host = mount(`
      <div class="entry-shell entry-shell--no-header">
        <div class="entry entry--rail-open">
          <nav class="entry-nav-rail"
               data-project-rail="workspace"
               data-project-rail-state="expanded"></nav>
        </div>
      </div>
    `);
    const computed = getComputedStyle(
      host.querySelector('[data-project-rail]') as HTMLElement,
    );

    expect(SHARED_INSET).toBe('10px');
    const inset = pixels(SHARED_INSET ?? '');
    expect(blockMargins(computed)).toEqual({ start: inset, end: inset });
    expect(computed.blockSize || computed.height).toBe('auto');
    host.remove();
  });

  it('gives the expanded Hub panel the same gap on its top, bottom and start edges, and the collapsed strip none', () => {
    const expanded = mount(`<div class="workspace-shell__body"><nav class="hub__nav" data-project-rail="hub" data-project-rail-state="expanded"></nav></div>`);
    const collapsed = mount(`<div class="workspace-shell__body"><nav class="hub__nav" data-project-rail="hub" data-project-rail-state="collapsed"></nav></div>`);
    const panel = getComputedStyle(expanded.querySelector('.hub__nav') as HTMLElement);
    const strip = getComputedStyle(collapsed.querySelector('.hub__nav') as HTMLElement);

    // One deliberate value: the vertical gaps are derived from the inline
    // inset the Hub already owned, not a second and third number.
    const start = pixels(panel.marginLeft);
    expect(start).toBe(pixels(SHARED_INSET ?? ''));
    expect(blockMargins(panel)).toEqual({ start, end: start });
    expect(hubCss).toMatch(/\.hub__nav\s*\{[^}]*margin-left:\s*var\(--project-rail-inset\)/s);
    // Every inset edge docks together on collapse, so the whole margin box is
    // the transitioned property - not just the inline-start edge.
    expect(hubCss).toMatch(/\.hub__nav\s*\{[^}]*transition:\s*margin\s+var\(--dur-enter\)\s+var\(--ease-out\)/s);

    // The collapsed strip is unchanged: flush to the wall, top and floor.
    expect(pixels(strip.marginLeft)).toBe(0);
    expect(blockMargins(strip)).toEqual({ start: 0, end: 0 });
    expect(pixels(strip.borderRadius || strip.borderTopLeftRadius)).toBe(0);
    expanded.remove();
    collapsed.remove();
  });

  it('keeps the resizer inside the expanded rail\'s vertical span, never into the floor gap', () => {
    const resizer = ruleBody('.hub__rail-resizer', hubCss);
    const insetBlock = /inset-block:\s*([^;]+);/.exec(resizer)?.[1]?.trim();
    expect(insetBlock).toBeDefined();
    const [top, bottom] = (insetBlock ?? '').split(/\s+(?![^(]*\))/);

    const railTop = pixels(SHARED_INSET ?? '');
    const railBottomGap = pixels(SHARED_INSET ?? '');
    // Starts below the drag strip (which is below the rail's own top edge)…
    expect(pixels(top ?? '')).toBeGreaterThanOrEqual(railTop);
    // …and stops exactly where the rail stops, not at the window floor.
    expect(pixels(bottom ?? '')).toBe(railBottomGap);
  });

  it('keeps the brand-row toggle visible, clickable and out of the drag region, with no chrome slot left behind', () => {
    const host = mount(`
      <nav class="hub__nav" data-project-rail="hub" data-project-rail-state="expanded">${HEAD_ROW}</nav>
    `);
    const toggle = host.querySelector('[data-project-rail-toggle]') as HTMLElement;
    const computed = getComputedStyle(toggle);

    expect(toggle.closest('[data-project-rail-head]')).not.toBeNull();
    expect(computed.position).toBe('static');
    expect(computed.opacity).toBe('1');
    expect(computed.pointerEvents).toBe('auto');
    expect(computed.visibility).toBe('visible');
    // jsdom drops Electron's non-standard app-region property from computed
    // styles, so pin the authored boundary directly.
    expect(projectRailCss).toMatch(/\[data-project-rail-toggle\]\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
    // The chrome slot the toggle used to be portalled into is gone for good:
    // no dead host element, no second home for the control.
    expect(shellCss).not.toContain('app-window-chrome__rail-toggle');
    expect(projectRailCss).not.toMatch(/portal/i);
    host.remove();
  });

  it('packs the expanded brand row as one brand+toggle cluster and lets the toggle take the brand\'s place when collapsed', () => {
    const expanded = mount(`<div class="workspace-shell__body"><nav class="hub__nav" data-project-rail="hub" data-project-rail-state="expanded">${HEAD_ROW}</nav></div>`);
    const collapsed = mount(`<div class="workspace-shell__body"><nav class="hub__nav" data-project-rail="hub" data-project-rail-state="collapsed">${HEAD_ROW}</nav></div>`);

    const head = getComputedStyle(expanded.querySelector('.hub__nav-head') as HTMLElement);
    const brand = expanded.querySelector('.hub__brand') as HTMLElement;
    const toggle = expanded.querySelector('[data-project-rail-toggle]') as HTMLElement;
    // Left-aligned cluster: the brand hugs its content (no growth into the
    // leftover space) and the toggle is its immediate next sibling, so it
    // sits right of the wordmark rather than floating at the far end.
    expect(head.display).toBe('flex');
    expect(head.justifyContent).toBe('flex-start');
    expect(getComputedStyle(brand).display).toBe('flex');
    expect(getComputedStyle(brand).flexGrow).toBe('0');
    expect(toggle.previousElementSibling).toBe(brand);
    expect(pixels(getComputedStyle(toggle).marginLeft || '0')).toBe(0);

    // Collapsed: the brand (mark included) is not shown; the toggle occupies
    // that slot, centred in the 44px strip.
    const collapsedHead = getComputedStyle(collapsed.querySelector('.hub__nav-head') as HTMLElement);
    expect(getComputedStyle(collapsed.querySelector('.hub__brand') as HTMLElement).display).toBe('none');
    expect(getComputedStyle(collapsed.querySelector('[data-project-rail-toggle]') as HTMLElement).display).toBe('inline-flex');
    expect(collapsedHead.justifyContent).toBe('center');
    expanded.remove();
    collapsed.remove();
  });

  it('routes every rail-owned menu through the body-portalled fixed placer, never the rail\'s overflow box', () => {
    const host = mount(`
      <nav class="hub__nav" data-project-rail="hub" data-project-rail-state="collapsed"></nav>
      <div class="hub-menu"></div>
    `);
    const rail = getComputedStyle(host.querySelector('.hub__nav') as HTMLElement);
    const menu = getComputedStyle(host.querySelector('.hub-menu') as HTMLElement);

    // The rail clips: that is WHY an in-rail absolute menu was cut off at 44px.
    expect(rail.overflow || rail.overflowX).toBe('hidden');
    // The shared placer is viewport-fixed and painted above the rail.
    expect(menu.position).toBe('fixed');
    expect(Number.parseInt(menu.zIndex, 10)).toBeGreaterThan(Number.parseInt(rail.zIndex, 10));
    // The footer's rail-local `.hub__menu` variant no longer exists.
    expect(hubCss).not.toMatch(/\.hub__menu\s*\{/);
    expect(hubCss).not.toMatch(/\.hub__menu-item/);
    host.remove();
  });

  it('keeps the rail attached to each surface animation instead of snapping independently', () => {
    // The layout track owns collapse/expand. The rail itself fills every
    // intermediate width, rather than jumping from `auto` to a state-only 44px.
    expect(projectRailCss).toMatch(/\[data-project-rail\]\s*\{[^}]*inline-size:\s*100%/s);
    expect(projectRailCss).not.toMatch(/transition:\s*inline-size/);
    expect(shellCss).toMatch(
      /transition:\s*grid-template-columns\s+var\(--dur-enter\)\s+var\(--ease-out\)/,
    );
    expect(hubCss).not.toMatch(/transition:\s*grid-template-columns/);
    expect(entryLayoutCss).not.toMatch(/transition:\s*grid-template-columns/);
  });

  it('never lets the collapsed rail become a zero-width third state', () => {
    const host = mount(`
      <div class="entry-shell entry-shell--no-header">
        <div class="entry">
          <nav class="entry-nav-rail"
               data-project-rail="workspace"
               data-project-rail-state="collapsed"></nav>
        </div>
      </div>
    `);
    const computed = getComputedStyle(host.querySelector('[data-project-rail]') as HTMLElement);

    // The non-zero parent track supplies the 44px geometry. The rail fills it
    // instead of carrying a second, state-only width that can snap separately.
    expect(computed.inlineSize || computed.width).toBe('100%');
    expect(pixels(computed.minInlineSize || computed.minWidth)).toBe(0);
    expect(computed.pointerEvents).toBe('auto');
    host.remove();
  });
});
