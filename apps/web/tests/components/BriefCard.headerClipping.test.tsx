// @vitest-environment jsdom

/**
 * The Brief panel, opened from its REAL host: the ChatPane project header.
 *
 * This file exists because the previous coverage could not see the defect that
 * shipped. `BriefCard.test.tsx` renders the card standalone, and
 * `ProjectView.tabs-navigation.test.tsx` replaces `ChatPane` with a mock that
 * merely emits `projectHeader`. Both were green while the live panel was
 * invisible: `ChatPane` wraps `projectHeader` in `.chat-project-header-title`,
 * which carries `overflow: hidden` for the title ellipsis, inside a sticky
 * 38px-tall `.chat-project-header`. Measured on the runtime, the in-flow
 * absolute panel rendered at 385x341 starting 8px BELOW a wrapper whose box
 * ended at y=105 - every painted pixel and every hit target was clipped away.
 *
 * So these tests mount the real ChatPane with a real BriefCard in
 * `projectHeader`, load the real stylesheets into jsdom (the component's own
 * CSS import is stubbed by the test transform), open the panel, and assert
 * structurally that no ancestor between the panel and its stacking root can
 * clip it. Presence of the panel node is deliberately NOT the assertion - that
 * is exactly what passed while the user saw nothing.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { BriefCard } from '../../src/components/BriefCard';
import { ChatPane } from '../../src/components/ChatPane';
import type { ProjectBrief } from '../../src/components/brief-state';
import { DEFAULT_CONFIG } from '../../src/state/config';
import type { AgentInfo, AppConfig, Conversation, ProjectMetadata } from '../../src/types';

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => undefined, t: (key: string) => key }),
  useT: () => (key: string) => key,
}));

vi.mock('../../src/providers/daemon', () => ({
  fetchVelaLoginStatus: async () => null,
  startVelaLogin: async () => ({ ok: false }),
  cancelVelaLogin: async () => undefined,
}));

vi.mock('../../src/providers/provider-models', () => ({
  fetchProviderModels: async () => ({ ok: false, models: [] }),
}));

const CLIPPING_OVERFLOW = new Set(['hidden', 'clip', 'auto', 'scroll']);

/**
 * True when the element establishes a clipping box on either axis.
 *
 * jsdom resolves the `overflow` shorthand but does NOT expand it into
 * `overflowX`/`overflowY`, so reading only the longhands reports `visible` for
 * `.chat-project-header-title` and this whole file would go vacuously green -
 * the same class of blind spot that let the shipped defect through. All three
 * properties are therefore consulted.
 */
function clipsOverflow(element: Element): boolean {
  const computed = getComputedStyle(element);
  return [computed.overflow, computed.overflowX, computed.overflowY]
    .flatMap((value) => value.trim().split(/\s+/))
    .some((value) => CLIPPING_OVERFLOW.has(value));
}

