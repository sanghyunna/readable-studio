// @vitest-environment jsdom

/**
 * Regression guard for the Hub composer's agent + model control.
 *
 * The control is authored once by `InlineModelSwitcher` and owned by
 * `EntryShell`; the hub only forwards that node down to `HomeView`. Before
 * this wiring existed, `HubHome` rendered `<HomeView>` with no
 * `executionSwitcher`, so the hub composer footer had zero agent/model
 * controls even though the top bar had one.
 *
 * These tests mount the REAL `InlineModelSwitcher` (no stub node), so they
 * fail both if the hub stops forwarding the prop and if it forwards something
 * that is not the live control. The final test reads `EntryShell` source to
 * pin the other half of the contract: the hub's only caller must actually pass
 * the switcher it already built for the top bar, rather than constructing a
 * second, differently-wired one.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readConversationsFromListMock } from '../helpers/hub-conversations-mock';

const listConversations = vi.hoisted(() => vi.fn());

vi.mock('../../src/state/projects', () => ({
  listConversations,
  readConversations: readConversationsFromListMock(listConversations),
}));

import { TestHubHome as HubHome } from '../helpers/HubTestHost';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import type { AgentInfo, AppConfig, Project } from '../../src/types';

afterEach(() => {
  cleanup();
  listConversations.mockReset();
});

const PROJECTS: Project[] = [
  { id: 'p1', name: 'Report', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 900 },
];

const CONFIG: AppConfig = {
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

const AGENTS: AgentInfo[] = [
  {
    id: 'codex',
    name: 'Codex CLI',
    bin: 'codex',
    available: true,
    version: '0.133.0',
    models: [
      { id: 'default', label: 'Default' },
      { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
    ],
  },
  {
    id: 'amr',
    name: 'AMR (vela)',
    bin: 'amr',
    available: true,
    version: '1.0.0',
    models: [{ id: 'default', label: 'Default' }],
  },
];

/** Renders the hub with the same kind of node EntryShell hands it: a real switcher. */
function renderHubWithRealSwitcher(callbacks: {
  onAgentChange?: (id: string) => void;
  onAgentModelChange?: (id: string, choice: { model?: string; reasoning?: string }) => void;
} = {}) {
  const onAgentChange = callbacks.onAgentChange ?? vi.fn<(id: string) => void>();
  const onAgentModelChange = callbacks.onAgentModelChange ?? vi.fn<
    (id: string, choice: { model?: string; reasoning?: string }) => void
  >();
  const view = render(
    <HubHome
      projects={PROJECTS}
      projectsLoading={false}
      onOpenSession={vi.fn()}
      onSubmitPrompt={vi.fn()}
      onNewProject={vi.fn()}
      executionSwitcher={
        <InlineModelSwitcher
          config={CONFIG}
          agents={AGENTS}
          daemonLive={true}
          onModeChange={vi.fn()}
          onAgentChange={onAgentChange}
          onAgentModelChange={onAgentModelChange}
          onApiProtocolChange={vi.fn()}
          onApiModelChange={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      }
    />,
  );
  return { ...view, onAgentChange, onAgentModelChange };
}

describe('hub composer execution switcher', () => {
  it('renders the real agent/model control in the composer footer', async () => {
    listConversations.mockResolvedValue([]);
    renderHubWithRealSwitcher();
    await screen.findByTestId('home-hero-input');

    const slot = screen.getByTestId('home-hero-agent-model');
    // The live control, not an arbitrary node: its own chip must be inside.
    const chip = within(slot).getByTestId('inline-model-switcher-chip');
    // Regression sentinel — the hub footer must never render zero controls.
    expect(slot.querySelectorAll('[data-testid="inline-model-switcher"]').length)
      .toBe(1);
    // Agent identity and model name both survive into the accessible name,
    // which is the contract the compact presentation relies on.
    expect(chip.getAttribute('aria-label')).toContain('Codex CLI');
    expect(chip.getAttribute('title')).toBe(chip.getAttribute('aria-label'));

    // Send still follows the control in the footer.
    const send = screen.getByTestId('home-hero-submit');
    expect(slot.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it('opens the real switch affordance from the hub footer control', async () => {
    listConversations.mockResolvedValue([]);
    const onAgentChange = vi.fn();
    renderHubWithRealSwitcher({ onAgentChange });
    await screen.findByTestId('home-hero-input');

    const slot = screen.getByTestId('home-hero-agent-model');
    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();

    fireEvent.click(within(slot).getByTestId('inline-model-switcher-chip'));

    // The popover is the shared switch affordance for both the agent token and
    // the model name; it exposes agent choices and the model select.
    const popover = screen.getByTestId('inline-model-switcher-popover');
    expect(within(popover).getByTestId('inline-model-switcher-agent-amr')).toBeTruthy();
    expect(within(popover).getByTestId('inline-model-switcher-agent-model')).toBeTruthy();

    // Functional, not decorative: picking another agent reaches the callback
    // EntryShell wires to real persistence.
    fireEvent.click(within(popover).getByTestId('inline-model-switcher-agent-amr'));
    expect(onAgentChange).toHaveBeenCalledWith('amr');
  });

  it('renders no control when the hub is given no switcher', async () => {
    listConversations.mockResolvedValue([]);
    render(
      <HubHome
        projects={PROJECTS}
        projectsLoading={false}
        onOpenSession={vi.fn()}
        onSubmitPrompt={vi.fn()}
        onNewProject={vi.fn()}
      />,
    );
    await screen.findByTestId('home-hero-input');
    expect(screen.queryByTestId('home-hero-agent-model')).toBeNull();
  });

  it('EntryShell drives every switcher mount from one set of callbacks', () => {
    // jsdom's `import.meta.url` is not a file URL, so resolve from the vitest
    // root (apps/web) instead.
    const source = readFileSync(resolve('src/components/EntryShell.tsx'), 'utf8');
    // Four mounts: the combined top-bar chip plus the composer's agent, model
    // and thinking-effort buttons — all fed by the SAME props object, so agent
    // selection, model selection, effort selection and the provider-models
    // fetch are not forked.
    expect(source.match(/<InlineModelSwitcher\b/g)?.length ?? 0).toBe(4);
    expect(source.match(/\{\.\.\.switcherProps\}/g)?.length ?? 0).toBe(4);
    expect(source).toContain('variant="agent"');
    expect(source).toContain('variant="model"');
    expect(source).toContain('variant="reasoning"');
    // The effort mount is gated by the shared resolver, never by an ad-hoc
    // `reasoningOptions.length` check that would ignore per-model lists.
    expect(source).toContain('composerReasoningOptions(config, agents)');
    // The hub composer gets the split pair; the top bar keeps the combined chip.
    expect(source).toContain('executionSwitcher={composerAgentModelControls}');
    expect(source).toContain('{executionSwitcher}');
  });
});
