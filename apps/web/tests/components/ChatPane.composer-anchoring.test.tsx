// @vitest-environment jsdom

/**
 * The workspace composer must live INSIDE its chat column.
 *
 * It used to be portaled to `document.body` as a `position: fixed` layer whose
 * `left`/`bottom`/`width` were copied from the in-pane slot's
 * `getBoundingClientRect()`. The slot sits under the keyed surface wrapper,
 * which animates with a transform, and transforms never fire ResizeObserver,
 * so the copied coordinates went stale during the Hub -> workspace entrance
 * and under browser zoom: the composer (and its Send button) drifted away
 * from the pane it belongs to.
 *
 * Anchoring is structural now: the composer is a real child of the pane's
 * slot, so no coordinate ever has to be measured or replayed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatPane } from '../../src/components/ChatPane';
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

const chatCss = readFileSync(resolve(__dirname, '../../src/styles/chat.css'), 'utf8');
const viewerRoutinesCss = readFileSync(
  resolve(__dirname, '../../src/styles/viewer/routines.css'),
  'utf8',
);

function installComposerCascade(): () => void {
  // index.css imports chat.css before the viewer overrides. Loading both here
  // exercises the winning cascade, rather than accepting a declaration from
  // an earlier stylesheet that a later workspace rule can replace.
  const style = document.createElement('style');
  style.textContent = `${chatCss}\n${viewerRoutinesCss}`;
  document.head.append(style);
  return () => style.remove();
}

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

// jsdom has no layout, so every rect is 0x0 and the old body portal never
// engaged. Give the slot a real on-screen box: this is the exact condition
// under which the fixed layer used to leave the pane.
function giveLayoutToEverything() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
    return {
      x: 320,
      y: 420,
      left: 320,
      top: 420,
      right: 800,
      bottom: 700,
      width: 480,
      height: 280,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

function renderPane() {
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
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ChatPane composer anchoring', () => {
  it('keeps the composer and its Send button inside the pane slot once the slot has a box', () => {
    giveLayoutToEverything();
    const { container } = renderPane();

    const pane = container.querySelector('.pane');
    const slot = container.querySelector('.chat-composer-slot');
    const send = screen.getByTestId('chat-send');
    expect(pane).not.toBeNull();
    expect(slot).not.toBeNull();

    // Structural containment, not coordinates: the button is a descendant of
    // the slot, which is a descendant of the pane. A body-level portal fails
    // both checks even when its copied numbers happen to be right.
    expect(slot!.contains(send)).toBe(true);
    expect(pane!.contains(send)).toBe(true);
    expect(document.body.querySelector(':scope > .chat-composer-fixed-layer')).toBeNull();
    expect(slot!.getAttribute('aria-hidden')).toBeNull();
  });

  it('carries no measured viewport coordinates that a transform or zoom could stale', () => {
    giveLayoutToEverything();
    const { container } = renderPane();

    const layer = container.querySelector<HTMLElement>('.chat-composer-fixed-layer');
    expect(layer).not.toBeNull();
    // No inline left/bottom/width: the only way the composer follows the pane
    // through an entrance transform or a zoom change is by being laid out in
    // it, never by replaying a rect that ResizeObserver cannot refresh.
    expect(layer!.style.left).toBe('');
    expect(layer!.style.bottom).toBe('');
    expect(layer!.style.width).toBe('');
  });

  it('wins the stylesheet cascade as relative and in-flow, never absolute', () => {
    const removeCascade = installComposerCascade();
    try {
      const { container } = renderPane();
      const layer = container.querySelector<HTMLElement>('.chat-composer-fixed-layer');
      expect(layer).not.toBeNull();

      // This is deliberately a positive computed-style contract. A negative
      // "not fixed" check would let `position: absolute` pass even though it
      // detaches the composer from its slot.
      expect(getComputedStyle(layer!).position).toBe('relative');
      expect(getComputedStyle(layer!).position).not.toBe('absolute');
      expect(getComputedStyle(layer!).position).not.toBe('fixed');
    } finally {
      removeCascade();
    }
  });
});
