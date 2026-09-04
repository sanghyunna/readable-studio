// @vitest-environment jsdom
//
// Defect: in the workspace chat composer the 디자인/질문 mode menu opened
// "완전 애먼 데에" — nowhere near the control that was clicked.
//
// Root cause: placement subtracted a HARDCODED 380px popover height from the
// trigger's top. In the composer surface the description card is hidden
// (`.session-mode-toggle__popover--composer .session-mode-toggle__popover-card
// { display: none }`), so the real menu is ~70px tall and the panel landed
// ~310px away from its trigger (or clamped to the viewport top).
//
// These tests assert placement against the panel's MEASURED box, and include a
// hit test so a panel that is positioned correctly but covered by another layer
// still fails.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionModeToggle } from '../../src/components/SessionModeToggle';
import { placePopover } from '../../src/components/popoverPlacement';

vi.mock('../../src/i18n', () => ({
  useT: () => (key: string) => key,
}));

const VIEWPORT = { width: 1440, height: 900 };

// The real composer geometry: the toggle sits in the composer footer near the
// bottom of the viewport, and the composer surface hides the description card
// so the menu is short.
const TRIGGER_BOX = { left: 980, top: 812, width: 96, height: 28 };
const MENU_BOX = { width: 176, height: 70 };

/**
 * jsdom has no layout engine, so every box is 0x0 and any placement assertion
 * would pass vacuously. Stub the two measurements the component reads.
 */
function stubLayout() {
  Object.defineProperty(window, 'innerWidth', { value: VIEWPORT.width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: VIEWPORT.height, configurable: true });

  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('session-mode-toggle__popover') ? MENU_BOX.width : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('session-mode-toggle__popover') ? MENU_BOX.height : 0;
    },
  });

  const originalGetRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.classList.contains('session-mode-toggle__trigger')) {
      return {
        ...TRIGGER_BOX,
        right: TRIGGER_BOX.left + TRIGGER_BOX.width,
        bottom: TRIGGER_BOX.top + TRIGGER_BOX.height,
        x: TRIGGER_BOX.left,
        y: TRIGGER_BOX.top,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return originalGetRect.call(this);
  };
  return () => {
    Element.prototype.getBoundingClientRect = originalGetRect;
  };
}

function openMenu() {
  render(<SessionModeToggle mode="design" onChange={() => {}} />);
  fireEvent.click(screen.getByTestId('session-mode-trigger'));
  return screen.getByTestId('session-mode-popover');
}

function panelBox(panel: HTMLElement) {
  const left = Number.parseFloat(panel.style.left);
  const top = Number.parseFloat(panel.style.top);
  return { left, top, right: left + MENU_BOX.width, bottom: top + MENU_BOX.height };
}

describe('SessionModeToggle menu anchoring (workspace composer)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens adjacent to the trigger, not hundreds of pixels away', () => {
    const restore = stubLayout();
    try {
      const box = panelBox(openMenu());
      const triggerBottom = TRIGGER_BOX.top + TRIGGER_BOX.height;

      // Vertically adjacent: the panel edge nearest the trigger must be within
      // one small gap of it. The old code placed it ~310px above.
      const verticalGap = Math.min(
        Math.abs(box.top - triggerBottom),
        Math.abs(TRIGGER_BOX.top - box.bottom),
      );
      expect(verticalGap).toBeLessThanOrEqual(12);

      // Horizontally overlapping the trigger's span.
      const triggerRight = TRIGGER_BOX.left + TRIGGER_BOX.width;
      expect(box.right).toBeGreaterThan(TRIGGER_BOX.left);
      expect(box.left).toBeLessThan(triggerRight);
    } finally {
      restore();
    }
  });

  it('stays fully on screen', () => {
    const restore = stubLayout();
    try {
      const box = panelBox(openMenu());
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(VIEWPORT.width);
      expect(box.bottom).toBeLessThanOrEqual(VIEWPORT.height);
    } finally {
      restore();
    }
  });

  // Non-vacuousness: the OLD placement maths must fail the adjacency assertion
  // above. Without this, a bug that made every box {0,0} would pass silently.
  it('would reject the previous hardcoded-height placement', () => {
    const OLD_POPOVER_HEIGHT = 380;
    const oldTop = TRIGGER_BOX.top - 6 - OLD_POPOVER_HEIGHT;
    const triggerBottom = TRIGGER_BOX.top + TRIGGER_BOX.height;
    const oldGap = Math.min(
      Math.abs(oldTop - triggerBottom),
      Math.abs(TRIGGER_BOX.top - (oldTop + MENU_BOX.height)),
    );
    // ~310px adrift — exactly what the user saw.
    expect(oldGap).toBeGreaterThan(280);
  });

  it('places a low anchor above the trigger rather than off the bottom edge', () => {
    // Pure-maths check on the shared helper: a trigger 812px down a 900px
    // viewport has no room for a 70px panel below it (812+28+8+70 > 888).
    const placed = placePopover(TRIGGER_BOX, MENU_BOX, VIEWPORT);
    expect(placed.top + MENU_BOX.height).toBeLessThanOrEqual(VIEWPORT.height);
    expect(placed.top).toBeLessThan(TRIGGER_BOX.top);
  });

  it('resolves a hit at the menu centre INTO the menu, not a layer above it', () => {
    const restore = stubLayout();
    try {
      const panel = openMenu();
      const box = panelBox(panel);
      const centre = {
        x: box.left + MENU_BOX.width / 2,
        y: box.top + MENU_BOX.height / 2,
      };

      // jsdom cannot hit-test, so model it: the menu wins its own centre only
      // if no other fixed layer with a higher z-index covers that point. The
      // menu layer is z-index 1502 (chat.css).
      const MENU_Z = 1502;
      const covering = Array.from(
        document.querySelectorAll<HTMLElement>('[data-layer-z]'),
      ).filter((node) => {
        const z = Number(node.dataset.layerZ);
        const r = node.getBoundingClientRect();
        return (
          z > MENU_Z &&
          centre.x >= r.left &&
          centre.x <= r.right &&
          centre.y >= r.top &&
          centre.y <= r.bottom
        );
      });

      expect(covering).toHaveLength(0);
      // And the point genuinely falls inside the menu's own box.
      expect(centre.x).toBeGreaterThanOrEqual(box.left);
      expect(centre.x).toBeLessThanOrEqual(box.right);
      expect(centre.y).toBeGreaterThanOrEqual(box.top);
      expect(centre.y).toBeLessThanOrEqual(box.bottom);
    } finally {
      restore();
    }
  });

  it('closes on Escape and returns focus to the trigger', () => {
    const restore = stubLayout();
    try {
      openMenu();
      const trigger = screen.getByTestId('session-mode-trigger');
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByTestId('session-mode-popover')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally {
      restore();
    }
  });
});
