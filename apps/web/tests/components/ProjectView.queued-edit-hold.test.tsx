// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectView } from '../../src/components/ProjectView';
import { streamMessage } from '../../src/providers/anthropic';
import { fetchChatRunStatus, listActiveChatRuns, reattachDaemonRun, streamViaDaemon } from '../../src/providers/daemon';
import { listConversations, listMessages, patchConversation } from '../../src/state/projects';
import { DEFAULT_CONFIG } from '../../src/state/config';
import { composerText, typeInComposer } from '../helpers/lexical-composer';

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
// Real pane + composer. The extra buttons drive the session model switcher (so a
// test can hold a queued send inside handleSend's selection-write await) and
// stand in for another surface sending through the same handleSend (e.g. a side
// chat tab mirroring the conversation).
vi.mock('../../src/components/ChatPane', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/components/ChatPane')>();
  return { ...actual, ChatPane: (props: ComponentProps<typeof actual.ChatPane>) => <>
    <actual.ChatPane {...props} />
    <button data-testid="pick-model" onClick={() => props.onAgentModelChange?.('claude', { model: 'sonnet' })}>model</button>
    <button data-testid="other-surface-send" onClick={() => { void props.onSend('NEW_C', [], []); }}>other</button>
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
const rows = () => Array.from(document.querySelectorAll<HTMLElement>('.chat-queued-send-row'));

async function finishReattachedRun() {
  await act(async () => { attached!.handlers.onDone(''); finishAttached!(); });
}

async function finishDaemonRun(index: number) {
  await act(async () => {
    runs[index]!.onRunStatus?.('succeeded');
    runs[index]!.handlers.onDone('done');
  });
}

async function mountWithQueue(...items: Array<ReturnType<typeof queued>>) {
  window.localStorage.setItem(storageKey, JSON.stringify(items));
  await act(async () => { mount(); });
  expect(attached).toBeDefined();
  expect(storedPrompts()).toEqual(items.map((item) => item.prompt));
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
afterEach(() => { cleanup(); window.localStorage.clear(); window.sessionStorage.clear(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('queued send edit hold', () => {
  it('holds the edited head when its turn comes, then runs the confirmed edit once before later items', async () => {
    await mountWithQueue(queued('a', 'ORIGINAL_A'), queued('b', 'ORIGINAL_B'));

    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'chat.queuedEdit' })[0]!); });
    expect(composerText()).toBe('ORIGINAL_A');
    // The editing row explains the pause in text and cannot be force-sent stale.
    expect(within(rows()[0]!).getByText('chat.queuedEditingHold')).toBeTruthy();
    expect(within(rows()[0]!).getByTestId('chat-queued-send-now')).toHaveProperty('disabled', true);
    expect(within(rows()[1]!).getByTestId('chat-queued-send-now')).toHaveProperty('disabled', false);
    await act(async () => { fireEvent.click(within(rows()[0]!).getByTestId('chat-queued-send-now')); });
    await act(async () => { typeInComposer('EDITED_A'); });

    await finishReattachedRun();
    // Its turn came while editing: neither the pre-edit snapshot nor the later
    // item may run.
    expect(streamViaDaemon).not.toHaveBeenCalled();
    expect(storedPrompts()).toEqual(['ORIGINAL_A', 'ORIGINAL_B']);

    await act(async () => { fireEvent.click(screen.getByTestId('chat-send')); });
    expect(sentPrompts()).toEqual(['EDITED_A']);
    expect(runs[0]!.sessionMode).toBe('design');
    expect(storedPrompts()).toEqual(['ORIGINAL_B']);

    await finishDaemonRun(0);
    expect(sentPrompts()).toEqual(['EDITED_A', 'ORIGINAL_B']);
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });

  it('resumes with the last confirmed content exactly once when the edit is cancelled', async () => {
    await mountWithQueue(queued('a', 'ORIGINAL_A'), queued('b', 'ORIGINAL_B'));

    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'chat.queuedEdit' })[0]!); });
    await act(async () => { typeInComposer('DISCARDED_A'); });
    await finishReattachedRun();
    expect(streamViaDaemon).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'chat.queuedCancel' })); });
    expect(sentPrompts()).toEqual(['ORIGINAL_A']);
    expect(composerText()).toBe('');
    expect(storedPrompts()).toEqual(['ORIGINAL_B']);

    await finishDaemonRun(0);
    expect(sentPrompts()).toEqual(['ORIGINAL_A', 'ORIGINAL_B']);
  });

  it('lets the next item run when the edited item is removed', async () => {
    await mountWithQueue(queued('a', 'ORIGINAL_A'), queued('b', 'ORIGINAL_B'));

    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'chat.queuedEdit' })[0]!); });
    await finishReattachedRun();
    expect(streamViaDaemon).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'chat.comments.remove' })); });
    expect(sentPrompts()).toEqual(['ORIGINAL_B']);
    expect(window.localStorage.getItem(storageKey)).toBeNull();
    // The removed item's restored copy is dropped, not left to send as a new turn.
    expect(composerText()).toBe('');
  });

  it('does not let a queued send be edited once it has started sending', async () => {
    await mountWithQueue(queued('a', 'ORIGINAL_A'), queued('b', 'ORIGINAL_B'));
    // A pending session-model write holds the auto-started send inside
    // handleSend, i.e. the item is starting but not yet removed from the queue.
    const selectionWrite = deferred<typeof conversation>();
    vi.mocked(patchConversation).mockReturnValueOnce(selectionWrite.promise as ReturnType<typeof patchConversation>);
    await act(async () => { fireEvent.click(screen.getByTestId('pick-model')); });

    await finishReattachedRun();
    expect(streamViaDaemon).not.toHaveBeenCalled();
    expect(storedPrompts()).toEqual(['ORIGINAL_A', 'ORIGINAL_B']);
    expect(within(rows()[0]!).getByRole('button', { name: 'chat.queuedEdit' })).toHaveProperty('disabled', true);
    expect(within(rows()[1]!).getByRole('button', { name: 'chat.queuedEdit' })).toHaveProperty('disabled', false);
    await act(async () => { fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'chat.queuedEdit' })); });
    expect(composerText()).toBe('');

    await act(async () => { selectionWrite.resolve(conversation); await selectionWrite.promise; });
    expect(sentPrompts()).toEqual(['ORIGINAL_A']);
    expect(storedPrompts()).toEqual(['ORIGINAL_B']);
  });

  it('marks an idle "send now" as starting so the released head cannot overlap it', async () => {
    await mountWithQueue(queued('a', 'ORIGINAL_A'), queued('b', 'ORIGINAL_B'));
    await act(async () => { fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'chat.queuedEdit' })); });
    await finishReattachedRun();
    expect(streamViaDaemon).not.toHaveBeenCalled();

    // Hold B's explicit send inside handleSend with a pending selection write.
    const selectionWrite = deferred<typeof conversation>();
    vi.mocked(patchConversation).mockReturnValueOnce(selectionWrite.promise as ReturnType<typeof patchConversation>);
    await act(async () => { fireEvent.click(screen.getByTestId('pick-model')); });
    await act(async () => { fireEvent.click(within(rows()[1]!).getByTestId('chat-queued-send-now')); });
    expect(within(rows()[1]!).getByRole('button', { name: 'chat.queuedEdit' })).toHaveProperty('disabled', true);

    // Releasing A's hold while B is still starting must not start A alongside it.
    await act(async () => { fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'chat.queuedCancel' })); });
    expect(streamViaDaemon).not.toHaveBeenCalled();
    await act(async () => { selectionWrite.resolve(conversation); await selectionWrite.promise; });
    expect(sentPrompts()).toEqual(['ORIGINAL_B']);
    expect(storedPrompts()).toEqual(['ORIGINAL_A']);

    await finishDaemonRun(0);
    expect(sentPrompts()).toEqual(['ORIGINAL_B', 'ORIGINAL_A']);
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });

  it('queues a send from another surface behind the held head instead of starting it', async () => {
    await mountWithQueue(queued('a', 'ORIGINAL_A'), queued('b', 'ORIGINAL_B'));

    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'chat.queuedEdit' })[0]!); });
    await finishReattachedRun();
    await act(async () => { fireEvent.click(screen.getByTestId('other-surface-send')); });
    expect(streamViaDaemon).not.toHaveBeenCalled();
    expect(storedPrompts()).toEqual(['ORIGINAL_A', 'ORIGINAL_B', 'NEW_C']);

    // "Send now" on a non-held item stays an explicit override.
    await act(async () => { fireEvent.click(within(rows()[1]!).getByTestId('chat-queued-send-now')); });
    expect(sentPrompts()).toEqual(['ORIGINAL_B']);
    expect(storedPrompts()).toEqual(['ORIGINAL_A', 'NEW_C']);

    await act(async () => { typeInComposer('EDITED_A'); });
    await finishDaemonRun(0);
    expect(sentPrompts()).toEqual(['ORIGINAL_B']);
    await act(async () => { fireEvent.click(screen.getByTestId('chat-send')); });
    await finishDaemonRun(1);
    expect(sentPrompts()).toEqual(['ORIGINAL_B', 'EDITED_A', 'NEW_C']);
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });

  it('keeps Edit locked until an API-mode send leaves the queue', async () => {
    // API mode marks the conversation busy, then still awaits memory extraction
    // before handleSend returns and the item is removed from the queue.
    const memoryExtract = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => (
      String(url).includes('/api/memory/extract') ? memoryExtract.promise : new Response('{}', { status: 404 })
    )));
    const streams: Array<Parameters<typeof streamMessage>> = [];
    vi.mocked(streamMessage).mockImplementation(async (...args) => { streams.push(args); });
    vi.mocked(listMessages).mockResolvedValue([]);
    window.localStorage.setItem(storageKey, JSON.stringify([queued('a', 'ORIGINAL_A'), queued('b', 'ORIGINAL_B')]));
    await act(async () => {
      render(<ProjectView
        project={{ id: projectId, name: 'Queue edit', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 1 }}
        routeFileName={null}
        config={{ ...DEFAULT_CONFIG, mode: 'api', apiKey: 'k', model: 'm', notifications: { successSoundId: 'success', failureSoundId: 'failure', soundEnabled: false, desktopEnabled: false } }}
        agents={[]} skills={[]} designTemplates={[]} designSystems={[]} daemonLive
        onModeChange={vi.fn()} onAgentChange={vi.fn()} onAgentModelChange={vi.fn()} onRefreshAgents={vi.fn()}
        onOpenSettings={vi.fn()} onBack={vi.fn()} onClearPendingPrompt={vi.fn()} onTouchProject={vi.fn()}
        onProjectChange={vi.fn()} onProjectsRefresh={vi.fn()} />);
    });
    const apiPrompts = () => streams.map((args) => String(args[2].at(-1)?.content ?? ''));

    expect(streams).toHaveLength(0);
    expect(storedPrompts()).toEqual(['ORIGINAL_A', 'ORIGINAL_B']);
    expect(within(rows()[0]!).getByRole('button', { name: 'chat.queuedEdit' })).toHaveProperty('disabled', true);
    await act(async () => { fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'chat.queuedEdit' })); });
    expect(composerText()).toBe('');

    await act(async () => { memoryExtract.resolve(new Response('{}', { status: 200 })); await memoryExtract.promise; });
    expect(apiPrompts()).toEqual([expect.stringContaining('ORIGINAL_A')]);
    expect(storedPrompts()).toEqual(['ORIGINAL_B']);

    // No stale copy of A was left in the composer to be re-queued.
    expect(composerText()).toBe('');
    await act(async () => { streams[0]![4].onDone?.(''); });
    expect(apiPrompts()).toEqual([expect.stringContaining('ORIGINAL_A'), expect.stringContaining('ORIGINAL_B')]);
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });
});
