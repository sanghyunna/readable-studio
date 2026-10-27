// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from 'lexical';
import { ProjectView } from '../../src/components/ProjectView';
import { fetchChatRunStatus, listActiveChatRuns, reattachDaemonRun, streamViaDaemon } from '../../src/providers/daemon';
import { listConversations, listMessages, patchConversation } from '../../src/state/projects';
import { DEFAULT_CONFIG } from '../../src/state/config';
import { serializeComposer } from '../../src/components/composer/serialize';

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'en', setLocale: vi.fn(), t: (key: string) => key }),
  useT: () => (key: string) => key,
}));
vi.mock('../../src/router', () => ({ navigate: vi.fn() }));
vi.mock('../../src/providers/anthropic', () => ({ streamMessage: vi.fn() }));
vi.mock('../../src/providers/daemon', () => ({
  fetchChatRunStatus: vi.fn(), listActiveChatRuns: vi.fn().mockResolvedValue([]),
  listProjectRuns: vi.fn().mockResolvedValue([]), reattachDaemonRun: vi.fn(), streamViaDaemon: vi.fn(),
  fetchVelaLoginStatus: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/providers/project-events', () => ({ useProjectFileEvents: vi.fn() }));
vi.mock('../../src/state/mcp', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/state/mcp')>(),
  fetchMcpServers: vi.fn().mockResolvedValue({ servers: [], templates: [] }),
}));
vi.mock('../../src/providers/registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/providers/registry')>(),
  fetchLiveArtifacts: vi.fn().mockResolvedValue([]), fetchPreviewComments: vi.fn().mockResolvedValue([]),
  fetchProjectFiles: vi.fn().mockResolvedValue([]),
  fetchProjectFolders: vi.fn().mockResolvedValue([]),
  fetchProjectDeployments: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/state/projects', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/state/projects')>(),
  listConversations: vi.fn(), listMessages: vi.fn(), listPlugins: vi.fn().mockResolvedValue([]),
  loadMessagePage: async (projectId: string, conversationId: string) => ({ messages: await listMessages(projectId, conversationId), nextPosition: null }),
  loadTabs: vi.fn().mockResolvedValue({ tabs: [], active: null }), patchConversation: vi.fn(),
  patchProject: vi.fn(), saveMessage: vi.fn().mockResolvedValue(undefined), saveTabs: vi.fn(),
  persistTabsToDaemonNow: vi.fn(),
}));
vi.mock('../../src/components/AppChromeHeader', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/components/AppChromeHeader')>(),
  AppChromeHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock('../../src/components/AvatarMenu', () => ({ AvatarMenu: () => null }));
vi.mock('../../src/components/FileWorkspace', () => ({ FileWorkspace: () => null }));
// Main ChatPane plus a second ChatPane fed the same queue props -- what
// SideChatTab renders when its tab mirrors the active conversation. The extra
// buttons drive the session model switcher (to hold a queued send inside
// handleSend's selection-write await) and send from another surface.
vi.mock('../../src/components/ChatPane', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/components/ChatPane')>();
  return { ...actual, ChatPane: (props: ComponentProps<typeof actual.ChatPane>) => <>
    <div data-testid="main-pane"><actual.ChatPane {...props} /></div>
    {(globalThis as { __singleChatPane?: boolean }).__singleChatPane ? null : <div data-testid="side-pane"><actual.ChatPane {...props} /></div>}
    <button data-testid="pick-model" onClick={() => props.onAgentModelChange?.('claude', { model: 'sonnet' })}>model</button>
    <button data-testid="other-surface-send" onClick={() => { void props.onSend('NEW_C', [], []); }}>other</button>
    <button data-testid="retry-last" onClick={() => { const last = props.messages.at(-1); if (last) props.onRetry?.(last); }}>retry</button>
  </> };
});

const projectId = 'queue-edit-project';
const storageKey = `readable:chat-queued-sends:${projectId}:v1`;
const conversation = { id: 'conv-q', projectId, title: 'Q', createdAt: 1, updatedAt: 1 };
const heldRun = { id: 'run-q', projectId, conversationId: 'conv-q', assistantMessageId: 'assistant-q', agentId: 'claude', status: 'running' as const, createdAt: 1, updatedAt: 1, exitCode: null, signal: null };
const queued = (id: string, prompt: string) => ({
  id, conversationId: 'conv-q', prompt, attachments: [], commentAttachments: [], createdAt: 2, meta: { sessionMode: 'design' },
});

type StreamInput = Parameters<typeof streamViaDaemon>[0];
let attached: Parameters<typeof reattachDaemonRun>[0] | undefined;
let finishAttached: (() => void) | undefined;
let runs: StreamInput[] = [];

