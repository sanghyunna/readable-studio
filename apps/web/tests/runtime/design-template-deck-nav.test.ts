import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { DECK_SKELETON_HTML } from '@readable-studio/contracts';
import type { DOMWindow } from 'jsdom';

const tasteEditorialExamplePath = fileURLToPath(
  new URL('../../../../design-templates/html-ppt-taste-editorial/example.html', import.meta.url),
);
const simpleDeckExamplePath = fileURLToPath(
  new URL('../../../../design-templates/simple-deck/example.html', import.meta.url),
);
const kamiDeckTemplatePath = fileURLToPath(new URL('../../../../templates/kami-deck.html', import.meta.url));

function setupTasteEditorialDeck() {
  const html = readFileSync(tasteEditorialExamplePath, 'utf8');
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    url: 'https://example.test/taste-editorial.html',
    virtualConsole: new VirtualConsole(),
  });
  return dom;
}

function setupSimpleDeck() {
  const html = readFileSync(simpleDeckExamplePath, 'utf8');
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    url: 'https://example.test/simple-deck.html',
    virtualConsole: new VirtualConsole(),
  });
  const { window: win } = dom;
  Object.defineProperty(win, 'innerWidth', {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(win.document.body, 'scrollWidth', {
    configurable: true,
    value: 6000,
  });
  Object.defineProperty(win.document.body, 'clientWidth', {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(win.document.documentElement, 'scrollWidth', {
    configurable: true,
    value: 6000,
  });
  Object.defineProperty(win.document.documentElement, 'clientWidth', {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(win.document, 'scrollingElement', {
    configurable: true,
    value: win.document.documentElement,
  });
  let bodyScrollLeft = 0;
  let documentScrollLeft = 0;
  Object.defineProperty(win.document.body, 'scrollLeft', {
    configurable: true,
    get: () => bodyScrollLeft,
    set: (_value: number) => {
      bodyScrollLeft = 0;
    },
  });
  Object.defineProperty(win.document.documentElement, 'scrollLeft', {
    configurable: true,
    get: () => documentScrollLeft,
    set: (value: number) => {
      documentScrollLeft = value;
    },
  });
  Object.defineProperty(win.document.body, 'scrollTo', {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(win.document.documentElement, 'scrollTo', {
    configurable: true,
    value: ({ left }: { left?: number }) => {
      if (typeof left === 'number') {
        documentScrollLeft = left;
      }
    },
  });
  return dom;
}

function activeSlideIndex(win: DOMWindow) {
  const slides = Array.from(win.document.querySelectorAll<HTMLElement>('.deck > .slide'));
  return slides.findIndex((slide) => slide.classList.contains('active'));
}

function fireTouch(win: DOMWindow, startX: number, endX: number) {
  const start = new win.Event('touchstart', { bubbles: true, cancelable: true });
  Object.defineProperty(start, 'touches', {
    value: [{ clientX: startX, clientY: 120 }],
  });
  win.dispatchEvent(start);

  const end = new win.Event('touchend', { bubbles: true, cancelable: true });
  Object.defineProperty(end, 'changedTouches', {
    value: [{ clientX: endX, clientY: 124 }],
  });
  win.dispatchEvent(end);
}

describe('design template deck navigation', () => {
  it('wires the taste editorial example to the deck input contract', () => {
    const dom = setupTasteEditorialDeck();
    const { window: win } = dom;
    const dots = Array.from(win.document.querySelectorAll<HTMLButtonElement>('#deck-nav .dot'));

    expect(win.document.querySelectorAll('.deck > .slide')).toHaveLength(10);
    expect(activeSlideIndex(win)).toBe(0);
    expect(dots).toHaveLength(10);
    expect(dots[0]?.classList.contains('active')).toBe(true);

    win.dispatchEvent(new win.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowRight',
    }));
    expect(activeSlideIndex(win)).toBe(1);

    win.dispatchEvent(new win.WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 90,
    }));
    expect(activeSlideIndex(win)).toBe(2);

    fireTouch(win, 500, 360);
    expect(activeSlideIndex(win)).toBe(3);

    dots[6]?.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(activeSlideIndex(win)).toBe(6);
    expect(dots[6]?.classList.contains('active')).toBe(true);
    expect(dots[6]?.getAttribute('aria-current')).toBe('true');
  });

  it('keeps simple-deck keyboard navigation single-step and synced to documentElement scroll', () => {
    const dom = setupSimpleDeck();
    const { window: win } = dom;
    const counter = win.document.getElementById('counter');

    expect(counter?.textContent?.trim()).toBe('1 / 6');
    expect(win.document.documentElement.scrollLeft).toBe(0);

    win.document.body.dispatchEvent(new win.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowRight',
    }));
    win.document.dispatchEvent(new win.Event('scroll', { bubbles: true }));

    expect(counter?.textContent?.trim()).toBe('2 / 6');
    expect(win.document.documentElement.scrollLeft).toBe(1000);

    win.document.body.dispatchEvent(new win.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowRight',
    }));
    win.document.dispatchEvent(new win.Event('scroll', { bubbles: true }));

    expect(counter?.textContent?.trim()).toBe('3 / 6');
    expect(win.document.documentElement.scrollLeft).toBe(2000);
  });
});

