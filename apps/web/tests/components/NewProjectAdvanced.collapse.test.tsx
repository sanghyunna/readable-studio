// @vitest-environment jsdom
//
// Two measured defects in the Advanced disclosure, pinned so they cannot come
// back:
//
//   1. The collapse read as a SNAP. A browser sampled it at 190ms with
//      --ease-out (an ease-out-quint) and got 906.53 -> 98.30 -> 4.38 -> 0:
//      ONE frame in the whole 10%-90% band over ~906px of travel. The duration
//      was the visible symptom; the CURVE was the cause, because ease-out-quint
//      is 99% travelled by 17% of its duration. This suite evaluates the
//      declared curve+duration the same way the browser does and asserts the
//      resulting height ramp actually has intermediate frames.
//
//   2. The retained-but-collapsed body intercepted pointer input. A hit test
//      during the collapse resolved to `new-project-panel` instead of the
//      toggle. A bounding-box check and a DOM `.click()` BOTH succeed on a
//      covered element, so the guard here is `elementFromPoint`-shaped: it
//      composites the real stylesheet's `pointer-events` through the ancestor
//      chain, which is exactly what the browser hit-test does and what a naive
//      render assertion misses.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@readable-studio/host', () => ({
  isReadableStudioHostAvailable: () => true,
  pickAndImportHostProject: vi.fn(),
  pickHostWorkingDir: vi.fn(),
}));

import { NewProjectAdvanced } from '../../src/components/NewProjectAdvanced';
import type { DesignSystemSummary, ProjectTemplate, SkillSummary } from '../../src/types';

const repoRoot = resolve(__dirname, '../../../..');
const modalCss = readFileSync(
  resolve(repoRoot, 'apps/web/src/styles/home/new-project-modal.css'),
  'utf8',
);
const tokensCss = readFileSync(resolve(repoRoot, 'apps/web/src/styles/tokens.css'), 'utf8');

/** The panel's measured open height on the Hub at 1440x960. */
const OPEN_HEIGHT_PX = 906.53;

function tokenValue(name: string): string {
  const match = tokensCss.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`token --${name} not found in tokens.css`);
  return match[1]!.trim();
}

