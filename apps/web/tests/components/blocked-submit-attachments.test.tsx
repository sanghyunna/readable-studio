// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { KEY_ENTER_COMMAND } from 'lexical';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntryShell } from '../../src/components/EntryShell';
import { ChatPane } from '../../src/components/ChatPane';
import { HubTestHost } from '../helpers/HubTestHost';
import { DEFAULT_CONFIG } from '../../src/state/config';
import { MODEL_SELECTION_REQUIRED_EVENT } from '../../src/components/agentModelSelection';
import { uploadProjectFiles } from '../../src/providers/registry';
import { composerText, getComposerEditor, typeInComposer } from '../helpers/lexical-composer';
import { getHomeHeroEditor, setHomeHeroPrompt } from '../helpers/home-hero-lexical';
import { serializeComposer } from '../../src/components/composer/serialize';
import type { AgentInfo, ChatAttachment } from '../../src/types';

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => undefined, t: (key: string) => key }),
  useT: () => (key: string) => key,
}));
vi.mock('../../src/state/mcp', () => ({ fetchMcpServers: async () => null }));
vi.mock('../../src/state/projects', async (original) => ({
  ...await original<typeof import('../../src/state/projects')>(),
  listPlugins: async () => [], listConversations: async () => [],
  readConversations: async () => ({ conversations: [], source: 'network' }),
}));
vi.mock('../../src/providers/registry', async (original) => ({
  ...await original<typeof import('../../src/providers/registry')>(),
  uploadProjectFiles: vi.fn(),
}));
vi.mock('../../src/providers/daemon', async (original) => ({
  ...await original<typeof import('../../src/providers/daemon')>(),
  fetchVelaLoginStatus: async () => null,
}));
vi.mock('../../src/hooks/useRuntimeUser', () => ({ useRuntimeUsername: () => 'tester' }));
vi.mock('../../src/components/EntryNavRail', () => ({ EntryNavRail: () => null }));
vi.mock('../../src/components/DesignSystemPreviewModal', () => ({ DesignSystemPreviewModal: () => null }));
vi.mock('../../src/components/DesignSystemsTab', () => ({ DesignSystemsTab: () => null }));
vi.mock('../../src/components/DesignsTab', () => ({ DesignsTab: () => null }));
vi.mock('../../src/components/IntegrationsView', () => ({ IntegrationsView: () => null }));
vi.mock('../../src/components/PluginsView', () => ({ PluginsView: () => null }));
vi.mock('../../src/components/TasksView', () => ({ TasksView: () => null }));

const agent: AgentInfo = {
  id: 'test-agent', name: 'Test Agent', bin: 'agent', available: true,
  models: [{ id: 'test-model', label: 'Test Model' }],
};
const draft = '  Keep every attachment\nand this draft  ';
const attachments: ChatAttachment[] = [
  { path: 'uploads/first.txt', name: 'first.txt', kind: 'file', order: 0 },
  { path: 'uploads/second.txt', name: 'second.txt', kind: 'file', order: 1 },
];

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

