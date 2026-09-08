// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectView } from '../../src/components/ProjectView';
import { QuestionsPanel } from '../../src/components/QuestionsPanel';
import { formatFormAnswers, type QuestionForm } from '../../src/artifacts/question-form';
import { parseSubmittedAnswers } from '../../src/components/QuestionForm';
import { fetchChatRunStatus, listActiveChatRuns, reattachDaemonRun, streamViaDaemon } from '../../src/providers/daemon';
import { listConversations, listMessages, saveMessage } from '../../src/state/projects';
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
}));
vi.mock('../../src/state/projects', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/state/projects')>(),
  listConversations: vi.fn(), listMessages: vi.fn(), listPlugins: vi.fn().mockResolvedValue([]),
  loadTabs: vi.fn().mockResolvedValue({ tabs: [], active: null }), patchConversation: vi.fn(),
  patchProject: vi.fn(), saveMessage: vi.fn().mockResolvedValue(undefined), saveTabs: vi.fn(),
  persistTabsToDaemonNow: vi.fn(),
}));
vi.mock('../../src/components/AppChromeHeader', () => ({
  AppChromeHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock('../../src/components/AvatarMenu', () => ({ AvatarMenu: () => null }));
vi.mock('../../src/components/FileWorkspace', () => ({
  FileWorkspace: (props: ComponentProps<typeof import('../../src/components/FileWorkspace').FileWorkspace>) => (
    <QuestionsPanel form={props.questionForm ?? null} formKey={props.questionFormKey}
      interactive={props.questionFormInteractive ?? false} submitDisabled={props.questionFormSubmitDisabled}
      runHydrationStatus={props.questionRunHydrationStatus} onRetryRunHydration={props.onRetryQuestionRunHydration}
      submissionQueued={props.questionFormSubmissionQueued} submittedAnswers={props.questionFormSubmittedAnswers}
      generating={props.questionsGenerating ?? false} onSubmit={props.onSubmitQuestionForm!} />
  ),
}));
// Keep the real pane/composer edit path; expose the typed queue-only caller
// separately so this test also covers metadata entering ProjectView directly.
vi.mock('../../src/components/ChatPane', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/components/ChatPane')>();
  return { ...actual, ChatPane: (props: ComponentProps<typeof actual.ChatPane>) => <>
    <actual.ChatPane {...props} />
    <button data-testid="explicit-queue" onClick={() => props.onSend(formatFormAnswers(form, answers), [], [], { queueOnly: true })}>queue</button>
  </> };
});

const form: QuestionForm = { id: 'scope', title: 'Scope', questions: [
  { id: 'platform', label: 'Target platform', type: 'radio', required: true, options: [{ label: 'Desktop web', value: 'desktop-web' }] },
  { id: 'features', label: 'Features', type: 'checkbox', required: true, options: [
    { label: 'Search, filter', value: 'search-filter' }, { label: 'Export', value: 'export' },
  ] },
  { id: 'notes', label: 'Notes', type: 'textarea' },
] };
const answers = { platform: 'desktop-web', features: ['search-filter', 'export'], notes: 'First line\nSecond line' };
const storageKey = 'readable:chat-queued-sends:queue-question-project:v1';
const content = `<question-form id="scope" title="Scope">${JSON.stringify({ questions: form.questions })}</question-form>`;

function mount() {
  return render(<ProjectView
    project={{ id: 'queue-question-project', name: 'Queue test', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 1 }}
    routeFileName={null} config={{ ...DEFAULT_CONFIG, mode: 'daemon', agentId: 'claude', agentModels: { claude: { model: 'sonnet' } }, notifications: { successSoundId: 'success', failureSoundId: 'failure', soundEnabled: false, desktopEnabled: false } }}
    agents={[{ id: 'claude', name: 'Claude', bin: 'claude', available: true, models: [{ id: 'sonnet', label: 'Sonnet' }] }]}
    skills={[]} designTemplates={[]} designSystems={[]} daemonLive
    onModeChange={vi.fn()} onAgentChange={vi.fn()} onAgentModelChange={vi.fn()} onRefreshAgents={vi.fn()}
    onOpenSettings={vi.fn()} onBack={vi.fn()} onClearPendingPrompt={vi.fn()} onTouchProject={vi.fn()}
    onProjectChange={vi.fn()} onProjectsRefresh={vi.fn()} />);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => { vi.mocked(listActiveChatRuns).mockReset().mockResolvedValue([]); });
afterEach(() => { cleanup(); window.localStorage.clear(); window.sessionStorage.clear(); vi.clearAllMocks(); });

describe('queued question answer lifecycle', () => {
  it.each(['idle', 'active', 'retry-failure'] as const)('holds editable answers through failed hydration and local %s recovery', async outcome => {
    vi.mocked(listConversations).mockResolvedValue([{ id: 'conv-q', projectId: 'queue-question-project', title: 'Q', createdAt: 1, updatedAt: 1 }]);
    vi.mocked(listMessages).mockResolvedValue([{ id: 'assistant-q', role: 'assistant', content, createdAt: 1 }]);
    const hydration = deferred<Awaited<ReturnType<typeof listActiveChatRuns>>>();
    const retry = deferred<Awaited<ReturnType<typeof listActiveChatRuns>>>();
    vi.mocked(listActiveChatRuns).mockReturnValueOnce(hydration.promise).mockReturnValueOnce(retry.promise);
    const completion = deferred<void>();
    let attached!: Parameters<typeof reattachDaemonRun>[0];
    const heldRun = { id: 'run-q', projectId: 'queue-question-project', conversationId: 'conv-q', assistantMessageId: 'assistant-q', agentId: 'claude', status: 'running' as const, createdAt: 1, updatedAt: 1, exitCode: null, signal: null };
    vi.mocked(fetchChatRunStatus).mockResolvedValue(heldRun);
    vi.mocked(reattachDaemonRun).mockImplementation(input => {
      attached = input;
      input.handlers.onDelta(content);
      input.handlers.onAgentEvent?.({ kind: 'status', label: 'running' });
      return completion.promise;
    });
    vi.mocked(streamViaDaemon).mockImplementation(async input => { input.onRunCreated?.('run-next'); });
    await act(async () => { mount(); });
    expect(listActiveChatRuns).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('radio', { name: 'Desktop web' }));
    fireEvent.click(screen.getByRole('button', { name: 'Search, filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: answers.notes } });
    const draftKey = 'readable-studio:question-form-draft:conv-q:assistant-q';
    const draft = window.sessionStorage.getItem(draftKey);
    expect(draft).not.toBeNull();
    expect(screen.getByRole('status').textContent).toBe('questions.hydratingRuns');
    expect(screen.getByRole('button', { name: 'questions.continue' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'questions.skipAll' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'questions.continue' }));
    expect(streamViaDaemon).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(draftKey)).toBe(draft);

    await act(async () => { hydration.reject(new Error('Run hydration unavailable')); });
    expect(screen.getByRole('status').textContent).toBe('questions.runHydrationFailed');
    expect(screen.getByRole('button', { name: 'questions.continue' })).toHaveProperty('disabled', true);
    const retryButton = screen.getByRole('button', { name: 'questions.retryRunHydration' });
    await act(async () => { fireEvent.click(retryButton); fireEvent.click(retryButton); });
    expect(listActiveChatRuns).toHaveBeenCalledTimes(2);
    expect(listActiveChatRuns).toHaveBeenLastCalledWith('queue-question-project', 'conv-q', { requireSuccess: true });
    expect(listMessages).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('questions.hydratingRuns');
    expect(screen.queryByText('Run hydration unavailable')).toBeNull();
    expect(window.sessionStorage.getItem(draftKey)).toBe(draft);
    if (outcome === 'retry-failure') {
      await act(async () => { retry.reject(new Error('Retry unavailable')); });
      expect(screen.getByRole('status').textContent).toBe('questions.runHydrationFailed');
      expect(screen.getByRole('button', { name: 'questions.retryRunHydration' })).toHaveProperty('disabled', false);
      expect(screen.getByRole('button', { name: 'questions.continue' })).toHaveProperty('disabled', true);
      expect(window.sessionStorage.getItem(draftKey)).toBe(draft);
      expect(streamViaDaemon).not.toHaveBeenCalled();
      return;
    }
    await act(async () => { retry.resolve(outcome === 'active' ? [heldRun] : []); await retry.promise; });
    expect(screen.queryByRole('button', { name: 'questions.retryRunHydration' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveProperty('value', answers.notes);
    expect(screen.getByRole('button', { name: 'questions.continue' })).toHaveProperty('disabled', false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'questions.continue' })); });
    if (outcome === 'active') {
      expect(screen.getByRole('status').textContent).toBe('questions.queued');
      expect(streamViaDaemon).not.toHaveBeenCalled();
      expect(JSON.parse(window.localStorage.getItem(storageKey)!)).toHaveLength(1);
      await act(async () => { attached.handlers.onDone(content); completion.resolve(); await completion.promise; });
    }
    expect(streamViaDaemon).toHaveBeenCalledTimes(1);
    expect(vi.mocked(streamViaDaemon).mock.calls[0]![0].history.at(-1)).toMatchObject({ role: 'user', content: formatFormAnswers(form, answers), sessionMode: 'design' });
    expect(window.localStorage.getItem(storageKey)).toBeNull();
    expect(listMessages).toHaveBeenCalledTimes(1);
  });

  it.each(['running', 'idle', 'interrupt', 'error', 'retry-idle', 'retry-active', 'retry-failure'] as const)('waits for run hydration on %s reload before promoting a persisted answer', async (outcome) => {
    const queued = { id: 'answer-q', conversationId: 'conv-q', prompt: formatFormAnswers(form, answers),
      attachments: [], commentAttachments: [], createdAt: 2, meta: { sessionMode: 'design' } };
    window.localStorage.setItem(storageKey, JSON.stringify([queued]));
    vi.mocked(listConversations).mockResolvedValue([{ id: 'conv-q', projectId: 'queue-question-project', title: 'Q', createdAt: 1, updatedAt: 1 }]);
    // The message snapshot has not caught up with the daemon run record yet.
    vi.mocked(listMessages).mockResolvedValue([{ id: 'assistant-q', role: 'assistant', content, createdAt: 1 }]);
    let reconcile!: (runs: Awaited<ReturnType<typeof listActiveChatRuns>>) => void;
    let rejectHydration!: (error: Error) => void;
    const hydration = new Promise<Awaited<ReturnType<typeof listActiveChatRuns>>>((resolve, reject) => { reconcile = resolve; rejectHydration = reject; });
    vi.mocked(listActiveChatRuns).mockReturnValueOnce(hydration);
    const heldRun = { id: 'run-q', projectId: 'queue-question-project', conversationId: 'conv-q', assistantMessageId: 'assistant-q', agentId: 'claude', status: 'running' as const, createdAt: 1, updatedAt: 1, exitCode: null, signal: null };
    vi.mocked(fetchChatRunStatus).mockResolvedValue(heldRun);
    let attached: Parameters<typeof reattachDaemonRun>[0] | undefined;
    let finish!: () => void;
    vi.mocked(reattachDaemonRun).mockImplementation((input) => {
      attached = input;
      input.handlers.onDelta(content);
      input.handlers.onAgentEvent?.({ kind: 'status', label: 'running' });
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    vi.mocked(streamViaDaemon).mockImplementation(async (input) => { input.onRunCreated?.('run-next'); });

    await act(async () => { mount(); });
    expect(listMessages).toHaveBeenCalledTimes(1);
    expect(streamViaDaemon).not.toHaveBeenCalled();
    expect(screen.getByTestId('chat-queued-send-strip')).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(storageKey)!)).toEqual([queued]);

    expect(screen.getByTestId('chat-queued-send-now')).toHaveProperty('disabled', true);
    const idle = outcome === 'idle' || outcome === 'retry-idle' || outcome === 'retry-failure';
    if (outcome === 'error' || outcome.startsWith('retry-')) {
      await act(async () => { rejectHydration(new Error('Run hydration unavailable')); });
      expect(streamViaDaemon).not.toHaveBeenCalled();
      expect(screen.getByTestId('chat-queued-send-now')).toHaveProperty('disabled', true);
      expect(JSON.parse(window.localStorage.getItem(storageKey)!)).toEqual([queued]);
      expect(screen.getByText('Run hydration unavailable')).toBeTruthy();
      if (outcome === 'error') return;
      const retry = deferred<Awaited<ReturnType<typeof listActiveChatRuns>>>();
      vi.mocked(listActiveChatRuns).mockReturnValueOnce(retry.promise);
      const retryButton = screen.getByRole('button', { name: 'questions.retryRunHydration' });
      await act(async () => { fireEvent.click(retryButton); fireEvent.click(retryButton); });
      expect(listActiveChatRuns).toHaveBeenCalledTimes(2);
      expect(listMessages).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('chat-queued-send-now')).toHaveProperty('disabled', true);
      expect(JSON.parse(window.localStorage.getItem(storageKey)!)).toEqual([queued]);
      expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveProperty('value', answers.notes);
      if (outcome === 'retry-failure') {
        await act(async () => { retry.reject(new Error('Retry unavailable')); });
        expect(streamViaDaemon).not.toHaveBeenCalled();
        expect(JSON.parse(window.localStorage.getItem(storageKey)!)).toEqual([queued]);
        expect(screen.getByRole('status').textContent).toBe('questions.runHydrationFailed');
        // A second failure must remain locally recoverable, not leave a stuck latch.
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'questions.retryRunHydration' })); });
        expect(listActiveChatRuns).toHaveBeenCalledTimes(3);
      } else {
        await act(async () => { retry.resolve(idle ? [] : [heldRun]); await retry.promise; });
      }
    } else {
      await act(async () => { reconcile(idle ? [] : [heldRun]); });
    }
    expect(listActiveChatRuns).toHaveBeenCalledWith('queue-question-project', 'conv-q', { requireSuccess: true });
    if (!idle) {
      expect(attached).toBeDefined();
      expect(streamViaDaemon).not.toHaveBeenCalled();
      expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveProperty('value', answers.notes);
      expect(screen.getByRole('radio', { checked: true })).toHaveProperty('disabled', true);
      expect(JSON.parse(window.localStorage.getItem(storageKey)!)).toEqual([queued]);
      if (outcome === 'interrupt') {
        await act(async () => { fireEvent.click(screen.getByTestId('chat-queued-send-now')); });
        expect(attached!.cancelSignal?.aborted).toBe(true);
      }
      await act(async () => { attached!.handlers.onDone(content); finish(); });
    }
    expect(streamViaDaemon).toHaveBeenCalledTimes(1);
    const promoted = vi.mocked(streamViaDaemon).mock.calls[0]![0];
    expect(promoted.history.at(-1)).toMatchObject({ role: 'user', content: queued.prompt });
    expect(promoted.sessionMode).toBe(queued.meta.sessionMode);
    expect(window.localStorage.getItem(storageKey)).toBeNull();
    expect(saveMessage).toHaveBeenCalledWith('queue-question-project', 'conv-q', expect.objectContaining({ role: 'user', content: queued.prompt, sessionMode: queued.meta.sessionMode }), undefined);
  });

  it.each(['panel', 'queueOnly'] as const)('preserves answers through %s submission, reload, composer edit and auto-apply', async (source) => {
    vi.mocked(listConversations).mockResolvedValue([{ id: 'conv-q', projectId: 'queue-question-project', title: 'Q', createdAt: 1, updatedAt: 1 }]);
    vi.mocked(listMessages).mockResolvedValue([{ id: 'assistant-q', role: 'assistant', content, createdAt: 1, runId: 'run-q', runStatus: 'running' }]);
    vi.mocked(fetchChatRunStatus).mockResolvedValue({ id: 'run-q', projectId: 'queue-question-project', conversationId: 'conv-q', assistantMessageId: 'assistant-q', agentId: 'claude', status: 'running', createdAt: 1, updatedAt: 1, exitCode: null, signal: null });
    let attached: Parameters<typeof reattachDaemonRun>[0] | undefined;
    let finish: (() => void) | undefined;
    vi.mocked(reattachDaemonRun).mockImplementation((input) => {
      attached = input;
      input.handlers.onDelta(content);
      input.handlers.onAgentEvent?.({ kind: 'status', label: 'running' });
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    vi.mocked(streamViaDaemon).mockImplementation(async (input) => { input.onRunCreated?.('run-next'); });
    let first: ReturnType<typeof mount>;
    await act(async () => { first = mount(); });
    expect(attached).toBeDefined();

    fireEvent.click(screen.getByRole('radio', { name: 'Desktop web' }));
    fireEvent.click(screen.getByRole('button', { name: 'Search, filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: answers.notes } });
    await act(async () => { fireEvent.click(source === 'panel' ? screen.getByRole('button', { name: 'questions.continue' }) : screen.getByTestId('explicit-queue')); });
    const persisted = JSON.parse(window.localStorage.getItem(storageKey)!);
    expect(persisted).toHaveLength(1);
    expect(parseSubmittedAnswers(form, persisted[0].prompt)).toEqual(answers);
    expect(persisted[0].meta).not.toHaveProperty('queueOnly');
    expect(persisted[0].meta.sessionMode).toBe('design');
    expect(streamViaDaemon).not.toHaveBeenCalled();

    first!.unmount();
    await act(async () => { mount(); });
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(2);
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveProperty('value', answers.notes);
    expect(screen.getByRole('radio', { checked: true })).toHaveProperty('disabled', true);
    expect(streamViaDaemon).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.queuedEdit' })); });
    expect(composerText()).toBe(persisted[0].prompt);
    const editedAnswers = { ...answers, notes: 'Edited first line\nEdited second line' };
    const editedPrompt = formatFormAnswers(form, editedAnswers);
    // The discrete Lexical commit triggers the real change/trigger listeners;
    // keep those updates and their React effects in Testing Library's act scope.
    await act(async () => { typeInComposer(editedPrompt); });
    await act(async () => { fireEvent.click(screen.getByTestId('chat-send')); });
    const editedQueue = JSON.parse(window.localStorage.getItem(storageKey)!);
    expect(editedQueue).toHaveLength(1);
    expect(editedQueue[0].id).toBe(persisted[0].id);
    expect(editedQueue[0].prompt).toBe(editedPrompt);
    expect(editedQueue[0].meta).toEqual(persisted[0].meta);
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveProperty('value', editedAnswers.notes);

    // Drive the actual run terminal callback and its completion promise, not
    // a sleep or polling loop. React act drains the resulting state transition.
    await act(async () => { attached!.handlers.onDone(content); finish!(); });
    expect(streamViaDaemon).toHaveBeenCalledTimes(1);
    const run = vi.mocked(streamViaDaemon).mock.calls[0]![0];
    expect(run.history.at(-1)).toMatchObject({ role: 'user', content: editedPrompt });
    expect(run.sessionMode).toBe(persisted[0].meta.sessionMode);
    expect(saveMessage).toHaveBeenCalledWith('queue-question-project', 'conv-q', expect.objectContaining({ role: 'user', content: editedPrompt }), undefined);
    expect(window.localStorage.getItem(storageKey)).toBeNull();
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(2);
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveProperty('value', editedAnswers.notes);
  });
});