describe('deck framework skeleton navigation', () => {
  it('reveals by pointer proximity with hysteresis and a cancellable hide delay', () => {
    vi.useFakeTimers();
    const dom = new JSDOM(DECK_SKELETON_HTML, {
      runScripts: 'dangerously',
      url: 'https://example.test/deck-autohide.html',
      virtualConsole: new VirtualConsole(),
    });
    const { window: win } = dom;
    const nav = win.document.querySelector('.deck-counter')!;
    const pointer = (distance: number, type = 'pointermove') => {
      win.document.dispatchEvent(new win.MouseEvent(type, {
        bubbles: true,
        clientY: win.innerHeight - distance,
      }));
    };
    try {
      expect(nav.classList.contains('is-open')).toBe(false);
      pointer(73);
      expect(nav.classList.contains('is-open')).toBe(false);
      pointer(72);
      expect(nav.classList.contains('is-open')).toBe(true);
      pointer(160);
      vi.advanceTimersByTime(900);
      expect(nav.classList.contains('is-open')).toBe(true);
      pointer(161);
      vi.advanceTimersByTime(899);
      expect(nav.classList.contains('is-open')).toBe(true);
      pointer(100);
      vi.advanceTimersByTime(900);
      expect(nav.classList.contains('is-open')).toBe(true);
      pointer(161);
      vi.advanceTimersByTime(900);
      expect(nav.classList.contains('is-open')).toBe(false);
      expect(nav.hasAttribute('aria-hidden')).toBe(false);
      win.document.body.dispatchEvent(new win.KeyboardEvent('keydown', {
        bubbles: true, cancelable: true, key: 'ArrowRight',
      }));
      expect(win.document.getElementById('deck-cur')?.textContent).toBe('02');
      pointer(72, 'pointerdown');
      expect(nav.classList.contains('is-open')).toBe(true);
      win.document.dispatchEvent(new win.MouseEvent('pointerout', { relatedTarget: null }));
      vi.advanceTimersByTime(900);
      expect(nav.classList.contains('is-open')).toBe(false);
    } finally {
      dom.window.close();
      vi.useRealTimers();
    }
  });

  it('advances one slide for one ArrowRight keydown', () => {
    const frameworkChromeMarker = '\n    </div>\n  </div>\n\n  <!-- Framework chrome';
    const html = DECK_SKELETON_HTML.replace(
      frameworkChromeMarker,
      '\n      <section class="slide" data-screen-label="03"></section>' + frameworkChromeMarker,
    );
    const dom = new JSDOM(html, {
      pretendToBeVisual: true,
      runScripts: 'dangerously',
      url: 'https://example.test/deck-framework.html',
      virtualConsole: new VirtualConsole(),
    });
    const { window: win } = dom;

    win.document.body.dispatchEvent(new win.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowRight',
    }));

    const slides = Array.from(win.document.querySelectorAll('.slide'));
    const activeIndex = slides.findIndex((slide) => slide.classList.contains('active'));
    expect(activeIndex).toBe(1);
    expect(win.document.getElementById('deck-cur')?.textContent).toBe('02');
  });
});

describe('kami deck template navigation', () => {
  it('advances one slide for one ArrowRight keydown', () => {
    const html = readFileSync(kamiDeckTemplatePath, 'utf8');
    const dom = new JSDOM(html, {
      pretendToBeVisual: true,
      runScripts: 'dangerously',
      url: 'https://example.test/kami-deck.html',
      virtualConsole: new VirtualConsole(),
    });
    const { window: win } = dom;

    win.document.body.dispatchEvent(new win.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowRight',
    }));

    const slides = Array.from(win.document.querySelectorAll('.slide'));
    const activeIndex = slides.findIndex((slide) => slide.classList.contains('active'));
    expect(activeIndex).toBe(1);
    expect(win.document.getElementById('deck-cur')?.textContent).toBe('02');
  });
});
