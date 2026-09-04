// @vitest-environment jsdom
//
// The execution switcher is mounted from two anchors: the entry top bar
// (top-right of the viewport) and the Hub composer footer (bottom-right of the
// centered composer card). A fixed edge cannot satisfy both — from the footer
// anchor the 320px panel used to render at x=1139 in a 1400px viewport and be
// clipped by the right edge. Placement is now measured and clamped, so these
// tests assert the panel's right edge stays inside the viewport from either
// anchor while the popover's contents and behavior stay untouched.
//
// The panel is a body-level fixed layer, so its measured left/top are in
// viewport space rather than relative to the anchor.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InlineModelSwitcher,
  popoverHorizontalOffset,
  popoverVerticalOffset,
} from '../../src/components/InlineModelSwitcher';
import type { AgentInfo, AppConfig } from '../../src/types';

const POPOVER_WIDTH = 320;
const MARGIN = 12;

const baseConfig: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  agentId: 'codex',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  agentModels: {},
  agentCliEnv: {},
};

const codexAgent: AgentInfo = {
  id: 'codex',
  name: 'Codex CLI',
  bin: 'codex',
  available: true,
  version: '0.133.0',
  models: [{ id: 'default', label: 'Default' }],
};

/** Anchor geometry for the two real mount points at a 1400px viewport.
 *  The Hub chip sits low in the centred composer; the top-bar chip sits high. */
const HUB_FOOTER_ANCHOR = { left: 1139, width: 132, top: 690, height: 30 };
const TOP_BAR_ANCHOR = { left: 1248, width: 140, top: 12, height: 32 };
const POPOVER_HEIGHT = 188;
const VIEWPORT_HEIGHT = 800;

function renderSwitcher() {
  return render(
    <InlineModelSwitcher
      config={baseConfig}
      agents={[codexAgent]}
      daemonLive
      onModeChange={vi.fn()}
      onAgentChange={vi.fn()}
      onAgentModelChange={vi.fn()}
      onApiProtocolChange={vi.fn()}
      onApiModelChange={vi.fn()}
      onOpenSettings={vi.fn()}
    />,
  );
}

type Anchor = { left: number; width: number; top: number; height: number };

/** jsdom has no layout: feed the component the anchor box and panel size. */
function stubLayout(anchor: Anchor, viewportWidth: number) {
  vi.stubGlobal('innerWidth', viewportWidth);
  vi.stubGlobal('innerHeight', VIEWPORT_HEIGHT);
  const wrap = document.querySelector<HTMLElement>('.inline-switcher');
  if (!wrap) throw new Error('switcher wrapper not mounted');
  wrap.getBoundingClientRect = () =>
    ({
      left: anchor.left,
      right: anchor.left + anchor.width,
      width: anchor.width,
      top: anchor.top,
      bottom: anchor.top + anchor.height,
      height: anchor.height,
      x: anchor.left,
      y: anchor.top,
      toJSON: () => ({}),
    }) as DOMRect;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return this.classList.contains('inline-switcher__popover') ? POPOVER_WIDTH : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return this.classList.contains('inline-switcher__popover') ? POPOVER_HEIGHT : 0;
    },
  });
}

/** Viewport-space left edge of the body-level panel. */
function popoverLeft(): number {
  const popover = screen.getByTestId('inline-model-switcher-popover');
  const left = popover.style.left;
  expect(left).not.toBe('');
  return Number.parseFloat(left);
}

/** Viewport-space top edge of the body-level panel. */
function popoverTop(): number {
  const popover = screen.getByTestId('inline-model-switcher-popover');
  const top = popover.style.top;
  expect(top).not.toBe('');
  return Number.parseFloat(top);
}

describe('popoverHorizontalOffset', () => {
  it('keeps the panel inside the right viewport edge from a bottom-right anchor', () => {
    // The measured Hub footer regression: anchor at x=1139 in a 1400 viewport.
    const offset = popoverHorizontalOffset(1139, 132, POPOVER_WIDTH, 1400, MARGIN);
    const left = 1139 + offset;

    expect(left + POPOVER_WIDTH).toBeLessThanOrEqual(1400 - MARGIN);
    expect(left).toBeGreaterThanOrEqual(MARGIN);
  });

  it('keeps the panel inside the left viewport edge from a left-hand anchor', () => {
    const offset = popoverHorizontalOffset(8, 120, POPOVER_WIDTH, 1400, MARGIN);
    const left = 8 + offset;

    expect(left).toBeGreaterThanOrEqual(MARGIN);
    expect(left + POPOVER_WIDTH).toBeLessThanOrEqual(1400 - MARGIN);
  });

  it('stays within a viewport narrower than the panel itself', () => {
    const offset = popoverHorizontalOffset(180, 60, POPOVER_WIDTH, 300, MARGIN);
    const left = 180 + offset;

    expect(left).toBe(MARGIN);
  });

  it('right-aligns to the anchor when there is room on both sides', () => {
    const offset = popoverHorizontalOffset(600, 140, POPOVER_WIDTH, 1400, MARGIN);

    expect(600 + offset + POPOVER_WIDTH).toBe(740);
  });
});

