// @vitest-environment node
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildSrcdoc } from '../../src/runtime/srcdoc';

const documents: JSDOM[] = [];
afterEach(() => {
  for (const dom of documents.splice(0)) dom.window.close();
});

const slideMarkup = '<main class="deck">' + Array.from({ length: 4 }, (_, i) =>
  `<section class="slide${i === 0 ? ' active' : ''}">${i + 1}</section>`,
).join('') + '</main>';
const slideStyles = '<style>.slide{display:none}.slide.active{display:block}</style>';

function fixture(body = slideMarkup, authoredNavigation = false, deferPaint = false, initialSlideIndex = 2) {
  const source = `<!doctype html><html><head>${slideStyles}</head><body>${body}</body></html>`;
  const output = buildSrcdoc(source, { deck: true, initialSlideIndex });
  const script = output.match(/<script data-readable-deck-bridge>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('deck bridge missing');
  const dom = new JSDOM(source, { pretendToBeVisual: true, runScripts: 'outside-only' });
  documents.push(dom);
  const { window } = dom;
  const parentPostMessage = vi.fn();
  Object.defineProperty(window, 'parent', { value: { postMessage: parentPostMessage } });
  if (authoredNavigation) {
    let active = 0;
    window.addEventListener('keydown', (event) => {
      if (event.defaultPrevented) return;
      if (event.key === 'ArrowRight') active = Math.min(3, active + 1);
      else if (event.key === 'ArrowLeft') active = Math.max(0, active - 1);
      else return;
      event.preventDefault();
      const paint = () => window.document.querySelectorAll('.slide').forEach((slide, i) => slide.classList.toggle('active', i === active));
      if (deferPaint) window.requestAnimationFrame(paint);
      else paint();
    });
  }
  return {
    window,
    parentPostMessage,
    start() { window.eval(script); },
    active() { return Array.from(window.document.querySelectorAll('.slide')).findIndex(slide => slide.classList.contains('active')); },
    firstFrame() { return new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())); },
  };
}

describe('deck initial slide restoration', () => {
  it('restores the cached class-toggle slide before the first animation frame', async () => {
    const f = fixture();
    f.start();
    await f.firstFrame();
    expect(f.active()).toBe(2);
    const states = f.parentPostMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'readable-studio:slide-state');
    expect(states).not.toHaveLength(0);
    expect(states.every(message => message.active === 2)).toBe(true);
  });

  it('restores through the authored runtime so the next native arrow advances from that slide', async () => {
    const f = fixture(slideMarkup, true);
    f.start();
    // Let the existing delayed restoration run too: a visual-only class swap
    // must not leave the framework's private index on its original first slide.
    await new Promise<void>(resolve => f.window.setTimeout(resolve, 130));
    f.window.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
    expect(f.active()).toBe(3);
  });

  it('discovers slides created after bridge startup before their first visible frame', async () => {
    const f = fixture('');
    f.start();
    f.window.document.body.innerHTML = slideMarkup;
    await f.firstFrame();
    expect(f.active()).toBe(2);
  });

  it('restores horizontal scroll instantly rather than animating through earlier slides', async () => {
    const f = fixture();
    const root = f.window.document.documentElement;
    Object.defineProperty(f.window.document, 'scrollingElement', { value: root });
    Object.defineProperties(root, {
      scrollWidth: { value: 4000 },
      clientWidth: { value: 1000 },
    });
    Object.defineProperty(f.window, 'innerWidth', { value: 1000 });
    const scrollTo = vi.fn((options: ScrollToOptions) => { root.scrollLeft = options.left ?? 0; });
    Object.defineProperty(root, 'scrollTo', { value: scrollTo });
    Object.defineProperty(f.window.document.body, 'scrollTo', { value: () => {} });
    f.start();
    await f.firstFrame();
    expect(root.scrollLeft).toBe(2000);
    expect(scrollTo).toHaveBeenCalledWith({ left: 2000, behavior: 'instant' });
  });

  it('rechecks after authored DOM-ready animation-frame initialization', async () => {
    const f = fixture();
    f.window.document.addEventListener('DOMContentLoaded', () => {
      f.window.requestAnimationFrame(() => {
        f.window.document.querySelectorAll('.slide').forEach((slide, i) => slide.classList.toggle('active', i === 0));
      });
    });
    f.start();
    await f.firstFrame();
    expect(f.active()).toBe(2);
  });

  it('does not undo explicit user navigation when load completes later', async () => {
    const f = fixture(slideMarkup, true);
    f.start();
    f.window.dispatchEvent(new f.window.MessageEvent('message', {
      data: { type: 'readable-studio:slide', action: 'go', index: 1 },
    }));
    f.window.dispatchEvent(new f.window.Event('load'));
    await f.firstFrame();
    expect(f.active()).toBe(1);
  });

  it('keeps an authored runtime index synchronized when its paint is deferred to the next frame', async () => {
    const f = fixture(slideMarkup, true, true);
    f.start();
    await f.firstFrame();
    expect(f.active()).toBe(2);
    f.window.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
    await f.firstFrame();
    expect(f.active()).toBe(3);
  });

  it.each([0, 2, 3])('keeps automatic cached restoration to slide %s active through author boot', async (index) => {
    const f = fixture();
    f.window.document.addEventListener('DOMContentLoaded', () => {
      f.window.requestAnimationFrame(() => {
        f.window.document.querySelectorAll('.slide').forEach((slide, i) => slide.classList.toggle('active', i === (index === 0 ? 1 : 0)));
      });
    });
    f.start();
    f.window.dispatchEvent(new f.window.MessageEvent('message', {
      data: { type: 'readable-studio:slide', action: 'go', index, restore: true },
    }));
    await f.firstFrame();
    expect(f.active()).toBe(index);
  });

  it('keeps an authored initial slide when no cached restoration was requested', async () => {
    const f = fixture(slideMarkup, false, false, 0);
    f.window.document.querySelectorAll('.slide').forEach((slide, i) => slide.classList.toggle('active', i === 1));
    f.start();
    await f.firstFrame();
    expect(f.active()).toBe(1);
  });

  it('ignores a late automatic restoration after explicit user navigation', async () => {
    const f = fixture();
    f.start();
    for (const data of [
      { type: 'readable-studio:slide', action: 'go', index: 1 },
      { type: 'readable-studio:slide', action: 'go', index: 2, restore: true },
    ]) f.window.dispatchEvent(new f.window.MessageEvent('message', { data }));
    await f.firstFrame();
    expect(f.active()).toBe(1);
  });
});