beforeAll(() => {
  // The component's `import './BriefCard.css'` does not produce real CSSOM
  // under the test transform, and `.chat-project-header-title` lives in a
  // stylesheet nobody imports from a component. Load both from disk so the
  // clipping question is answered by the shipped rules, not by a guess.
  const style = document.createElement('style');
  style.textContent = [
    readFileSync(resolve(process.cwd(), 'src/styles/chat.css'), 'utf8'),
    readFileSync(resolve(process.cwd(), 'src/components/BriefCard.css'), 'utf8'),
  ].join('\n');
  document.head.appendChild(style);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const brief: ProjectBrief = {
  updatedAt: 1,
  assumptions: [
    { id: 'output', label: 'Output', value: 'Responsive prototype', provenance: 'stated' },
    { id: 'audience', label: 'Audience', value: 'Product leaders', provenance: 'inferred' },
    { id: 'scale', label: 'Scale', value: '12 sections', provenance: 'default' },
  ],
};

const conversations: Conversation[] = [
  { id: 'conv-1', projectId: 'project-1', title: 'Conversation 1', createdAt: 1, updatedAt: 1 },
];

const projectMetadata: ProjectMetadata = { kind: 'prototype' };

const AGENTS: AgentInfo[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    available: true,
    models: [{ id: 'sonnet', label: 'Sonnet 4.5' }],
  } as AgentInfo,
];

const CONFIG: AppConfig = {
  ...DEFAULT_CONFIG,
  mode: 'daemon',
  agentId: 'claude',
  agentModels: { claude: { model: 'sonnet' } },
};

/**
 * Renders the production composition: ChatPane owns the header wrapper, and
 * BriefCard is handed to it through `projectHeader` exactly as ProjectView
 * does at ProjectView.tsx:5688.
 */
function renderHeaderWithBrief() {
  return render(
    <ChatPane
      projectKindForTracking="prototype"
      messages={[]}
      streaming={false}
      error={null}
      projectId="project-1"
      projectFiles={[]}
      onEnsureProject={async () => 'project-1'}
      onSend={vi.fn()}
      onStop={vi.fn()}
      conversations={conversations}
      activeConversationId="conv-1"
      onSelectConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
      projectMetadata={projectMetadata}
      config={CONFIG}
      agents={AGENTS}
      daemonLive
      onOpenSettings={vi.fn()}
      onModeChange={vi.fn()}
      onAgentChange={vi.fn()}
      onAgentModelChange={vi.fn()}
      onApiProtocolChange={vi.fn()}
      onApiModelChange={vi.fn()}
      projectHeader={(
        <div>
          <span className="title">Brief clip probe</span>
          <BriefCard brief={brief} onChange={() => {}} onSteer={() => {}} />
        </div>
      )}
    />,
  );
}

/** Every ancestor up to (and including) the document element that clips. */
function clippingAncestors(node: Element): Element[] {
  const clippers: Element[] = [];
  let current = node.parentElement;
  while (current) {
    if (clipsOverflow(current)) clippers.push(current);
    current = current.parentElement;
  }
  return clippers;
}

function openPanel(): HTMLElement {
  const trigger = screen.getByRole('button', { name: /brief\.trigger/ });
  fireEvent.click(trigger);
  return screen.getByTestId('brief-card-panel');
}

describe('Brief panel opened from the real ChatPane header', () => {
  it('is not clipped by any ancestor - the header wrapper really does clip', () => {
    renderHeaderWithBrief();

    // The defect's cause, pinned first: the wrapper ChatPane puts around
    // `projectHeader` DOES clip. If this ever stops being true the rest of the
    // file would pass vacuously, so the hazard is asserted rather than assumed.
    const wrapper = document.querySelector('.chat-project-header-title');
    expect(wrapper).not.toBeNull();
    expect(clipsOverflow(wrapper!)).toBe(true);

    const panel = openPanel();

    // The real assertion: nothing on the panel's ancestor chain clips it.
    const clippers = clippingAncestors(panel);
    expect(
      clippers.map((element) => element.className || element.tagName),
    ).toEqual([]);

    // And specifically not the wrapper that caused this bug.
    expect(wrapper!.contains(panel)).toBe(false);
  });

  it('escapes the header without leaving the trigger behind', () => {
    renderHeaderWithBrief();

    const trigger = screen.getByRole('button', { name: /brief\.trigger/ });
    const panel = openPanel();

    // The trigger stays in the header (that is the whole point of the
    // relocation); only the panel is lifted out.
    expect(document.querySelector('.chat-project-header-title')!.contains(trigger)).toBe(true);
    expect(panel.parentElement).toBe(document.body);

    // aria wiring survives the portal, so the panel is still the trigger's
    // announced target across the DOM gap.
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('is placed as a viewport-fixed layer above the sticky chat header', () => {
    renderHeaderWithBrief();

    const panel = openPanel();
    const panelStyle = getComputedStyle(panel);
    const header = document.querySelector('.chat-project-header')!;
    const headerZ = Number.parseInt(getComputedStyle(header).zIndex, 10);
    const panelZ = Number.parseInt(panelStyle.zIndex, 10);

    // Fixed, not absolute: an absolutely positioned panel is placed by its
    // offset parent, which is precisely how it ended up inside a 38px box.
    expect(panelStyle.position).toBe('fixed');
    expect(Number.isFinite(headerZ)).toBe(true);
    expect(panelZ).toBeGreaterThan(headerZ);
  });

  it('closes on Escape and returns focus to the header trigger', () => {
    renderHeaderWithBrief();

    const trigger = screen.getByRole('button', { name: /brief\.trigger/ });
    openPanel();

    // Portaled panels are outside the trigger's subtree, so dismissal is the
    // component's own responsibility - a keyboard user must not be stranded.
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByTestId('brief-card-panel')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('stays inside the viewport at a narrow chat width', () => {
    // A narrow chat column is where an anchor-relative panel runs off-screen:
    // the trigger sits near the right edge, and the panel is wider than the
    // column that hosts it.
    Object.defineProperty(window, 'innerWidth', { value: 420, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 760, configurable: true });

    renderHeaderWithBrief();

    const panel = openPanel();

    // jsdom has no layout, so the measured-placement effect keeps the panel
    // out of the paint until a real box exists. Feed it the geometry the
    // runtime measured (385x341 panel, trigger near the right edge of a narrow
    // column) and re-run placement through a resize.
    const headerTrigger = screen.getByRole('button', { name: /brief\.trigger/ });
    headerTrigger.getBoundingClientRect = () =>
      ({ left: 300, top: 55, width: 110, height: 30, right: 410, bottom: 85, x: 300, y: 55 }) as DOMRect;
    Object.defineProperty(panel, 'offsetWidth', { value: 385, configurable: true });
    Object.defineProperty(panel, 'offsetHeight', { value: 341, configurable: true });
    fireEvent(window, new Event('resize'));

    const left = Number.parseFloat(panel.style.left);
    const top = Number.parseFloat(panel.style.top);
    expect(Number.isFinite(left)).toBe(true);
    expect(Number.isFinite(top)).toBe(true);

    // Fully on-screen on every edge, with the shared 12px viewport gutter.
    expect(left).toBeGreaterThanOrEqual(12);
    expect(left + 385).toBeLessThanOrEqual(420 - 12);
    expect(top).toBeGreaterThanOrEqual(12);
    expect(top + 341).toBeLessThanOrEqual(760 - 12);
    expect(panel.style.visibility).not.toBe('hidden');
  });
});
