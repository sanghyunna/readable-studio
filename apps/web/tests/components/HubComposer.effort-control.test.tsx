// @vitest-environment jsdom

/**
 * Hub composer footer: agent (icon + chevron) -> model -> thinking effort -> Send.
 *
 * The first half mounts the REAL `EntryShell` with the REAL `InlineModelSwitcher`
 * (the stub-free production wiring), so it fails if the hub stops forwarding the
 * effort mount, forwards it in the wrong slot, or gates it on the wrong list.
 * The second half mounts the Hub composer with the shipped stylesheets applied
 * and pins the geometry contract that keeps Send in its reserved place: jsdom
 * has no layout engine, so "never pushed out" is expressed as the cluster's
 * bounded max-content footprint, read from the same rules the browser applies.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import postcss from 'postcss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readConversationsFromListMock } from '../helpers/hub-conversations-mock';

const listConversations = vi.hoisted(() => vi.fn());

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    listConversations,
    listPlugins: async () => [],
    readConversations: readConversationsFromListMock(listConversations),
  };
});
vi.mock('@readable-studio/host', () => ({
  isReadableStudioHostAvailable: () => true,
  pickAndImportHostProject: vi.fn(),
  pickHostWorkingDir: vi.fn(),
}));
vi.mock('../../src/hooks/useRuntimeUser', () => ({ useRuntimeUsername: () => 'winuser' }));
vi.mock('../../src/providers/provider-models', () => ({ fetchProviderModels: vi.fn() }));
vi.mock('../../src/components/EntryNavRail', () => ({ EntryNavRail: () => null }));
vi.mock('../../src/components/DesignsTab', () => ({ DesignsTab: () => null }));
vi.mock('../../src/components/DesignSystemPreviewModal', () => ({ DesignSystemPreviewModal: () => null }));
vi.mock('../../src/components/DesignSystemsTab', () => ({ DesignSystemsTab: () => null }));
vi.mock('../../src/components/IntegrationsView', () => ({ IntegrationsView: () => null }));
vi.mock('../../src/components/PluginsView', () => ({ PluginsView: () => null }));
vi.mock('../../src/components/TasksView', () => ({ TasksView: () => null }));

import { EntryShell } from '../../src/components/EntryShell';
import { HomeHero } from '../../src/components/HomeHero';
import { HubRail } from '../../src/components/hub/HubRail';
import { HubRailProvider } from '../../src/components/hub/HubRailContext';
import { HubRailOverlays } from '../../src/components/hub/HubRailOverlays';
import { useHubRailController } from '../../src/components/hub/useHubRailController';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import {
  composerReasoningOptions,
  effectiveAgentModelChoice,
} from '../../src/components/agentModelSelection';
import type { AgentInfo, AppConfig, Project } from '../../src/types';

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

const originalResizeObserver = globalThis.ResizeObserver;
const originalScrollIntoView = Element.prototype.scrollIntoView;

const PROJECT: Project = {
  id: 'p1',
  name: 'Quarterly report',
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 1,
};

/** Claude-like CLI: one agent-wide effort list shared by every model. */
const CLAUDE: AgentInfo = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  available: true,
  version: '1.0.0',
  models: [
    { id: 'sonnet', label: 'Sonnet 4.5' },
    { id: 'opus', label: 'Opus 4.1' },
  ],
  reasoningOptions: [
    { id: 'low', label: 'Low' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra high' },
  ],
};

/** Codex-like CLI advertising no effort levels at all. */
const CODEX: AgentInfo = {
  id: 'codex',
  name: 'Codex CLI',
  bin: 'codex',
  available: true,
  version: '0.133.0',
  models: [{ id: 'gpt-5', label: 'GPT-5' }],
};

/** Databricks-like agent: nothing agent-wide, effort advertised PER MODEL. */
const DATABRICKS: AgentInfo = {
  id: 'databricks',
  name: 'Databricks',
  bin: 'databricks',
  available: true,
  version: '1.0.0',
  models: [
    {
      id: 'sonnet-endpoint',
      label: 'Sonnet endpoint',
      reasoningOptions: [{ id: 'high', label: 'High' }, { id: 'xhigh', label: 'Extra high' }],
    },
    { id: 'llama-endpoint', label: 'Llama endpoint' },
  ],
  reasoningOptions: [],
};

