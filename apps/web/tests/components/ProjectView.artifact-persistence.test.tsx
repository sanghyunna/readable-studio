// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectView } from '../../src/components/ProjectView';
import type { AppConfig, ChatMessage, ProjectFile } from '../../src/types';
import type { StreamHandlers } from '../../src/providers/anthropic';

const state = vi.hoisted(() => ({
  replay: false,
  mode: 'api' as AppConfig['mode'],
  before: [] as string[],
  files: new Map<string, { file: ProjectFile; content: string }>(),
  onSend: null as null | ((text: string, attachments: [], comments: []) => Promise<void>),
  handlers: null as StreamHandlers | null,
  completed: (_message: ChatMessage) => {},
}));
vi.mock('../../src/i18n', () => ({ useI18n: () => ({ locale: 'en', t: (key: string) => key }), useT: () => (key: string) => key }));
vi.mock('../../src/providers/anthropic', () => ({ streamMessage: async (_config: unknown, _system: unknown, _history: unknown, _signal: unknown, handlers: StreamHandlers) => { state.handlers = handlers; } }));
vi.mock('../../src/providers/daemon', () => ({
  listActiveChatRuns: async () => [], listProjectRuns: async () => [],
  fetchChatRunStatus: async () => ({ id: 'run-1', status: 'running', createdAt: 1000 }),
  reattachDaemonRun: async ({ handlers }: { handlers: StreamHandlers }) => { state.handlers = handlers; return new Promise<void>(() => {}); },
  streamViaDaemon: async ({ handlers, onRunCreated }: { handlers: StreamHandlers; onRunCreated: (id: string) => void }) => { state.handlers = handlers; onRunCreated('run-1'); },
}));
vi.mock('../../src/providers/project-events', () => ({ useProjectFileEvents: () => {} }));
vi.mock('../../src/providers/registry', async (original) => ({
  ...await original<typeof import('../../src/providers/registry')>(),
  fetchProjectFiles: async () => [...state.files.values()].map(({ file }) => file),
  fetchPreviewComments: async () => [], fetchLiveArtifacts: async () => [],
  fetchProjectDesignSystemPackageAudit: async () => null,
}));
vi.mock('../../src/state/projects', () => ({
  listConversations: async () => [{ id: 'conv-1', title: 'Conversation' }],
  listMessages: async () => state.replay ? [{ id: 'assistant-1', role: 'assistant', content: '', createdAt: 1000, startedAt: 1000, runId: 'run-1', runStatus: 'running', preTurnFileNames: state.before }] : [],
  loadTabs: async () => ({ tabs: [], active: null }), saveTabs: async () => {},
  cacheTabsLocally: (_id: string, tabs: unknown) => tabs, persistTabsToDaemonNow: async () => {},
  saveMessage: async (_project: string, _conversation: string, message: ChatMessage) => { if (message.producedFiles) state.completed(message); },
  patchConversation: async () => null, patchProject: async () => null, getTemplate: async () => null,
}));
vi.mock('../../src/router', () => ({ navigate: () => {} }));
vi.mock('../../src/components/AppChromeHeader', () => ({ AppChromeHeader: () => null }));
vi.mock('../../src/components/AvatarMenu', () => ({ AvatarMenu: () => null }));
vi.mock('../../src/components/Loading', () => ({ CenteredLoader: () => null }));
vi.mock('../../src/components/FileWorkspace', () => ({ FileWorkspace: () => null }));
vi.mock('../../src/components/ChatPane', () => ({ ChatPane: ({ onSend, sendDisabled }: { onSend: typeof state.onSend; sendDisabled: boolean }) => { if (!sendDisabled) state.onSend = onSend; return null; } }));

