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
 *
 * The rail widths are no longer literals in this file's declarations: both
 * states now resolve THROUGH the shared `--project-rail-*` tokens, because the
 * Hub and the workspace mount ONE `ProjectRail` and the workspace's expanded
 * state used to fork off the legacy 56px icon rail instead of the shared 292px
 * panel. That indirection is the fix and must survive, so the resolver follows
 * the chain to the token layer instead of demanding a literal one hop up - and
 * the expanded state is additionally pinned to the shared token's own value,
 * which is what stops a private fork from creeping back in.
 *
 * Expanded is also user-adjustable by drag, so its geometry contract is a
 * BOUNDED RANGE around that token rather than a single number; the bound is
 * asserted against the shipped clamp, not restated as a literal here.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { clampHubRailWidth } from '../../src/components/hub/HubHome';

const styles = resolve(process.cwd(), 'src/styles');
const shellCss = readFileSync(resolve(styles, 'shell.css'), 'utf8');
const entryLayoutCss = readFileSync(resolve(styles, 'home/entry-layout.css'), 'utf8');
const projectRailCss = readFileSync(resolve(styles, 'home/project-rail.css'), 'utf8');

/** The shared two-state widths, read from their single declaration site. */
const SHARED_COLLAPSED = Number.parseFloat(
  /--project-rail-collapsed:\s*([\d.]+)px/.exec(projectRailCss)?.[1] ?? '',
);
const SHARED_EXPANDED = Number.parseFloat(
  /--project-rail-expanded:\s*([\d.]+)px/.exec(projectRailCss)?.[1] ?? '',
);

/**
 * Substitute custom properties the way the cascade would, following the whole
 * chain: the workspace's `--entry-rail-*` resolve to the shared
 * `--project-rail-*`, which resolve to lengths. jsdom performs no `var()`
 * substitution of its own, so each hop is resolved from the winning computed
 * value when jsdom has one and from the declaration site otherwise.
 */
function substituteVars(value: string, computed: CSSStyleDeclaration, depth = 0): string {
  if (depth > 8) throw new Error(`Custom property chain did not terminate: ${value}`);
  const next = value.replace(
    /var\((--[\w-]+)(?:,\s*([^()]+))?\)/g,
    (_match, property: string, fallback: string | undefined) => {
      const inherited = computed.getPropertyValue(property).trim();
      if (inherited) return inherited;
      const pattern = new RegExp(`${property}:\\s*([^;]+);`);
      const declared =
        pattern.exec(entryLayoutCss)?.[1] ?? pattern.exec(projectRailCss)?.[1];
      if (declared) return declared.trim();
      if (fallback) return fallback.trim();
      throw new Error(`Could not resolve ${property}`);
    },
  );
  return next === value ? next : substituteVars(next, computed, depth + 1);
}

/** Resolve the winning first grid track to pixels, through the token chain. */
function resolvedFirstTrack(element: HTMLElement): number {
  const computed = getComputedStyle(element);
  const substituted = substituteVars(computed.gridTemplateColumns, computed);
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
  // project-rail.css carries the shared tokens the workspace rail resolves
  // through, so it belongs in the same cascade the assertions read back.
  style.textContent = `${projectRailCss}\n${shellCss}\n${entryLayoutCss}`;
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
    // Collapsed is a single FIXED state - the shared strip, not a range.
    expect(SHARED_COLLAPSED).toBe(44);
    expect(track).toBe(SHARED_COLLAPSED);
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

    expect(collapsed).toBe(SHARED_COLLAPSED);
    // Expanded is the SHARED panel width, not the workspace's old private
    // 56px icon rail: 292px of real panel, reached through the token.
    expect(SHARED_EXPANDED).toBe(292);
    expect(expanded).toBe(SHARED_EXPANDED);
    expect(expanded).toBeGreaterThan(collapsed);
    collapsedHost.remove();
    expandedHost.remove();
  });

  it('resolves BOTH states through the shared project-rail tokens', () => {
    // The mechanism matters, not just the number: a workspace-local literal
    // that happened to equal 292 would drift the moment the shared token moved.
    const shell = /\.entry-shell--no-header\s*\{([^}]*)\}/.exec(entryLayoutCss)?.[1] ?? '';

    expect(shell).toMatch(/--entry-rail-width:\s*var\(--project-rail-expanded\)/);
    expect(shell).toMatch(/--entry-rail-strip-width:\s*var\(--project-rail-collapsed\)/);
    // The tokens have exactly ONE declaration site, so the two surfaces cannot
    // fork again.
    expect(entryLayoutCss).not.toMatch(/--project-rail-(?:collapsed|expanded):/);
    expect([...projectRailCss.matchAll(/--project-rail-expanded:/g)]).toHaveLength(1);
    expect([...projectRailCss.matchAll(/--project-rail-collapsed:/g)]).toHaveLength(1);
  });
});

describe('expanded rail: a BOUNDED drag range, still one state', () => {
  it('clamps any drag to [262, 420] around the shared expanded width', () => {
    expect(clampHubRailWidth(-9000)).toBe(262);
    expect(clampHubRailWidth(0)).toBe(262);
    expect(clampHubRailWidth(261)).toBe(262);
    expect(clampHubRailWidth(9000)).toBe(420);
    expect(clampHubRailWidth(421)).toBe(420);
    // The shared expanded width is the default and sits inside the range, so
    // the token stays a legal width rather than being clamped away.
    expect(clampHubRailWidth(SHARED_EXPANDED)).toBe(SHARED_EXPANDED);
  });

  it('keeps the widest drag clear of the collapsed strip and passes values through', () => {
    // Bounded, not free: the narrowest expanded rail is still a panel, far
    // wider than the 44px strip, so dragging can never reach the other state.
    expect(clampHubRailWidth(262)).toBeGreaterThan(SHARED_COLLAPSED * 4);
    // Inside the range the user's exact width is honoured (rounded to a
    // whole pixel), which is what makes persistence across remount meaningful.
    expect(clampHubRailWidth(300)).toBe(300);
    expect(clampHubRailWidth(377.4)).toBe(377);
  });

  it('drives the resizer position from the same width variable as the track', () => {
    // A resizer that read a different variable would sit off the rail edge at
    // any user-chosen width - the handle and the track are one contract.
    const hubCss = readFileSync(resolve(styles, 'home/hub.css'), 'utf8');
    const resizer = /\.hub__rail-resizer\s*\{([^}]*)\}/.exec(hubCss)?.[1] ?? '';

    expect(resizer).toMatch(/inset-inline-start:\s*calc\(var\(--hub-rail-expanded[^)]*\)\s*-\s*4px\)/);
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
