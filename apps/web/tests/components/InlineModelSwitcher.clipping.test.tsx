// @vitest-environment jsdom
//
// Regression: the execution switcher's panel was invisible at the Hub composer
// footer. It was not mispositioned and not hidden — it measured 320x188 at the
// right coordinates with `visibility: visible` and `opacity: 1`, and a
// DOM-driven click on it "worked". It was CLIPPED: the Hub composer card sets
// `overflow: hidden` together with `backdrop-filter`, and a backdrop filter
// makes the card a containing block that clips its descendants regardless of
// the overflow value, so `elementFromPoint` at the panel's centre resolved to
// the page behind it instead of into the panel.
//
// A bounding box, a `toBeVisible()` and a fired click all pass on a clipped
// element, so none of them can guard this. What actually decides the outcome is
// whether the panel is laid out INSIDE a clipping ancestor at all. These tests
// assert that structurally — the panel is a body-level fixed layer with no
// clipping ancestor between it and <body> — which is the same condition
// `elementFromPoint` resolves. Removing the portal, or restoring the in-flow
// `position: absolute` panel, fails them.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import type { AgentInfo, AppConfig } from '../../src/types';

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

/**
 * Mounts the switcher inside the real Hub composer ancestry, with the clipping
 * declarations the Hub stylesheet applies to the card. jsdom does not cascade
 * the app stylesheets, so the two properties that caused the bug are set
 * inline — the test then has a genuine clipping ancestor to escape.
 */
function renderInHubComposer() {
  const view = render(
    <div className="home-view home-view--hub">
      <div
        className="home-hero__input-card"
        data-testid="hub-composer-card"
        style={{ overflow: 'hidden', backdropFilter: 'blur(22px)' }}
      >
        <div className="home-hero__foot">
          <div className="home-hero__foot-right">
            <div className="home-hero__execution-switcher home-hero__execution-switcher--agent-model">
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
              />
            </div>
          </div>
        </div>
      </div>
    </div>,
  );
  fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
  return view;
}

/** Mounts the switcher the way the entry top bar does — no clipping ancestor. */
function renderInTopBar() {
  const view = render(
    <div className="entry-main__topbar">
      <div className="entry-main__topbar-chips">
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
        />
      </div>
    </div>,
  );
  fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
  return view;
}

/**
 * The ancestors that would clip the panel: an element between it and <body>
 * that hides overflow or establishes a backdrop-filter containing block. This
 * is the condition `elementFromPoint` at the panel's centre answers in a real
 * browser — if any exists, the centre resolves to the clipper's content, not
 * into the panel.
 */
function clippingAncestors(panel: HTMLElement): string[] {
  const found: string[] = [];
  let node = panel.parentElement;
  while (node && node !== document.body) {
    const style = node.style;
    const overflowClips =
      style.overflow === 'hidden' ||
      style.overflow === 'clip' ||
      style.overflowX === 'hidden' ||
      style.overflowY === 'hidden';
    const filterClips = Boolean(style.backdropFilter || style.filter);
    if (overflowClips || filterClips) {
      found.push(node.className || node.tagName.toLowerCase());
    }
    node = node.parentElement;
  }
  return found;
}

describe('InlineModelSwitcher popover is not clipped away', () => {
  afterEach(cleanup);

  it('escapes the Hub composer card so nothing clips it at the footer mount', () => {
    renderInHubComposer();
    const panel = screen.getByTestId('inline-model-switcher-popover');
    const card = screen.getByTestId('hub-composer-card');

    // The card genuinely clips — the precondition the fix has to survive.
    expect(card.style.overflow).toBe('hidden');
    expect(card.style.backdropFilter).toBe('blur(22px)');

    expect(card.contains(panel)).toBe(false);
    expect(panel.parentElement).toBe(document.body);
    expect(clippingAncestors(panel)).toEqual([]);
  });

  it('renders as a body-level fixed layer with measured viewport coordinates', () => {
    renderInHubComposer();
    const panel = screen.getByTestId('inline-model-switcher-popover');

    // The class the fixed-layer stylesheet rule keys off. Without it the panel
    // falls back to `position: absolute` against an anchor it no longer has.
    expect(panel.classList.contains('inline-switcher__popover--layer')).toBe(true);
    // Surface mirrored onto the portaled node: the ancestry-based context rules
    // cannot reach it any more.
    expect(panel.classList.contains('inline-switcher__popover--home-hero')).toBe(true);
  });

  it('keeps the top-bar mount portaled and unclipped too', () => {
    renderInTopBar();
    const panel = screen.getByTestId('inline-model-switcher-popover');

    expect(panel.parentElement).toBe(document.body);
    expect(clippingAncestors(panel)).toEqual([]);
    // The top bar is not the home hero, so it gets no surface modifier.
    expect(panel.classList.contains('inline-switcher__popover--home-hero')).toBe(false);
  });

  it('removes the layer from the document when closed', () => {
    renderInHubComposer();
    expect(screen.getByTestId('inline-model-switcher-popover')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();
    expect(document.body.querySelector('.inline-switcher__popover')).toBeNull();
  });
});

describe('InlineModelSwitcher popover keyboard and dismissal from the footer', () => {
  afterEach(cleanup);

  it('returns focus to the trigger on Escape', () => {
    renderInHubComposer();
    const chip = screen.getByTestId('inline-model-switcher-chip');

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(document.activeElement).toBe(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('false');
  });

  it('stays open when the portaled panel itself is clicked', () => {
    renderInHubComposer();
    const panel = screen.getByTestId('inline-model-switcher-popover');

    // The panel now lives outside the switcher wrapper, so an unguarded
    // click-outside handler would treat its own content as "outside".
    fireEvent.mouseDown(screen.getByTestId('inline-model-switcher-mode-api'));

    expect(panel.isConnected).toBe(true);
    expect(screen.getByTestId('inline-model-switcher-popover')).toBeTruthy();
  });

  it('closes on a click outside both the trigger and the panel', () => {
    renderInHubComposer();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();
  });
});