function mount() {
  return render(<ProjectView
    project={{ id: projectId, name: 'Queue edit', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 1 }}
    routeFileName={null} config={{ ...DEFAULT_CONFIG, mode: 'daemon', agentId: 'claude', agentModels: { claude: { model: 'sonnet' } }, notifications: { successSoundId: 'success', failureSoundId: 'failure', soundEnabled: false, desktopEnabled: false } }}
    agents={[{ id: 'claude', name: 'Claude', bin: 'claude', available: true, models: [{ id: 'sonnet', label: 'Sonnet' }] }]}
    skills={[]} designTemplates={[]} designSystems={[]} daemonLive
    onModeChange={vi.fn()} onAgentChange={vi.fn()} onAgentModelChange={vi.fn()} onRefreshAgents={vi.fn()}
    onOpenSettings={vi.fn()} onBack={vi.fn()} onClearPendingPrompt={vi.fn()} onTouchProject={vi.fn()}
    onProjectChange={vi.fn()} onProjectsRefresh={vi.fn()} />);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const sentPrompts = () => runs.map((run) => run.history.at(-1)?.content);
const storedPrompts = () => (JSON.parse(window.localStorage.getItem(storageKey) ?? '[]') as Array<{ prompt: string }>).map((item) => item.prompt);
const pane = (name: 'main' | 'side') => screen.getByTestId(`${name}-pane`);
const rowsIn = (name: 'main' | 'side') => Array.from(pane(name).querySelectorAll<HTMLElement>('.chat-queued-send-row'));
const editorIn = (name: 'main' | 'side') =>
  (pane(name).querySelector('[data-testid="chat-composer-input"]') as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
const textIn = (name: 'main' | 'side') => serializeComposer(editorIn(name).getEditorState()).text;
function typeIn(name: 'main' | 'side', value: string) {
  act(() => {
    editorIn(name).update(() => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      root.append(p);
      const tn = $createTextNode(value);
      p.append(tn);
      tn.select(value.length, value.length);
    }, { discrete: true });
  });
}

async function finishReattachedRun() {
  await act(async () => { attached!.handlers.onDone(''); finishAttached!(); });
}
async function mountWithQueue(...items: Array<ReturnType<typeof queued>>) {
  window.localStorage.setItem(storageKey, JSON.stringify(items));
  await act(async () => { mount(); });
  expect(attached).toBeDefined();
}

beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
  attached = undefined;
  finishAttached = undefined;
  runs = [];
  vi.mocked(listActiveChatRuns).mockReset().mockResolvedValue([]);
  vi.mocked(listConversations).mockResolvedValue([conversation]);
  vi.mocked(listMessages).mockResolvedValue([{ id: 'assistant-q', role: 'assistant', content: '', createdAt: 1, runId: 'run-q', runStatus: 'running' }]);
  vi.mocked(fetchChatRunStatus).mockResolvedValue(heldRun);
  vi.mocked(reattachDaemonRun).mockImplementation((input) => {
    attached = input;
    input.handlers.onAgentEvent?.({ kind: 'status', label: 'running' });
    return new Promise<void>((resolve) => { finishAttached = resolve; });
  });
  vi.mocked(streamViaDaemon).mockImplementation(async (input) => {
    runs.push(input);
    input.onRunCreated?.(`run-${runs.length}`);
  });
});
afterEach(() => { (globalThis as { __singleChatPane?: boolean }).__singleChatPane = false; cleanup(); window.localStorage.clear(); window.sessionStorage.clear(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('queued send edit hold interleavings', () => {
  it('keeps the hold while another pane mirroring the conversation still edits the item', async () => {
    await mountWithQueue(queued('a', 'ORIGINAL_A'), queued('b', 'ORIGINAL_B'));
    await act(async () => { fireEvent.click(within(rowsIn('main')[0]!).getByRole('button', { name: 'chat.queuedEdit' })); });
    typeIn('main', 'EDITED_A');
    // Editing state is per pane: the mirrored strip shows no hold and still offers Edit.
    expect(within(rowsIn('side')[0]!).queryByText('chat.queuedEditingHold')).toBeNull();
    await act(async () => { fireEvent.click(within(rowsIn('side')[0]!).getByRole('button', { name: 'chat.queuedEdit' })); });
    await finishReattachedRun();
    expect(streamViaDaemon).not.toHaveBeenCalled();

    // Cancelling in one pane must not dispatch the stale original while the
    // other pane still edits it.
    await act(async () => { fireEvent.click(within(rowsIn('side')[0]!).getByRole('button', { name: 'chat.queuedCancel' })); });
    expect(sentPrompts()).toEqual([]);
    expect(textIn('main')).toBe('EDITED_A');
  });

  it('queues a direct send behind a saved head that is still starting', async () => {
    await mountWithQueue(queued('a', 'ORIGINAL_A'), queued('b', 'ORIGINAL_B'));
    await act(async () => { fireEvent.click(within(rowsIn('main')[0]!).getByRole('button', { name: 'chat.queuedEdit' })); });
    await finishReattachedRun();
    expect(streamViaDaemon).not.toHaveBeenCalled();

    const selectionWrite = deferred<typeof conversation>();
    vi.mocked(patchConversation).mockReturnValueOnce(selectionWrite.promise as ReturnType<typeof patchConversation>);
    await act(async () => { fireEvent.click(screen.getByTestId('pick-model')); });
    typeIn('main', 'EDITED_A');
    await act(async () => { fireEvent.click(within(pane('main')).getByTestId('chat-send')); });
    // A is now starting, parked in handleSend's selection-write await.
    await act(async () => { fireEvent.click(screen.getByTestId('other-surface-send')); });
    await act(async () => { selectionWrite.resolve(conversation); await selectionWrite.promise; });
    expect({ sent: sentPrompts(), stored: storedPrompts() }).toEqual({ sent: ['EDITED_A'], stored: ['ORIGINAL_B', 'NEW_C'] });
  });

  it('queues a direct send behind an auto-started head that is still starting', async () => {
    await mountWithQueue(queued('a', 'ORIGINAL_A'), queued('b', 'ORIGINAL_B'));
    const selectionWrite = deferred<typeof conversation>();
    vi.mocked(patchConversation).mockReturnValueOnce(selectionWrite.promise as ReturnType<typeof patchConversation>);
    await act(async () => { fireEvent.click(screen.getByTestId('pick-model')); });
    await finishReattachedRun();
    await act(async () => { fireEvent.click(screen.getByTestId('other-surface-send')); });
    await act(async () => { selectionWrite.resolve(conversation); await selectionWrite.promise; });
    expect({ sent: sentPrompts(), stored: storedPrompts() }).toEqual({ sent: ['ORIGINAL_A'], stored: ['ORIGINAL_B', 'NEW_C'] });
  });

  it('keeps a direct send queued after the starting item is removed from the strip', async () => {
    (globalThis as { __singleChatPane?: boolean }).__singleChatPane = true;
    await mountWithQueue(queued('a', 'ORIGINAL_A'), queued('b', 'ORIGINAL_B'));
    const selectionWrite = deferred<typeof conversation>();
    vi.mocked(patchConversation).mockReturnValueOnce(selectionWrite.promise as ReturnType<typeof patchConversation>);
    await act(async () => { fireEvent.click(screen.getByTestId('pick-model')); });
    await finishReattachedRun();
    // A is parked inside handleSend; removing its row does not stop that send.
    await act(async () => { fireEvent.click(within(rowsIn('main')[0]!).getByRole('button', { name: 'chat.comments.remove' })); });
    await act(async () => { fireEvent.click(screen.getByTestId('other-surface-send')); });
    await act(async () => { selectionWrite.resolve(conversation); await selectionWrite.promise; });
    expect({ sent: sentPrompts(), stored: storedPrompts() }).toEqual({ sent: ['ORIGINAL_A'], stored: ['ORIGINAL_B', 'NEW_C'] });
  });

  it('ignores a Retry of the failed last turn while a queued send is starting, so it cannot jam the queue', async () => {
    (globalThis as { __singleChatPane?: boolean }).__singleChatPane = true;
    vi.mocked(listMessages).mockResolvedValue([
      { id: 'user-q', role: 'user', content: 'FIRST', createdAt: 1 },
      { id: 'assistant-q', role: 'assistant', content: '', createdAt: 1, runId: 'run-q', runStatus: 'running' },
    ]);
    await mountWithQueue(queued('a', 'ORIGINAL_A'));
    const selectionWrite = deferred<typeof conversation>();
    vi.mocked(patchConversation).mockReturnValueOnce(selectionWrite.promise as ReturnType<typeof patchConversation>);
    await act(async () => { fireEvent.click(screen.getByTestId('pick-model')); });
    // The held run fails; auto-start then parks A inside handleSend.
    await act(async () => { attached!.onRunStatus?.('failed'); attached!.handlers.onError(new Error('boom')); finishAttached!(); });
    expect(streamViaDaemon).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByTestId('retry-last')); });
    await act(async () => { selectionWrite.resolve(conversation); await selectionWrite.promise; });
    expect({ sent: sentPrompts(), stored: storedPrompts() }).toEqual({ sent: ['ORIGINAL_A'], stored: [] });

    // Later queued sends still run once A's run ends.
    await act(async () => { fireEvent.click(screen.getByTestId('other-surface-send')); });
    await act(async () => { runs[0]!.onRunStatus?.('succeeded'); runs[0]!.handlers.onDone('done'); });
    expect(sentPrompts()).toEqual(['ORIGINAL_A', 'NEW_C']);
  });

  it('does not bring back the restored copy as a draft after an abandoned edit (reload)', async () => {
    (globalThis as { __singleChatPane?: boolean }).__singleChatPane = true;
    await mountWithQueue(queued('a', 'ORIGINAL_A'), queued('b', 'ORIGINAL_B'));
    await act(async () => { fireEvent.click(within(rowsIn('main')[0]!).getByRole('button', { name: 'chat.queuedEdit' })); });
    typeIn('main', 'EDITED_A');
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    cleanup();
    // Reload after the previous run finished: the queue proceeds by design.
    vi.mocked(listMessages).mockResolvedValue([{ id: 'assistant-q', role: 'assistant', content: 'x', createdAt: 1, runId: 'run-q', runStatus: 'succeeded' }]);
    await act(async () => { mount(); });
    await act(async () => {});
    expect(sentPrompts()).toEqual(['ORIGINAL_A']);
    // Otherwise Enter would send A a second time.
    expect(textIn('main')).toBe('');
  });
});