describe('popoverVerticalOffset', () => {
  it('opens below a top-bar anchor when there is room', () => {
    const top = popoverVerticalOffset(12, 32, POPOVER_HEIGHT, VIEWPORT_HEIGHT, MARGIN, 8);

    expect(top).toBe(12 + 32 + 8);
    expect(top + POPOVER_HEIGHT).toBeLessThanOrEqual(VIEWPORT_HEIGHT - MARGIN);
  });

  it('flips above a composer-footer anchor that has no room below', () => {
    const top = popoverVerticalOffset(690, 30, POPOVER_HEIGHT, VIEWPORT_HEIGHT, MARGIN, 8);

    expect(top).toBe(690 - 8 - POPOVER_HEIGHT);
    expect(top).toBeGreaterThanOrEqual(MARGIN);
  });

  it('clamps into the viewport when neither side fits', () => {
    const top = popoverVerticalOffset(100, 30, 400, 300, MARGIN, 8);

    expect(top).toBeGreaterThanOrEqual(MARGIN);
    expect(top).toBe(MARGIN);
  });
});

describe('InlineModelSwitcher popover placement', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    // Remove the size overrides installed by stubLayout.
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
  });

  it('does not overflow the right viewport edge from the Hub footer anchor', () => {
    renderSwitcher();
    stubLayout(HUB_FOOTER_ANCHOR, 1400);
    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));

    const left = popoverLeft();

    expect(left + POPOVER_WIDTH).toBeLessThanOrEqual(1400);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(screen.getByTestId('inline-model-switcher-popover').style.right).toBe('auto');
  });

  it('does not overflow from the top-bar anchor at a narrow width', () => {
    renderSwitcher();
    stubLayout(TOP_BAR_ANCHOR, 900);
    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));

    const left = popoverLeft();

    expect(left + POPOVER_WIDTH).toBeLessThanOrEqual(900);
    expect(left).toBeGreaterThanOrEqual(0);
  });

  it('keeps the panel inside the bottom edge from the Hub footer anchor', () => {
    renderSwitcher();
    stubLayout(HUB_FOOTER_ANCHOR, 1400);
    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));

    const top = popoverTop();

    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + POPOVER_HEIGHT).toBeLessThanOrEqual(VIEWPORT_HEIGHT);
    // Flipped above the low anchor rather than pushed off the bottom.
    expect(top + POPOVER_HEIGHT).toBeLessThanOrEqual(HUB_FOOTER_ANCHOR.top);
  });

  it('keeps the top-bar panel below its anchor', () => {
    renderSwitcher();
    stubLayout(TOP_BAR_ANCHOR, 1400);
    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));

    expect(popoverTop()).toBeGreaterThanOrEqual(
      TOP_BAR_ANCHOR.top + TOP_BAR_ANCHOR.height,
    );
  });

  it('re-places the panel when the viewport resizes while open', () => {
    renderSwitcher();
    stubLayout(HUB_FOOTER_ANCHOR, 1400);
    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    const wide = popoverLeft();

    vi.stubGlobal('innerWidth', 1000);
    fireEvent(window, new Event('resize'));
    const narrow = popoverLeft();

    expect(wide).not.toBe(narrow);
    expect(narrow + POPOVER_WIDTH).toBeLessThanOrEqual(1000);
  });

  it('keeps Escape closing the panel', () => {
    renderSwitcher();
    stubLayout(HUB_FOOTER_ANCHOR, 1400);
    const chip = screen.getByTestId('inline-model-switcher-chip');
    fireEvent.click(chip);
    expect(screen.getByTestId('inline-model-switcher-popover')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();
    expect(chip.getAttribute('aria-expanded')).toBe('false');
  });
});
