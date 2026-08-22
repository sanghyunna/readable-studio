// @vitest-environment node

// Regression coverage for a "Preview tab shows a blank/shell-color frame
// while Source code has real content" report. Root cause: the injected
// deck bridge's chaseFirstLayout() loop, which re-dispatches a native
// 'resize' event so the agent's own fit() recomputes its transform once
// the srcdoc iframe has a real size, only checked `window.innerWidth > 0`
// before declaring the layout "settled" and stopping. In this app's nested
// flex/grid preview panel, an iframe can resolve its width from a 100%
// track before its height finishes stretching. The loop then stops while
// height is still 0, fit() falls back to `scale(1)` translated off-screen
// (see fit()'s `if (!isFinite(s) || s <= 0) s = 1;` guard), and — because
// the loop already gave up — no further resize event arrives to correct
// it, leaving the deck stuck on the shell background.
//
// Fix: require BOTH innerWidth and innerHeight to be non-zero before
// counting the layout as settled.

import { describe, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { buildSrcdoc } from '../../src/runtime/srcdoc';

function minimalDeckHtml(): string {
  return [
    '<!doctype html><html><head><style>',
    '.deck-shell { position: fixed; inset: 0; overflow: hidden; }',
    '.deck-stage { width: 1920px; height: 1080px; position: relative; transform-origin: top left; }',
    '.slide { position: absolute; inset: 0; }',
    '.slide:not(.active) { display: none !important; }',
    '</style></head><body>',
    '<div class="deck-shell"><div class="deck-stage" id="deck-stage">',
    '<section class="slide active" id="slide-0">slide 1</section>',
    '</div></div>',
    '</body></html>',
  ].join('\n');
}

/**
 * Loads the deck bridge into jsdom with innerWidth fixed non-zero from the
 * start and innerHeight starting at 0, then flips innerHeight non-zero
 * after a short real delay — reproducing "width settles before height."
 * Returns the total count of native 'resize' events observed on window
 * after the height flip, which is 0 under the pre-fix width-only check
 * (the loop had already given up) and > 0 once both dimensions gate it.
 */
async function countResizeNudgesAfterHeightSettles(): Promise<number> {
  const srcdoc = buildSrcdoc(minimalDeckHtml(), { deck: true });
  const dom = new JSDOM(srcdoc, {
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    url: 'https://example.test/deck-layout-race.html',
    virtualConsole: new VirtualConsole(),
  });
  const { window: win } = dom;

  let height = 0;
  Object.defineProperty(win, 'innerWidth', { configurable: true, value: 800 });
  Object.defineProperty(win, 'innerHeight', { configurable: true, get: () => height });

  let resizesAfterSettle = 0;
  let settled = false;
  win.addEventListener('resize', () => {
    if (settled) resizesAfterSettle += 1;
  });

  // Let a few fast-phase ticks (50ms each) run first while height is still 0 -
  // this is the window during which the pre-fix loop would already have
  // stopped (it only needed innerWidth > 0, true from the start).
  await new Promise((resolve) => setTimeout(resolve, 160));

  height = 600;
  settled = true;

  // Give the loop time to notice the now-settled height and nudge again.
  await new Promise((resolve) => setTimeout(resolve, 300));

  dom.window.close();
  return resizesAfterSettle;
}

describe('injectDeckBridge — chaseFirstLayout width/height race', () => {
  it('keeps nudging resize until height also settles, not just width', async () => {
    const resizesAfterSettle = await countResizeNudgesAfterHeightSettles();
    expect(resizesAfterSettle).toBeGreaterThan(0);
  });
});