for (const surface of ['hub', 'workspace'] as const) {
  for (const trigger of ['Enter', 'button'] as const) {
    describe(`${surface} ${trigger}`, () => {
      it('preserves the complete blocked draft, then sends the same files once and clears the composer', async () => {
        window.history.replaceState(null, '', '/');
        const onAccepted = vi.fn(() => true);
        const warned = vi.fn();
        window.addEventListener(MODEL_SELECTION_REQUIRED_EVENT, warned);
        const files = [new File(['first contents'], 'first.txt'), new File(['second contents'], 'second.txt')];
        vi.mocked(uploadProjectFiles).mockResolvedValue({ uploaded: attachments, failed: [] });
        // Home catalogue requests are unrelated to submission acceptance.
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ plugins: [], projects: [], servers: [], templates: [] }), { status: 200 })));
        function Harness() {
          const [config, setConfig] = useState({ ...DEFAULT_CONFIG, mode: 'daemon' as const, agentId: agent.id, agentModels: {} });
          const execution = {
            config, agents: [agent], daemonLive: true,
            onModeChange: vi.fn(), onAgentChange: vi.fn(),
            onAgentModelChange: (id: string, choice: { model?: string }) => setConfig(current => ({ ...current, agentModels: { [id]: choice } })),
            onApiProtocolChange: vi.fn(), onApiModelChange: vi.fn(), onOpenSettings: vi.fn(),
          };
          return surface === 'hub' ? <HubTestHost projects={[]} currentSessionId={null} onOpenSession={vi.fn()} onNewProject={vi.fn()}><EntryShell {...execution}
            skills={[]} designTemplates={[]} designSystems={[]} projects={[]} templates={[]}
            defaultDesignSystemId={null} onConfigPersist={vi.fn()} onRefreshAgents={vi.fn(() => [])}
            onThemeChange={vi.fn()} onCreateProject={onAccepted} onCreatePluginShareProject={vi.fn()}
            onOpenNewProject={vi.fn()} onOpenProject={vi.fn()} onDeleteProject={vi.fn()}
            onRenameProject={vi.fn()} onChangeDefaultDesignSystem={vi.fn()}
          /></HubTestHost> : <ChatPane {...execution}
            conversations={[]} activeConversationId={null} onSelectConversation={vi.fn()} onDeleteConversation={vi.fn()}
            projectKindForTracking="prototype" messages={[]} streaming={false} error={null}
            projectId="project-1" projectFiles={[]} onEnsureProject={async () => 'project-1'}
            onSend={onAccepted} onStop={vi.fn()}
          />;
        }
        try {
          await act(async () => { render(<Harness />); });
          await act(async () => {
            const fileInput = surface === 'hub'
              ? screen.getByTestId('home-hero-file-input')
              : document.querySelector<HTMLInputElement>('.composer input[type="file"]');
            expect(fileInput).not.toBeNull();
            fireEvent.change(fileInput!, { target: { files } });
          });
          await act(async () => {
            if (surface === 'hub') setHomeHeroPrompt(draft);
            else typeInComposer(draft);
          });
          const editor = surface === 'hub' ? getHomeHeroEditor() : getComposerEditor();
          const text = () => surface === 'hub' ? serializeComposer(editor.getEditorState()).text : composerText();
          const send = screen.getByTestId(surface === 'hub' ? 'home-hero-submit' : 'chat-send');
          const fileChips = () => Array.from(document.querySelectorAll(surface === 'hub'
            ? '.home-hero__active-chip--file .home-hero__active-label'
            : '.staged-row .staged-name')).map(node => node.textContent);
          const beforeChips = fileChips();
          expect(beforeChips).toEqual(['first.txt', 'second.txt']);
          const activate = async () => {
            await act(async () => {
              if (trigger === 'button') fireEvent.click(send);
              else editor.dispatchCommand(KEY_ENTER_COMMAND, new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
            });
          };
          await activate();
          expect(warned).toHaveBeenCalledTimes(1);
          expect(onAccepted).not.toHaveBeenCalled();
          expect(text()).toBe(draft);
          expect(fileChips()).toEqual(beforeChips);
          expect(screen.getByTestId('inline-model-switcher-model-trigger').className).toContain('is-model-warning');
          expect(screen.getByTestId('inline-model-switcher-model-toast')).toBeTruthy();
          expect(screen.queryByTestId('home-hero-error')).toBeNull();
          expect(screen.getByTestId(surface === 'hub' ? 'home-hero-submit' : 'chat-send')).toBe(send);
          await act(async () => { fireEvent.click(screen.getByTestId('inline-model-switcher-model-trigger')); });
          await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'Test Model' })); });
          await activate();
          expect(onAccepted).toHaveBeenCalledTimes(1);
          if (surface === 'hub') {
            const payload = onAccepted.mock.calls[0] as unknown as [{ pendingPrompt: string; pendingFiles: File[]; autoSendFirstMessage: boolean }];
            expect(payload[0].pendingPrompt).toBe(draft.trim());
            expect(payload[0].pendingFiles).toEqual(files);
            const contents = await Promise.all(payload[0].pendingFiles.map(file => new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              const timeout = setTimeout(() => { reader.abort(); reject(new Error('File read timed out')); }, 2000);
              reader.onload = () => { clearTimeout(timeout); resolve(String(reader.result)); };
              reader.onerror = () => { clearTimeout(timeout); reject(reader.error); };
              reader.readAsText(file);
            })));
            expect(contents).toEqual(['first contents', 'second contents']);
            expect(payload[0].autoSendFirstMessage).toBe(true);
          } else {
            expect(onAccepted).toHaveBeenCalledWith(draft.trim(), attachments, [], undefined);
            expect(uploadProjectFiles).toHaveBeenCalledTimes(1);
            expect(uploadProjectFiles).toHaveBeenCalledWith('project-1', files);
          }
          expect(text()).toBe('');
          expect(fileChips()).toEqual([]);
          await activate();
          expect(onAccepted).toHaveBeenCalledTimes(1);
        } finally {
          window.removeEventListener(MODEL_SELECTION_REQUIRED_EVENT, warned);
        }
      });
    });
  }
}