/** Parses `cubic-bezier(a, b, c, d)` into its four control-point components. */
function parseCubicBezier(value: string): [number, number, number, number] {
  const match = value.match(
    /cubic-bezier\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)/,
  );
  if (!match) throw new Error(`not a cubic-bezier: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

function parseMs(value: string): number {
  const match = value.match(/^([\d.]+)(ms|s)$/);
  if (!match) throw new Error(`not a duration: ${value}`);
  return match[2] === 's' ? Number(match[1]) * 1000 : Number(match[1]);
}

/** Evaluates a CSS timing function at progress `x`, the way the compositor does. */
function easingAt([x1, y1, x2, y2]: [number, number, number, number], x: number): number {
  const bezier = (a: number, b: number, t: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (bezier(x1, x2, mid) < x) lo = mid;
    else hi = mid;
  }
  return bezier(y1, y2, (lo + hi) / 2);
}

/** The height ramp a browser would paint for the declared collapse. */
function collapseHeights(frameMs: number): number[] {
  const declaration = modalCss.match(
    /\.newproj-advanced__reveal\s*\{[\s\S]*?transition:\s*([\s\S]*?);/,
  );
  expect(declaration).not.toBeNull();
  const durationToken = declaration![1]!.match(/var\(--([\w-]+)\)\s+var\(--[\w-]+\)/);
  const easingToken = declaration![1]!.match(/var\(--[\w-]+\)\s+var\(--([\w-]+)\)/);
  expect(durationToken).not.toBeNull();
  expect(easingToken).not.toBeNull();

  const duration = parseMs(tokenValue(durationToken![1]!));
  const curve = parseCubicBezier(tokenValue(easingToken![1]!));

  const heights: number[] = [];
  for (let t = 0; t <= duration; t += frameMs) {
    heights.push(OPEN_HEIGHT_PX * (1 - easingAt(curve, t / duration)));
  }
  heights.push(0);
  return heights;
}

const skills: SkillSummary[] = [
  {
    id: 'prototype-skill',
    name: 'Prototype',
    description: 'Build prototypes',
    mode: 'prototype',
    surface: 'web',
    previewType: 'html',
    designSystemRequired: true,
    defaultFor: ['prototype'],
    triggers: [],
    upstream: null,
    hasBody: true,
    examplePrompt: 'Build a prototype.',
    aggregatesExamples: false,
  },
];

const designSystems: DesignSystemSummary[] = [
  {
    id: 'clay',
    title: 'Clay',
    summary: 'Friendly tactile product UI.',
    category: 'Product',
    swatches: ['#f4efe7', '#25211d'],
  },
];

const templates: ProjectTemplate[] = [
  {
    id: 'tmpl-landing',
    name: 'Landing Page',
    description: 'A saved landing page starter.',
    files: [{ name: 'prototype/App.jsx', content: '' }],
    createdAt: 1714867200000,
  },
];

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

const originalResizeObserver = globalThis.ResizeObserver;
const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = originalResizeObserver;
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

describe('the collapse declaration produces motion, not a snap', () => {
  it('puts many frames between 10% and 90% of the travel at 60fps', () => {
    const heights = collapseHeights(1000 / 60);
    const intermediate = heights.filter(
      (h) => h > 0.1 * OPEN_HEIGHT_PX && h < 0.9 * OPEN_HEIGHT_PX,
    );

    // The defect measured ONE. A collapse that reads as motion needs the travel
    // spread across the duration, not dumped into frame one.
    expect(intermediate.length).toBeGreaterThanOrEqual(10);
  });

  it('still shows intermediate frames at the degraded rate this panel actually paints at', () => {
    // Relayout of the whole creation stack plus backdrop-filter drops the
    // observed frame delivery to ~15fps mid-collapse. The animation has to
    // survive that, because that is the rate the user sees.
    const heights = collapseHeights(66.6);
    const intermediate = heights.filter(
      (h) => h > 0.1 * OPEN_HEIGHT_PX && h < 0.9 * OPEN_HEIGHT_PX,
    );

    expect(intermediate.length).toBeGreaterThanOrEqual(3);
  });

  it('descends monotonically without a first-frame cliff', () => {
    const heights = collapseHeights(1000 / 60);

    for (let i = 1; i < heights.length; i += 1) {
      expect(heights[i]!).toBeLessThanOrEqual(heights[i - 1]!);
    }
    // The cliff that caused the defect: 906.53 -> 98.30 in one frame is 89% of
    // the travel gone before the eye can register any motion at all.
    expect(heights[1]!).toBeGreaterThan(0.5 * OPEN_HEIGHT_PX);
  });

  it('keeps the opacity ramp on the same token pair as the height', () => {
    // A fade that finishes ahead of the height leaves an empty box shrinking.
    const declaration = modalCss.match(
      /\.newproj-advanced__reveal\s*\{[\s\S]*?transition:\s*([\s\S]*?);/,
    )![1]!;
    const rows = declaration.match(/grid-template-rows\s+(var\(--[\w-]+\))\s+(var\(--[\w-]+\))/);
    const opacity = declaration.match(/opacity\s+(var\(--[\w-]+\))\s+(var\(--[\w-]+\))/);

    expect(rows).not.toBeNull();
    expect(opacity).not.toBeNull();
    expect(opacity![1]).toBe(rows![1]);
    expect(opacity![2]).toBe(rows![2]);
  });

  it('snaps with no intermediate frame under reduced motion', () => {
    const reduced = modalCss.match(
      /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/,
    );
    expect(reduced).not.toBeNull();
    // Both states must be listed, or the collapse keeps animating while only
    // the expansion is honoured.
    expect(reduced![1]).toContain('.newproj-advanced__reveal');
    expect(reduced![1]).toContain('.newproj-advanced.is-open .newproj-advanced__reveal');
    expect(reduced![1]).toMatch(/transition:\s*none/);
  });
});

describe('the collapsed body does not intercept pointer input', () => {
  const revealClosedInert = () =>
    /\.newproj-advanced__reveal\s*\{[^}]*pointer-events:\s*none/s.test(modalCss);
  const revealOpenLive = () =>
    /\.newproj-advanced\.is-open\s+\.newproj-advanced__reveal\s*\{[^}]*pointer-events:\s*auto/s.test(
      modalCss,
    );

  /** True when a pointer event landing on `node` would actually reach it. */
  function pointerLive(node: Element): boolean {
    for (let cur: Element | null = node; cur; cur = cur.parentElement) {
      if (!cur.classList?.contains('newproj-advanced__reveal')) continue;
      const open = cur.closest('.newproj-advanced')?.classList.contains('is-open') ?? false;
      if (!(open ? revealOpenLive() : !revealClosedInert())) return false;
    }
    return true;
  }

  /**
   * Models `document.elementFromPoint` for a point over `target`: the topmost
   * pointer-live element whose box covers it wins. jsdom has no layout, so the
   * candidate set is supplied explicitly and paint order stands in for z-order
   * — the retained panel paints after the toggle, so it is the interceptor.
   *
   * A bounding-box check and `element.click()` both pass on a covered element;
   * only resolving the point catches the interception.
   */
  function elementFromPointOver(target: Element, overlapping: Element[]): Element | null {
    for (const candidate of [...overlapping].reverse()) {
      if (pointerLive(candidate)) return candidate;
    }
    return pointerLive(target) ? target : null;
  }

  function renderAdvanced() {
    render(
      <NewProjectAdvanced
        skills={skills}
        designSystems={designSystems}
        defaultDesignSystemId={null}
        templates={templates}
        onCreate={vi.fn()}
      />,
    );
  }

  it('resolves the closed toggle to the toggle, not to the retained panel', () => {
    renderAdvanced();
    const toggle = screen.getByTestId('new-project-advanced-toggle');

    // Open then close: this is the state the defect was measured in — the body
    // is mounted, laid out at full height, and merely clipped.
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    const panel = screen.getByTestId('new-project-panel');
    expect(screen.getByTestId('new-project-advanced-reveal').getAttribute('data-state')).toBe(
      'closed',
    );

    // The measured failure: the point over the toggle resolved to this panel.
    // The panel is still mounted and still laid out, so it is a real candidate
    // for the point; only its inertness keeps it from winning.
    const hit = elementFromPointOver(toggle, [panel]);
    expect(hit).toBe(toggle);
    expect(hit).not.toBe(panel);
  });

  it('takes pointer input everywhere inside the open panel', () => {
    renderAdvanced();
    fireEvent.click(screen.getByTestId('new-project-advanced-toggle'));

    const panel = screen.getByTestId('new-project-panel');
    const nameInput = screen.getByTestId('new-project-name');

    // The inert guard must not cost the open state its interactivity: a point
    // over the panel has to resolve to the control under it.
    expect(elementFromPointOver(panel, [nameInput])).toBe(nameInput);
  });

  it('keeps the region inert for the whole collapse, not only at rest', () => {
    // `pointer-events: none` sits on the base (closed) rule, so it applies from
    // the instant `is-open` is dropped — for the entire animated collapse, not
    // just once it settles. A rule scoped to a separate "collapsed" class would
    // leave the panel hit-live for the full exit duration.
    const base = modalCss.match(/\.newproj-advanced__reveal\s*\{([^}]*)\}/s);
    expect(base).not.toBeNull();
    expect(base![1]).toMatch(/pointer-events:\s*none/);
    expect(modalCss).not.toMatch(/\.newproj-advanced__reveal\[data-state=['"]closed['"]\]/);
  });
});
