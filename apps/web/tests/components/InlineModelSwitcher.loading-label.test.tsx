// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import { HomeHero } from '../../src/components/HomeHero';
import { ChatComposer } from '../../src/components/ChatComposer';
import { MODEL_SELECTION_REQUIRED_EVENT } from '../../src/components/agentModelSelection';
import type { AgentInfo, AppConfig } from '../../src/types';

vi.mock('../../src/i18n', () => {
  const t = (key: string) => ({
    'inlineSwitcher.modelUnselected': '선택없음',
    'common.loading': '불러오는 중…',
  }[key] ?? key);
  return { useT: () => t, useI18n: () => ({ locale: 'ko', t, setLocale: vi.fn() }) };
});
vi.mock('../../src/state/mcp', () => ({ fetchMcpServers: async () => null }));
vi.mock('../../src/state/projects', () => ({ listPlugins: async () => [], patchProject: async () => null }));
vi.mock('../../src/providers/registry', () => ({
  projectRawUrl: () => '', uploadProjectFiles: async () => ({ uploaded: [], failed: [] }),
}));
vi.mock('../../src/providers/provider-models', () => ({ fetchProviderModels: vi.fn() }));
afterEach(cleanup);

const config: AppConfig = {
  mode: 'daemon', apiKey: '', apiProtocol: 'anthropic', apiVersion: '',
  baseUrl: '', model: '', apiProviderBaseUrl: '', apiProtocolConfigs: {},
  agentId: 'codex', skillId: null, designSystemId: null, onboardingCompleted: true,
  agentModels: { codex: { model: 'gpt-6-luna' } }, agentCliEnv: {},
};
const agent: AgentInfo = {
  id: 'codex', name: 'Codex', bin: 'codex', available: true,
  models: [{ id: 'gpt-6-luna', label: 'GPT-6-Luna' }],
};

function composer(surface: 'hub' | 'workspace', loading: boolean, saved: boolean) {
  const switcher = <InlineModelSwitcher
    variant="model" config={{ ...config, agentModels: saved ? config.agentModels : {} }}
    agents={loading ? [] : [agent]} agentsLoading={loading} daemonLive
    onModeChange={vi.fn()} onAgentChange={vi.fn()} onAgentModelChange={vi.fn()}
    onApiProtocolChange={vi.fn()} onApiModelChange={vi.fn()} onOpenSettings={vi.fn()}
  />;
  return surface === 'hub' ? <HomeHero
    surface="hub" prompt="hello" onPromptChange={vi.fn()} onSubmit={vi.fn()}
    activePluginTitle={null} activeChipId={null} onClearActivePlugin={vi.fn()}
    pluginOptions={[]} pluginsLoading={false} pendingPluginId={null} pendingChipId={null}
    onPickPlugin={vi.fn()} onPickChip={vi.fn()} contextItemCount={0} error={null}
    selectedPluginContexts={[]} selectedMcpContexts={[]} mcpOptions={[]} designSystems={[]}
    executionSwitcher={switcher} submitLoading={loading}
  /> : <ChatComposer
    projectId="project-1" projectFiles={[]} streaming={false} initialDraft="hello"
    onEnsureProject={async () => 'project-1'} onSend={vi.fn()} onStop={vi.fn()}
    executionSwitcher={switcher} modelSelectionLoading={loading}
  />;
}

for (const surface of ['hub', 'workspace'] as const) {
  describe(`${surface} model label`, () => {
    it('retains a saved identity with a spinner while discovery loads, then resolves its label', () => {
      const view = render(composer(surface, true, true));
      const trigger = screen.getByTestId('inline-model-switcher-model-trigger');
      expect(screen.getByTestId('inline-model-switcher-model-label').textContent).toBe('gpt-6-luna');
      expect(trigger.getAttribute('aria-busy')).toBe('true');
      expect(trigger.querySelector('.icon-spin')).not.toBeNull();
      expect(screen.queryByTestId('inline-model-switcher-model-warning-mark')).toBeNull();
      fireEvent(window, new Event(MODEL_SELECTION_REQUIRED_EVENT));
      expect(screen.queryByTestId('inline-model-switcher-model-toast')).toBeNull();
      const send = screen.getByTestId(surface === 'hub' ? 'home-hero-submit' : 'chat-send');
      expect((send as HTMLButtonElement).disabled).toBe(true);
      view.rerender(composer(surface, false, true));
      expect(screen.getByTestId('inline-model-switcher-model-label').textContent).toBe('GPT-6-Luna');
      expect(trigger.getAttribute('aria-busy')).toBeNull();
      expect(trigger.querySelector('.icon-spin')).toBeNull();
      expect(screen.queryByTestId('inline-model-switcher-model-warning-mark')).toBeNull();
      expect((send as HTMLButtonElement).disabled).toBe(false);
    });

    it('uses a neutral loading label when no saved identity is known', () => {
      render(composer(surface, true, false));
      expect(screen.getByTestId('inline-model-switcher-model-label').textContent).toBe('불러오는 중…');
      expect(screen.queryByTestId('inline-model-switcher-model-warning-mark')).toBeNull();
    });

    it('reserves 선택없음 and its red warning for resolved no-selection', () => {
      render(composer(surface, false, false));
      expect(screen.getByTestId('inline-model-switcher-model-label').textContent).toBe('선택없음!');
      expect(screen.getByTestId('inline-model-switcher-model-warning-mark').textContent).toBe('!');
      fireEvent(window, new Event(MODEL_SELECTION_REQUIRED_EVENT));
      expect(screen.getByTestId('inline-model-switcher-model-trigger').className).toContain('is-model-warning');
      expect(screen.getByTestId('inline-model-switcher-model-toast')).toBeTruthy();
    });
  });
}
