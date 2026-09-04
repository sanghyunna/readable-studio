// @vitest-environment jsdom

/**
 * The project rail's HARD PRODUCT RULE, pinned as geometry.
 *
 * User, verbatim: "프로젝트 관리용 좌측 패널은, 아예 화면에 안보이는 상태로 버튼만
 * 있을 일이 이 앱 자체에 전혀 없어. 한줄짜리 얇은, 즉 접힌 상태이거나, 아예 넓혀진
 * 상태이거나. 이렇게 둘 중 하나 밖에 없어."
 *
 * There are exactly TWO states: a thin, always-visible collapsed STRIP, or the
 * fully expanded panel. The regression this file exists to catch is a THIRD
 * state - the rail gone entirely with only a floating button left - which is
 * what the workspace shipped: `grid-template-columns: 0 minmax(0, 1fr)` made
 * the rail track literally zero-wide.
 *
 * The assertions are numeric rather than textual on purpose. A test that merely
 * grepped for a `--entry-rail-strip-width` declaration would pass even while the
 * collapsed track resolved to 0, because the losing declaration can be present
 * and still lose the cascade. So the real stylesheets are loaded into jsdom and
 * the winning track width is read back through `getComputedStyle`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const styles = resolve(process.cwd(), 'src/styles');
const shellCss = readFileSync(resolve(styles, 'shell.css'), 'utf8');
const entryLayoutCss = readFileSync(resolve(styles, 'home/entry-layout.css'), 'utf8');

/** Resolve the winning first grid track, including either rail custom property. */
function resolvedFirstTrack(element: HTMLElement): number {
  const computed = getComputedStyle(element);
  const substituted = computed.gridTemplateColumns.replace(
    /var\((--entry-rail-(?:strip-)?width)(?:,\s*([^)]+))?\)/g,
    (_match, property: string, fallback: string | undefined) => {
      const inherited = computed.getPropertyValue(property).trim();
      if (inherited) return inherited;
      const declared = new RegExp(`${property}:\\s*([\\d.]+px)`).exec(entryLayoutCss)?.[1];
      if (declared) return declared;
      if (fallback) return fallback.trim();
      throw new Error(`Could not resolve ${property}`);
    },
  );
  const first = substituted.trim().split(/\s+(?![^(]*\))/)[0] ?? '';
  const pixels = Number.parseFloat(first);
  if (!Number.isFinite(pixels) || !first.endsWith('px')) {
    throw new Error(`First rail track did not resolve to pixels: ${first}`);
  }
  return pixels;
}

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

beforeAll(() => {
  const style = document.createElement('style');
  style.textContent = `${shellCss}\n${entryLayoutCss}`;
  document.head.append(style);
});

describe('project rail: exactly two states', () => {
  it('reserves a non-zero strip for the COLLAPSED rail', () => {
    // The defect state: collapsed used to mean a 0-wide track.
    const host = mount(`
      <div class="entry-shell entry-shell--no-header">
        <div class="entry">
          <nav class="entry-nav-rail" data-rail-state="collapsed"></nav>
          <main class="entry-main"></main>
        </div>
      </div>
    `);
    const entry = host.querySelector('.entry') as HTMLElement;
    const track = resolvedFirstTrack(entry);

    expect(track).toBeGreaterThan(0);
    host.remove();
  });

  it('resolves the winning mounted widths and keeps EXPANDED wider than COLLAPSED', () => {
    const collapsedHost = mount(`
      <div class="entry-shell entry-shell--no-header">
        <div class="entry">
          <nav class="entry-nav-rail" data-rail-state="collapsed"></nav>
          <main class="entry-main"></main>
        </div>
      </div>
    `);
    const expandedHost = mount(`
      <div class="entry-shell entry-shell--no-header">
        <div class="entry entry--rail-open">
          <nav class="entry-nav-rail is-open" data-rail-state="expanded"></nav>
          <main class="entry-main"></main>
        </div>
      </div>
    `);
    const collapsed = resolvedFirstTrack(collapsedHost.querySelector('.entry') as HTMLElement);
    const expanded = resolvedFirstTrack(expandedHost.querySelector('.entry') as HTMLElement);

    expect(expanded).toBeGreaterThan(collapsed);
    expect(collapsed).toBeGreaterThan(0);
    collapsedHost.remove();
    expandedHost.remove();
  });

  it('keeps the collapsed rail interactive - never pointer-events:none', () => {
    // A visible-but-dead strip would satisfy the width rule while still being
    // the state the user rejected. The rail must be usable in BOTH states.
    const host = mount(`
      <div class="entry-shell entry-shell--no-header">
        <div class="entry">
          <nav class="entry-nav-rail" data-rail-state="collapsed"></nav>
          <main class="entry-main"></main>
        </div>
      </div>
    `);
    const rail = host.querySelector('.entry-nav-rail') as HTMLElement;
    expect(getComputedStyle(rail).pointerEvents).not.toBe('none');
    host.remove();
  });

  it('removes the floating workspace rail toggle that produced the third state', () => {
    // The button-only state came from a rail hidden behind an absolutely
    // positioned toggle floating over the window-chrome band.
    expect(shellCss).not.toMatch(/\.entry-rail-toggle--workspace\s*\{[^}]*position:\s*absolute/);
  });
});

describe('rail collapse/expand motion', () => {
  it('animates the track width with the product duration and easing tokens', () => {
    const rule = /\.entry-shell--no-header\s+\.entry\s*\{([^}]*)\}/.exec(entryLayoutCss)?.[1] ?? '';

    expect(rule).toMatch(/transition:\s*grid-template-columns\s+var\(--dur-enter\)\s+var\(--ease-out\)/);
    // No invented curve, no bounce/spring.
    expect(rule).not.toMatch(/cubic-bezier\([^)]*1\.[1-9]/);
  });

  it('never animates opacity to nothing - this is a width transition', () => {
    // A fade would reintroduce an invisible rail mid-transition.
    const rule = /\.entry-shell--no-header\s+\.entry\s*\{([^}]*)\}/.exec(entryLayoutCss)?.[1] ?? '';
    expect(rule).not.toMatch(/transition:[^;]*opacity/);
  });

  it('disables the movement entirely under prefers-reduced-motion', () => {
    const reduced = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g;
    const blocks = [...entryLayoutCss.matchAll(reduced)].map((m) => m[1] ?? '');
    const railBlock = blocks.find((b) => b.includes('.entry-shell--no-header .entry'));

    expect(railBlock).toBeDefined();
    expect(railBlock).toMatch(/transition:\s*none/);
  });
});