/** Agent-wide list plus one model that narrows it. */
const NARROWING: AgentInfo = {
  id: 'gateway',
  name: 'Gateway',
  bin: 'gateway',
  available: true,
  version: '1.0.0',
  models: [
    { id: 'wide', label: 'Wide model' },
    {
      id: 'narrow',
      label: 'Narrow model',
      reasoningOptions: [{ id: 'high', label: 'High' }],
    },
  ],
  reasoningOptions: [
    { id: 'minimal', label: 'Minimal' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
  ],
};

const BASE_CONFIG: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  model: '',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  agentId: 'claude',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  agentModels: { claude: { model: 'sonnet' } },
  agentCliEnv: {},
};

type AgentChoice = { model?: string; reasoning?: string };

/**
 * Mirrors App.handleAgentModelChange: the hub's pick merges into
 * `config.agentModels[agentId]`, which is the slot ProjectView reads when it
 * builds the run request (`reasoning: choice?.reasoning ?? null`).
 */
function mergeAgentChoice(config: AppConfig, agentId: string, choice: AgentChoice): AppConfig {
  return {
    ...config,
    agentModels: {
      ...(config.agentModels ?? {}),
      [agentId]: { ...(config.agentModels?.[agentId] ?? {}), ...choice },
    },
  };
}

function Shell({
  agents,
  initialConfig,
  onAgentModelChange,
  onConfigChange,
}: {
  agents: AgentInfo[];
  initialConfig: AppConfig;
  onAgentModelChange: (id: string, choice: AgentChoice) => void;
  onConfigChange: (config: AppConfig) => void;
}) {
  const [config, setConfig] = useState(initialConfig);
  const rail = useHubRailController({
    projects: [PROJECT],
    currentSessionId: null,
    onOpenSession: vi.fn(),
    onNewProject: vi.fn(),
    onOpenProject: vi.fn(),
    onNavigateDestination: vi.fn(),
  });

  return (
    <HubRailProvider value={rail}>
      <HubRail
        onOpenDestination={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenWorkspaceFolder={vi.fn()}
      />
      <EntryShell
        skills={[]}
        designTemplates={[]}
        designSystems={[]}
        projects={[PROJECT]}
        templates={[]}
        defaultDesignSystemId={null}
        config={config}
        agents={agents}
        daemonLive
        onModeChange={vi.fn()}
        onAgentChange={vi.fn()}
        onAgentModelChange={(id, choice) => {
          onAgentModelChange(id, choice);
          setConfig((prev) => {
            const next = mergeAgentChoice(prev, id, choice);
            onConfigChange(next);
            return next;
          });
        }}
        onApiProtocolChange={vi.fn()}
        onApiModelChange={vi.fn()}
        onConfigPersist={vi.fn()}
        onRefreshAgents={vi.fn(() => agents)}
        onThemeChange={vi.fn()}
        onCreateProject={vi.fn(() => true)}
        onCreatePluginShareProject={vi.fn()}
        onOpenNewProject={vi.fn()}
        onOpenProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onRenameProject={vi.fn()}
        onChangeDefaultDesignSystem={vi.fn()}
        onOpenSettings={vi.fn()}
      />
      <HubRailOverlays />
    </HubRailProvider>
  );
}

async function renderShell(agents: AgentInfo[], config: AppConfig) {
  const onAgentModelChange = vi.fn<(id: string, choice: AgentChoice) => void>();
  let latestConfig = config;
  render(
    <Shell
      agents={agents}
      initialConfig={config}
      onAgentModelChange={onAgentModelChange}
      onConfigChange={(next) => { latestConfig = next; }}
    />,
  );
  await screen.findByTestId('home-hero-input');
  return { onAgentModelChange, config: () => latestConfig };
}

function isBefore(a: Element, b: Element): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  listConversations.mockResolvedValue([]);
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  listConversations.mockReset();
  globalThis.ResizeObserver = originalResizeObserver;
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.clearAllMocks();
});