const html = '<!doctype html><html><head><title>Design</title></head><body><main><h1>Design</h1></main></body></html>';
function addFile(name: string, content: string, mtime: number) {
  state.files.set(name, { content, file: { name, path: name, kind: 'html', mime: 'text/html', size: content.length, mtime } });
}
function mount() {
  return render(<ProjectView project={{ id: 'project-1', name: 'Project', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 1 }} routeFileName={null}
    config={{ mode: state.mode, apiProtocol: 'openai', apiKey: 'test', baseUrl: 'https://api.example.com', model: 'test', agentId: 'agent-1', agentModels: {} } as AppConfig}
    agents={[{ id: 'agent-1', name: 'Agent', available: true, bin: 'agent', models: [] } as never]} skills={[]} designTemplates={[]} designSystems={[]} daemonLive
    onModeChange={() => {}} onAgentChange={() => {}} onAgentModelChange={() => {}} onRefreshAgents={() => {}} onOpenSettings={() => {}}
    onBack={() => {}} onClearPendingPrompt={() => {}} onTouchProject={() => {}} onProjectChange={() => {}} onProjectsRefresh={() => {}} />);
}
async function complete(identifier: string) {
  const done = new Promise<ChatMessage>((resolve) => { state.completed = resolve; });
  await act(async () => {
    expect(state.handlers).not.toBeNull();
    state.handlers!.onDelta(`<artifact identifier="${identifier}" type="text/html" title="Design">\n${html}\n</artifact>`);
    state.handlers!.onDone('');
  });
  return done;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); window.sessionStorage.clear(); });

for (const mode of ['api', 'daemon', 'replay'] as const) {
  const replay = mode === 'replay';
  describe(`${mode} artifacts`, () => {
    it.each([
      { name: 'identical current index', identifier: 'design', existing: html, old: false, path: 'index.html', expected: ['index.html'] },
      { name: 'different current index', identifier: 'design', existing: html.replace('Design</h1>', 'Other</h1>'), old: false, path: 'index.html', expected: ['design.html', 'index.html'] },
      { name: 'identical pre-run index', identifier: 'design', existing: html, old: true, path: 'index.html', expected: ['design.html', 'index.html'] },
      { name: 'index identifier with matching current index', identifier: 'index', existing: html, old: false, path: 'index.html', expected: ['index.html'] },
      { name: 'index identifier with different current index', identifier: 'index', existing: html.replace('Design</h1>', 'Other</h1>'), old: false, path: 'index.html', expected: ['index-2.html', 'index.html'] },
      { name: 'index identifier with pre-run index', identifier: 'index', existing: html, old: true, path: 'index.html', expected: ['index-2.html', 'index.html'] },
      { name: 'index in another directory', identifier: 'design', existing: html, old: false, path: 'nested/index.html', expected: ['design.html', 'nested/index.html'] },
      { name: 'no index (API-only named artifact)', identifier: 'design', existing: null, old: false, path: 'index.html', expected: ['design.html'] },
    ])('$name', async ({ identifier, existing, old, path, expected }) => {
      state.mode = mode === 'api' ? 'api' : 'daemon';
      state.replay = replay; state.before = old ? [path] : []; state.files.clear(); state.handlers = null; state.onSend = null;
      const writes: string[] = [];
      const reads: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
        if (init?.method === 'POST' && input === '/api/projects/project-1/files') {
          const body = JSON.parse(init.body as string);
          writes.push(body.name);
          addFile(body.name, body.content, Date.now());
          state.files.get(body.name)!.file.artifactManifest = body.artifactManifest;
          return new Response(JSON.stringify({ file: state.files.get(body.name)!.file }));
        }
        if (input.includes('/raw/')) {
          const name = decodeURIComponent(input.split('/raw/')[1]!.split('?')[0]!);
          reads.push(name);
          return new Response(state.files.get(name)?.content ?? '', { status: state.files.has(name) ? 200 : 404 });
        }
        return new Response('{}');
      }));
      if (existing && (old || replay)) addFile(path, existing, old ? 1 : Date.now());
      await act(async () => { mount(); });
      if (!replay) {
        expect(state.onSend).not.toBeNull();
        await act(async () => { await state.onSend!('Create a design', [], []); });
        if (existing && !old) addFile(path, existing, Date.now());
      }
      await complete(identifier);
      expect([...state.files.keys()].sort()).toEqual(expected);
      const savedName = expected.length === 1 && existing ? 'index.html' : identifier === 'index' ? 'index-2.html' : 'design.html';
      expect(state.files.get(savedName)?.file.artifactManifest).toMatchObject({ entry: savedName, metadata: { identifier, inferred: false } });
      if (savedName === 'index.html') expect(reads).toContain('index.html');
      if (replay) {
        cleanup(); state.handlers = null;
        await act(async () => { mount(); });
        await complete(identifier);
        expect([...state.files.keys()].sort()).toEqual(expected);
        expect(writes).toHaveLength(1);
      }
    });
  });
}
