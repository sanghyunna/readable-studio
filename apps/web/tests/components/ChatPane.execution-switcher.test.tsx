// @vitest-environment jsdom

/**
 * Workspace chat composer: agent button, then model button, then Send.
 *
 * The workspace composer shows the same pair the Hub composer footer does, and
 * both are mounts of the ONE `InlineModelSwitcher` (variant `agent` / `model`),
 * so these tests pin the parts this lane owns: that ChatPane really mounts two
 * distinct triggers into the composer footer in that left-to-right order, that
 * each popover carries only its own concern, and that picking a model reaches
 * the app-level config mutator the project's runs read. Nothing here asserts
 * decoration — a pair that renders but cannot change the config would pass a
 * presence-only test and fail the user.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatPane } from '../../src/components/ChatPane';
import { DEFAULT_CONFIG } from '../../src/state/config';
import type { AgentInfo, AppConfig, Conversation, ProjectMetadata } from '../../src/types';

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => undefined, t: (key: string) => key }),
  useT: () => (key: string) => key,
}));

// The switcher polls the daemon for AMR login state when its panel opens; jsdom
// has no daemon. Stub the transport so the popover renders its real content.
vi.mock('../../src/providers/daemon', () => ({
  fetchVelaLoginStatus: async () => null,
  startVelaLogin: async () => ({ ok: false }),
  cancelVelaLogin: async () => undefined,
}));

vi.mock('../../src/providers/provider-models', () => ({
  fetchProviderModels: async () => ({ ok: false, models: [] }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const conversations: Conversation[] = [
  { id: 'conv-1', projectId: 'project-1', title: 'Conversation 1', createdAt: 1, updatedAt: 1 },
];

const projectMetadata: ProjectMetadata = { kind: 'prototype' };

const AGENTS: AgentInfo[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    available: true,
    models: [
      { id: 'sonnet', label: 'Sonnet 4.5' },
      { id: 'opus', label: 'Opus 4.1' },
    ],
  } as AgentInfo,
  {
    id: 'codex',
    name: 'Codex',
    available: true,
    models: [{ id: 'gpt-5', label: 'GPT-5' }],
  } as AgentInfo,
];

const CONFIG: AppConfig = {
  ...DEFAULT_CONFIG,
  mode: 'daemon',
  agentId: 'claude',
  agentModels: { claude: { model: 'sonnet' } },
};

function renderPane(extra: Partial<React.ComponentProps<typeof ChatPane>> = {}) {
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
      {...extra}
    />,
  );
}

describe('workspace chat composer: agent + model execution pair', () => {
  it('renders agent and model as two distinct controls, agent first, then Send', () => {
    renderPane();

    const slot = screen.getByTestId('composer-execution-switcher');
    const agent = screen.getByTestId('inline-model-switcher-agent-trigger');
    const model = screen.getByTestId('inline-model-switcher-model-trigger');
    const send = screen.getByTestId('chat-send');

    // Two separate triggers, not one combined chip.
    expect(agent).not.toBe(model);
    expect(screen.queryByTestId('inline-model-switcher-chip')).toBeNull();

    // Both really live in the composer footer slot.
    expect(slot.contains(agent)).toBe(true);
    expect(slot.contains(model)).toBe(true);

    // Left-to-right: agent, then model, then Send.
    expect(agent.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(model.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();

    // Pin the full footer sequence, not just the pairwise gaps: the pair must
    // precede the session-mode toggle too. Asserting only agent<model<send
    // still passes with the pair stranded after the toggle.
    const toggle = document.querySelector('.session-mode-toggle__trigger');
    expect(toggle).not.toBeNull();
    expect(model.compareDocumentPosition(toggle!) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();

    const footer = slot.parentElement!;
    const order = Array.from(
      footer.querySelectorAll(
        '[data-testid="inline-model-switcher-agent-trigger"],' +
        '[data-testid="inline-model-switcher-model-trigger"],' +
        '.session-mode-toggle__trigger,' +
        '[data-testid="chat-send"]',
      ),
    );
    expect(order).toEqual([agent, model, toggle, send]);
  });

  it('opens only the agent concern from the agent button', () => {
    renderPane();

    fireEvent.click(screen.getByTestId('inline-model-switcher-agent-trigger'));

    const popover = screen.getByTestId('inline-model-switcher-agent-popover');
    // Every installed agent is offered...
    expect(within(popover).getByTestId('inline-model-switcher-agent-claude')).toBeTruthy();
    expect(within(popover).getByTestId('inline-model-switcher-agent-codex')).toBeTruthy();
    // ...and the model picker is not, so the button opens one concern only.
    expect(screen.queryByTestId('inline-model-switcher-agent-model')).toBeNull();
    expect(screen.queryByTestId('inline-model-switcher-model-popover')).toBeNull();
  });

  it('opens only the model concern from the model button', () => {
    renderPane();

    fireEvent.click(screen.getByTestId('inline-model-switcher-model-trigger'));

    const popover = screen.getByTestId('inline-model-switcher-model-popover');
    // The model button opens the model LIST directly — not a panel containing
    // another control the user must then operate.
    expect(within(popover).getByTestId('inline-model-switcher-model-list')).toBeTruthy();
    expect(within(popover).queryByTestId('inline-model-switcher-agent-model')).toBeNull();
    // No agent grid and no mode segmented control on the model button.
    expect(screen.queryByTestId('inline-model-switcher-agent-claude')).toBeNull();
    expect(screen.queryByTestId('inline-model-switcher-mode-daemon')).toBeNull();
  });

  it('blocks an unselected-model send and warns through the shared model trigger', () => {
    const onSend = vi.fn();
    renderPane({
      config: { ...CONFIG, agentModels: {} },
      initialDraft: 'hello',
      onSend,
    });

    fireEvent.click(screen.getByTestId('chat-send'));

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('inline-model-switcher-model-trigger').className)
      .toContain('is-model-warning');
    expect(screen.getByTestId('inline-model-switcher-model-toast').textContent)
      .toBe('inlineSwitcher.modelSelectionRequired');
  });

  it('routes a model pick to the config mutator for the active agent', () => {
    const onAgentModelChange = vi.fn();
    renderPane({ onAgentModelChange });
    // The switcher normalizes the current choice on mount; only the pick below
    // is under test, so ignore anything recorded before the click.
    onAgentModelChange.mockClear();

    // One click to open, one click to pick.
    fireEvent.click(screen.getByTestId('inline-model-switcher-model-trigger'));
    fireEvent.click(screen.getByText('Opus 4.1'));

    expect(onAgentModelChange).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ model: 'opus' }),
    );
  });

  it('routes an agent pick to the config mutator', () => {
    const onAgentChange = vi.fn();
    renderPane({ onAgentChange });

    fireEvent.click(screen.getByTestId('inline-model-switcher-agent-trigger'));
    fireEvent.click(screen.getByTestId('inline-model-switcher-agent-codex'));

    expect(onAgentChange).toHaveBeenCalledWith('codex');
  });

  it('renders no pair when the surface supplies no execution wiring', () => {
    renderPane({
      config: undefined,
      agents: undefined,
      onAgentChange: undefined,
      onAgentModelChange: undefined,
    });

    expect(screen.queryByTestId('composer-execution-switcher')).toBeNull();
    // Send survives regardless — the pair is additive, it replaces nothing.
    expect(screen.getByTestId('chat-send')).toBeTruthy();
  });

  it('still mounts a working CLI pair when only the CLI mutators are threaded', () => {
    // A surface can wire agent/model selection without the BYOK callbacks. The
    // pair must not be all-or-nothing on props that surface does not thread.
    const onAgentModelChange = vi.fn();
    renderPane({
      onApiProtocolChange: undefined,
      onApiModelChange: undefined,
      onAgentModelChange,
    });
    onAgentModelChange.mockClear();

    expect(screen.getByTestId('inline-model-switcher-agent-trigger')).toBeTruthy();
    fireEvent.click(screen.getByTestId('inline-model-switcher-model-trigger'));
    fireEvent.click(screen.getByText('Opus 4.1'));

    expect(onAgentModelChange).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ model: 'opus' }),
    );
  });

  it('keeps the session-mode toggle alongside the new pair', () => {
    const { container } = renderPane();

    // The workspace composer's Design/Ask toggle is not part of this change;
    // its removal applied to the Hub composer only.
    expect(container.querySelector('.session-mode-toggle__trigger')).not.toBeNull();
  });
});