describe('Hub composer: agent chevron + thinking-effort control', () => {
  it('mounts agent (icon + chevron), model, effort, then Send, in that DOM order', async () => {
    await renderShell([CLAUDE, CODEX], BASE_CONFIG);

    const slot = screen.getByTestId('home-hero-agent-model');
    const agent = within(slot).getByTestId('inline-model-switcher-agent-trigger');
    const model = within(slot).getByTestId('inline-model-switcher-model-trigger');
    const effort = within(slot).getByTestId('inline-model-switcher-reasoning-trigger');
    const send = screen.getByTestId('home-hero-submit');

    // Order: agent -> model -> effort -> Send; the effort control is between
    // the model picker and Send, and Send follows the whole slot.
    expect(isBefore(agent, model)).toBe(true);
    expect(isBefore(model, effort)).toBe(true);
    expect(isBefore(effort, send)).toBe(true);
    expect(slot.contains(send)).toBe(false);

    // The agent trigger carries the model picker's chevron, right of its icon.
    const agentChevron = agent.querySelector('.inline-switcher__chip-chevron');
    const modelChevron = model.querySelector('.inline-switcher__chip-chevron');
    expect(agentChevron).not.toBeNull();
    expect(agentChevron!.outerHTML).toBe(modelChevron!.outerHTML);
    expect(agent.lastElementChild).toBe(agentChevron);
    expect(isBefore(agent.querySelector('.inline-switcher__chip-icon')!, agentChevron!)).toBe(true);

    // The effort trigger is a real trigger of the same anchored listbox
    // mechanism the model picker uses, showing the current level.
    expect(effort.getAttribute('aria-haspopup')).toBe('menu');
    expect(effort.querySelector('.inline-switcher__chip-chevron')).not.toBeNull();
    expect(screen.getByTestId('inline-model-switcher-reasoning-label').textContent).toBe('Low');
  });

  it('is absent for an agent that advertises no effort levels', async () => {
    await renderShell([CLAUDE, CODEX], {
      ...BASE_CONFIG,
      agentId: 'codex',
      agentModels: { codex: { model: 'gpt-5' } },
    });

    const slot = screen.getByTestId('home-hero-agent-model');
    expect(within(slot).getByTestId('inline-model-switcher-agent-trigger')).toBeTruthy();
    expect(within(slot).getByTestId('inline-model-switcher-model-trigger')).toBeTruthy();
    // Hidden entirely: no empty or disabled dropdown stands in for it.
    expect(screen.queryByTestId('inline-model-switcher-reasoning-trigger')).toBeNull();
    expect(screen.getByTestId('home-hero-submit')).toBeTruthy();
  });

  it('lets a per-model list override the agent-wide list', async () => {
    // Databricks: nothing agent-wide, so only the endpoint that advertises
    // levels gets the control, and it lists exactly that endpoint's levels.
    await renderShell([DATABRICKS], {
      ...BASE_CONFIG,
      agentId: 'databricks',
      agentModels: { databricks: { model: 'sonnet-endpoint' } },
    });

    fireEvent.click(screen.getByTestId('inline-model-switcher-reasoning-trigger'));
    const list = screen.getByTestId('inline-model-switcher-reasoning-list');
    expect(
      within(list).getAllByRole('option').map((option) => option.textContent),
    ).toEqual(['High', 'Extra high']);
    fireEvent.keyDown(document, { key: 'Escape' });

    // The endpoint with no list of its own falls back to the (empty)
    // agent-wide list: no control at all.
    expect(composerReasoningOptions(
      { ...BASE_CONFIG, agentId: 'databricks', agentModels: { databricks: { model: 'llama-endpoint' } } },
      [DATABRICKS],
    )).toEqual([]);
    cleanup();

    // A non-empty agent-wide list is replaced, not merged, by a model's own.
    await renderShell([NARROWING], {
      ...BASE_CONFIG,
      agentId: 'gateway',
      agentModels: { gateway: { model: 'narrow' } },
    });
    fireEvent.click(screen.getByTestId('inline-model-switcher-reasoning-trigger'));
    expect(
      within(screen.getByTestId('inline-model-switcher-reasoning-list'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['High']);
    fireEvent.keyDown(document, { key: 'Escape' });
    cleanup();

    await renderShell([NARROWING], {
      ...BASE_CONFIG,
      agentId: 'gateway',
      agentModels: { gateway: { model: 'wide' } },
    });
    fireEvent.click(screen.getByTestId('inline-model-switcher-reasoning-trigger'));
    expect(
      within(screen.getByTestId('inline-model-switcher-reasoning-list'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Minimal', 'Medium', 'High']);
  });

  it('routes a picked level into the reasoning field the run sends', async () => {
    const { onAgentModelChange, config } = await renderShell([CLAUDE], BASE_CONFIG);

    fireEvent.click(screen.getByTestId('inline-model-switcher-reasoning-trigger'));
    fireEvent.click(screen.getByTestId('inline-model-switcher-reasoning-option-xhigh'));

    // One transport: the existing per-agent choice mutator, nothing new.
    expect(onAgentModelChange).toHaveBeenCalledExactlyOnceWith('claude', { reasoning: 'xhigh' });
    // ...and the resolved choice ProjectView hands to the run carries it,
    // alongside the model that was already selected.
    expect(effectiveAgentModelChoice(CLAUDE, config().agentModels?.claude))
      .toEqual({ model: 'sonnet', reasoning: 'xhigh' });
    // The list closes and the trigger reflects the pick.
    expect(screen.queryByTestId('inline-model-switcher-reasoning-popover')).toBeNull();
    expect(screen.getByTestId('inline-model-switcher-reasoning-label').textContent).toBe('Extra high');
  });
});

// ---------------------------------------------------------------------------
// Narrow widths: Send keeps its reserved place.
// ---------------------------------------------------------------------------

const readSheet = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

/**
 * Installs the footer rules exactly as shipped (tokens, the base chip, the Hub
 * footer that owns the agent/model/effort triggers) into jsdom's CSSOM,
 * keeping only what the cluster and Send resolve against so computed-style
 * reads stay cheap. At-rules are dropped so the read is the base geometry,
 * not a media-query guess.
 */
function installFooterStyles(): () => void {
  const css = [
    readSheet('src/styles/tokens.css'),
    readSheet('src/styles/home/entry-layout.css'),
    readSheet('src/styles/home/home-hero.css'),
  ].join('\n');
  const root = postcss.parse(css);
  root.walkAtRules((rule) => { rule.remove(); });
  root.walkRules((rule) => {
    if (!/inline-switcher|home-hero__(?:foot|submit|execution-switcher)|:root/.test(rule.selector)) {
      rule.remove();
    }
  });
  const style = document.createElement('style');
  style.textContent = root.toString();
  document.head.append(style);
  return () => style.remove();
}

const px = (value: string) => Number.parseFloat(value) || 0;
/** jsdom keeps the `gap` shorthand unexpanded, so read the longhand first. */
const gapOf = (el: Element) => {
  const { columnGap, gap } = window.getComputedStyle(el);
  return px(/^\d/.test(columnGap) ? columnGap : gap);
};

function renderHubComposer(prompt: string) {
  const onSubmit = vi.fn();
  const switcherProps = {
    config: BASE_CONFIG,
    agents: [CLAUDE],
    daemonLive: true,
    onModeChange: vi.fn(),
    onAgentChange: vi.fn(),
    onAgentModelChange: vi.fn(),
    onApiProtocolChange: vi.fn(),
    onApiModelChange: vi.fn(),
    onOpenSettings: vi.fn(),
  };
  render(
    <div className="home-view--hub">
      <HomeHero
        surface="hub"
        prompt={prompt}
        onPromptChange={vi.fn()}
        onSubmit={onSubmit}
        activePluginTitle={null}
        activeChipId={null}
        onClearActivePlugin={vi.fn()}
        pluginOptions={[]}
        pluginsLoading={false}
        pendingPluginId={null}
        pendingChipId={null}
        onPickPlugin={vi.fn()}
        onPickChip={vi.fn()}
        contextItemCount={0}
        error={null}
        selectedPluginContexts={[]}
        selectedMcpContexts={[]}
        mcpOptions={[]}
        designSystems={[]}
        executionSwitcher={
          <>
            <InlineModelSwitcher {...switcherProps} variant="agent" />
            <InlineModelSwitcher {...switcherProps} variant="model" />
            <InlineModelSwitcher {...switcherProps} variant="reasoning" />
          </>
        }
      />
    </div>,
  );
  return { onSubmit };
}

describe('Hub composer: Send stays in place at narrow widths', () => {
  const restorers: Array<() => void> = [];

  afterEach(() => {
    for (const restore of restorers.splice(0).reverse()) restore();
  });

  it('bounds the cluster so Send is never displaced, and keeps Send reachable', async () => {
    // The narrowest layout tier the Hub styles for (hub.css `@media (max-width:
    // 900px)`, matching the desktop window minimum): the stage column is
    // min(66.6667vw, 960px) wide with clamp(36px, 2.7778vw, 40px) side padding
    // and a 12px + 10px footer inset, so the footer never has less than
    // 600 - 72 - 22 = 506px to lay the cluster and Send out in.
    const NARROWEST_HUB_FOOTER_PX = 506;
    restorers.push(installFooterStyles());
    const { onSubmit } = renderHubComposer('Build a pricing page for the launch');
    await screen.findByTestId('home-hero-input');

    const footRight = document.querySelector<HTMLElement>('.home-hero__foot-right')!;
    const slot = screen.getByTestId('home-hero-agent-model');
    const agent = screen.getByTestId('inline-model-switcher-agent-trigger');
    const model = screen.getByTestId('inline-model-switcher-model-trigger');
    const effort = screen.getByTestId('inline-model-switcher-reasoning-trigger');
    const send = screen.getByTestId('home-hero-submit') as HTMLButtonElement;
    const style = (el: Element) => window.getComputedStyle(el);
    const token = (name: string) =>
      px(style(document.documentElement).getPropertyValue(name).trim());

    // Structure: the cluster is the one flex item that yields; Send is a
    // non-shrinking sibling after it, last in the footer's right group.
    expect(footRight.lastElementChild).toBe(send);
    expect(isBefore(effort, send)).toBe(true);
    expect(style(slot).flexShrink).toBe('1');
    expect(style(slot).minWidth).toBe('0px');
    expect(style(send).flexShrink).toBe('0');
    expect(px(style(send).minWidth)).toBe(34);
    // Nothing in the cluster is positioned out of flow, so the widening and
    // narrowing stays one relative layout.
    for (const el of [slot, agent, model, effort]) {
      expect(['static', 'relative']).toContain(style(el).position || 'static');
    }

    // Geometry: every part of the cluster has a bounded max-content width.
    const labelCap = token('--inline-switcher-trigger-label-max');
    const chevronWidth = (trigger: Element) =>
      Number(trigger.querySelector('.inline-switcher__chip-chevron')!.getAttribute('width'));
    const labelMax = (trigger: Element) => {
      const text = trigger.querySelector('.inline-switcher__chip-text')!;
      const maxWidth = style(text).maxWidth.trim();
      expect(maxWidth).toBe('var(--inline-switcher-trigger-label-max)');
      return labelCap;
    };
    // Agent: icon + chevron only, no label that could grow.
    expect(agent.textContent).toBe('');
    expect(style(agent).width).toBe('auto');
    const iconWidth = px(style(agent.querySelector('.inline-switcher__chip-icon')!).width);
    const agentBound = iconWidth + gapOf(agent) + chevronWidth(agent);
    const modelBound = labelMax(model) + gapOf(model) + chevronWidth(model);
    const effortBound = labelMax(effort) + gapOf(effort) + chevronWidth(effort);
    // The effort mount cannot grow into space the cluster does not have.
    expect(style(effort.parentElement!).flexGrow).toBe('0');
    expect(style(model.parentElement!).flexGrow).toBe('0');
    const slotGap = gapOf(slot);
    const clusterBound = agentBound + slotGap + modelBound + slotGap + effortBound;
    const footGap = gapOf(footRight);
    const sendWidth = px(style(send).width);
    // Sanity on the inputs, so a missing rule cannot pass as a zero-width part.
    expect(labelCap).toBeGreaterThan(0);
    expect(iconWidth).toBeGreaterThan(0);
    expect(gapOf(agent)).toBeGreaterThan(0);
    expect(slotGap).toBeGreaterThan(0);
    expect(footGap).toBeGreaterThan(0);
    expect(sendWidth).toBe(34);
    expect(clusterBound + footGap + sendWidth).toBeLessThanOrEqual(NARROWEST_HUB_FOOTER_PX);

    // Reachable: enabled, focusable and still the button that submits.
    expect(send.disabled).toBe(false);
    send.focus();
    expect(document.activeElement).toBe(send);
    fireEvent.click(send);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
