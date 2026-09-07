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
 *   - the rail stopping short of the window floor.
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

/**
 * jsdom does not substitute `var()` and normalises `0px` to `0`, so a raw
 * string compare would fail on serialisation rather than on the geometry under
 * test. Resolve the custom property against its single declaration site and
 * compare NUMBERS - the assertion stays exactly as strict.
 */
function pixels(value: string): number {
  const substituted = value.replace(
    /var\((--project-rail-collapsed)(?:,\s*([^)]+))?\)/g,
    (_match, property: string, fallback: string | undefined) => {
      const declared = new RegExp(`${property}:\\s*([\\d.]+px)`).exec(projectRailCss)?.[1];
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

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

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
    expect(hubCss).toMatch(/--hub-rail-collapsed:\s*var\(--project-rail-collapsed\)/);
    expect(/--hub-rail-collapsed:\s*[\d.]+px/.test(hubCss)).toBe(false);
    expect(entryLayoutCss).toMatch(/--entry-rail-strip-width:\s*var\(--project-rail-collapsed\)/);
  });

  it('gives both surfaces the SAME collapsed width', () => {
    const stripWidth = /--entry-rail-strip-width:\s*([^;]+);/.exec(entryLayoutCss)?.[1];

    expect(stripWidth).toBe('var(--project-rail-collapsed)');
    expect(SHARED_COLLAPSED).toBe('44px');
  });

  it('expands the workspace rail to the shared full panel width, not the legacy icon width', () => {
    const expandedWidth = /--entry-rail-width:\s*([^;]+);/.exec(entryLayoutCss)?.[1];

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

    // The reported defect: a bottom margin left a strip of bare canvas under
    // the rail, so its bottom edge never met the window frame.
    expect(pixels(computed.marginBottom)).toBe(0);
    expect(computed.blockSize || computed.height).toBe('100%');
    host.remove();
  });

  it('anchors the EXPANDED rail to the window bottom too', () => {
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

    expect(pixels(computed.marginBottom)).toBe(0);
    expect(computed.blockSize || computed.height).toBe('100%');
    host.remove();
  });

  it('keeps the Hub rail on the window floor as well', () => {
    const host = mount(`
      <div class="hub">
        <nav class="hub__nav"></nav>
      </div>
    `);
    const computed = getComputedStyle(host.querySelector('.hub__nav') as HTMLElement);

    // The Hub kept its inline inset (that is what detaches the slab from the
    // stage) but must not keep a bottom gap.
    expect(pixels(computed.marginBottom)).toBe(0);
    expect(computed.blockSize || computed.height).toBe('100%');
    host.remove();
  });

  it('keeps the chrome-hosted toggle visible, clickable, and out of the drag region', () => {
    const host = mount(`
      <header class="app-window-chrome">
        <div class="app-window-chrome__rail-toggle">
          <button class="hub__rail-toggle" data-project-rail-toggle></button>
        </div>
      </header>
    `);
    const toggle = host.querySelector('[data-project-rail-toggle]') as HTMLElement;
    const slot = host.querySelector('.app-window-chrome__rail-toggle') as HTMLElement;
    const computed = getComputedStyle(toggle);

    expect(computed.position).toBe('static');
    expect(computed.opacity).toBe('1');
    expect(computed.pointerEvents).toBe('auto');
    expect(computed.visibility).toBe('visible');
    // jsdom drops Electron's non-standard app-region property from computed
    // styles, so pin its two authored boundaries directly as well.
    expect(projectRailCss).toMatch(/\[data-project-rail-toggle\]\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
    expect(shellCss).toMatch(/\.app-window-chrome__rail-toggle\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
    expect(slot.className).toBe('app-window-chrome__rail-toggle');
    host.remove();
  });

  it('left-aligns the expanded Readable Studio brand while centering the collapsed mark', () => {
    const expanded = mount(`<div class="hub"><nav class="hub__nav"><div class="hub__nav-head"><button class="hub__brand"></button></div></nav></div>`);
    const collapsed = mount(`<div class="hub hub--rail-collapsed"><nav class="hub__nav"><div class="hub__nav-head"><button class="hub__brand"></button></div></nav></div>`);

    expect(getComputedStyle(expanded.querySelector('.hub__brand') as HTMLElement).justifySelf).toBe('start');
    expect(getComputedStyle(collapsed.querySelector('.hub__brand') as HTMLElement).justifyContent).toBe('center');
    expanded.remove();
    collapsed.remove();
  });

  it('keeps the rail attached to each surface animation instead of snapping independently', () => {
    // The layout track owns collapse/expand. The rail itself fills every
    // intermediate width, rather than jumping from `auto` to a state-only 44px.
    expect(projectRailCss).toMatch(/\[data-project-rail\]\s*\{[^}]*inline-size:\s*100%/s);
    expect(projectRailCss).not.toMatch(/transition:\s*inline-size/);
    expect(hubCss).toMatch(
      /transition:\s*grid-template-columns\s+var\(--dur-enter\)\s+var\(--ease-out\)/,
    );
    expect(entryLayoutCss).toMatch(
      /transition:\s*grid-template-columns\s+var\(--dur-enter\)\s+var\(--ease-out\)/,
    );
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
