// @vitest-environment node
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { buildSrcdoc } from '../../src/runtime/srcdoc';

const documents: JSDOM[] = [];
afterEach(() => {
  for (const dom of documents.splice(0)) dom.window.close();
  vi.restoreAllMocks();
});

function deckHarness() {
  const dom = new JSDOM(buildSrcdoc('<html><body></body></html>', { deck: true }), {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  documents.push(dom);
  const pending = new Map<number, { readonly run: () => void; readonly delay: number }>();
  let nextId = 0;
  let retryCount = 0;
  vi.spyOn(dom.window, 'setTimeout').mockImplementation((handler, delay) => {
    if (typeof handler !== 'function') throw new TypeError('expected timer callback');
    const id = ++nextId;
    if (delay === 150) retryCount += 1;
    pending.set(id, { run: () => handler(), delay: delay ?? 0 });
    return id;
  });
  vi.spyOn(dom.window, 'clearTimeout').mockImplementation((id) => { if (id !== undefined) pending.delete(id); });
  const script = dom.window.document.querySelector('[data-readable-deck-bridge]')?.textContent;
  if (!script) throw new TypeError('missing deck bridge');
  dom.window.eval(script);
  return {
    dom,
    pending,
    retryCount: () => retryCount,
    runRetries: () => {
      for (let i = 0; i < 100; i += 1) {
        const entry = [...pending].find(([, timer]) => timer.delay === 150);
        if (!entry) return;
        pending.delete(entry[0]);
        entry[1].run();
      }
    },
  };
}

it('bounds retry work when the document never contains slides', () => {
  // Given an empty deck loaded through the production srcdoc builder.
  const harness = deckHarness();
  // When every scheduled discovery retry runs deterministically.
  harness.runRetries();
  // Then discovery stops after a finite budget without a pending retry.
  expect(harness.retryCount()).toBeLessThanOrEqual(20);
  expect([...harness.pending.values()].filter((timer) => timer.delay === 150)).toHaveLength(0);
});

it('cancels pending discovery when the document is disposed', () => {
  // Given an empty deck waiting for slides.
  const harness = deckHarness();
  // When the browser disposes the document.
  harness.dom.window.dispatchEvent(new harness.dom.window.Event('pagehide'));
  // Then no discovery retry survives disposal.
  expect([...harness.pending.values()].filter((timer) => timer.delay === 150)).toHaveLength(0);
});

it('pauses discovery when hidden', () => {
  // Given an empty deck waiting for slides.
  const harness = deckHarness();
  const { document } = harness.dom.window;
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  // When visibility changes to inactive.
  document.dispatchEvent(new harness.dom.window.Event('visibilitychange'));
  // Then its retry is canceled immediately.
  expect([...harness.pending.values()].filter((timer) => timer.delay === 150)).toHaveLength(0);
});

it('resumes discovery when a hidden document becomes visible', () => {
  // Given a paused deck with no slides.
  const harness = deckHarness();
  const { document } = harness.dom.window;
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  document.dispatchEvent(new harness.dom.window.Event('visibilitychange'));
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  // When the document becomes visible.
  document.dispatchEvent(new harness.dom.window.Event('visibilitychange'));
  // Then exactly one retry resumes, still within the original budget.
  expect([...harness.pending.values()].filter((timer) => timer.delay === 150)).toHaveLength(1);
  harness.runRetries();
  expect(harness.retryCount()).toBe(20);
});

it('keeps discovery stopped when visibility changes after disposal', () => {
  // Given a disposed deck.
  const harness = deckHarness();
  harness.dom.window.dispatchEvent(new harness.dom.window.Event('pagehide'));
  // When a queued visibility event arrives.
  harness.dom.window.document.dispatchEvent(new harness.dom.window.Event('visibilitychange'));
  // Then the disposed retry cannot restart.
  expect([...harness.pending.values()].filter((timer) => timer.delay === 150)).toHaveLength(0);
});

it('observes slides that arrive within the retry budget', () => {
  // Given a deck whose slides are created after the bridge starts.
  const harness = deckHarness();
  const slide = harness.dom.window.document.createElement('section');
  slide.className = 'slide';
  harness.dom.window.document.body.append(slide);
  // When the pending discovery runs.
  harness.runRetries();
  // Then it stops retrying and schedules initial slide restoration.
  expect([...harness.pending.values()].filter((timer) => timer.delay === 150)).toHaveLength(0);
  expect([...harness.pending.values()].some((timer) => timer.delay === 100)).toBe(true);
});
