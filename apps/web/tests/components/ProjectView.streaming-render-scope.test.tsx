// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DesignSystemSummary } from '@readable-studio/contracts';
import { trackArtifactHeaderClick } from '../../src/analytics/events';
import { AnalyticsProvider } from '../../src/analytics/provider';
import { ProjectView } from '../../src/components/ProjectView';
import { DEFAULT_CONFIG } from '../../src/state/config';
import { loadMessagePage, loadTabs } from '../../src/state/projects';
import { reattachDaemonRun, streamViaDaemon } from '../../src/providers/daemon';
import { fetchProjectFiles } from '../../src/providers/registry';
import type { AgentInfo, ChatMessage, ProjectFile } from '../../src/types';

// Streamed frames (text flushes, tool input deltas) re-render ProjectView. The
// design-system picker (composer) and the settings menu (workspace header) are
// handed to their hosts as memoized elements, so those subtrees must bail out
// of every frame — while still following every input they do render.
// Everything else keeps re-rendering per frame exactly as before: workspace
// time labels below pin that.

type Fiber = {
  readonly tag: number;
  readonly flags: number;
  readonly child: Fiber | null;
  readonly sibling: Fiber | null;
  readonly type?: { readonly name?: string; readonly displayName?: string; readonly render?: { readonly name?: string } } | null;
};
const counts = vi.hoisted(() => {
  const originalHook = Object.getOwnPropertyDescriptor(globalThis, '__REACT_DEVTOOLS_GLOBAL_HOOK__');
  const counts = { commits: 0, names: new Map<string, number>() };
  let previous = new Set<Fiber>();
  Reflect.set(globalThis, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
    supportsFiber: true, inject: () => 1,
    onCommitFiberRoot: (_id: number, root: { readonly current: Fiber }) => {
      counts.commits++;
      const current = new Set<Fiber>();
      const visit = (fiber: Fiber | null) => {
        if (!fiber) return;
        current.add(fiber);
        // React 18 PerformedWork on function/class/forwardRef/simple-memo fibers
        // that were not carried over unchanged from the previous commit.
        if (!previous.has(fiber) && (fiber.flags & 1) && [0, 1, 11, 15].includes(fiber.tag)) {
          const name = fiber.type?.displayName ?? fiber.type?.name ?? fiber.type?.render?.name ?? 'anonymous';
          counts.names.set(name, (counts.names.get(name) ?? 0) + 1);
        }
        visit(fiber.child); visit(fiber.sibling);
      };
      visit(root.current); previous = current;
    },
    onCommitFiberUnmount: () => undefined,
  });
  return Object.assign(counts, { restore: () => {
    if (originalHook) Object.defineProperty(globalThis, '__REACT_DEVTOOLS_GLOBAL_HOOK__', originalHook);
    else Reflect.deleteProperty(globalThis, '__REACT_DEVTOOLS_GLOBAL_HOOK__');
  } });
});
afterAll(counts.restore);

vi.mock('../../src/i18n', async original => {
  const t = (key: string) => key;
  return { ...await original<typeof import('../../src/i18n')>(), useI18n: () => ({ locale: 'en', t, setLocale: () => undefined }), useT: () => t };
});
vi.mock('../../src/router', () => ({ navigate: vi.fn() }));
vi.mock('../../src/providers/project-events', () => ({ useProjectFileEvents: vi.fn() }));
vi.mock('../../src/analytics/events', async original => ({
  ...await original<typeof import('../../src/analytics/events')>(),
  trackArtifactHeaderClick: vi.fn(),
}));
vi.mock('../../src/providers/daemon', async original => ({
  ...await original<typeof import('../../src/providers/daemon')>(),
  listProjectRuns: vi.fn().mockResolvedValue([]), listActiveChatRuns: vi.fn().mockResolvedValue([]),
  fetchChatRunStatus: vi.fn().mockResolvedValue({ id: 'run', status: 'running' }),
  reattachDaemonRun: vi.fn(({ signal }: { readonly signal: AbortSignal }) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))),
  streamViaDaemon: vi.fn(({ signal }: { readonly signal: AbortSignal }) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))),
}));
vi.mock('../../src/providers/registry', async original => ({
  ...await original<typeof import('../../src/providers/registry')>(),
  fetchLiveArtifacts: vi.fn().mockResolvedValue([]), fetchPreviewComments: vi.fn().mockResolvedValue([]),
  fetchProjectFiles: vi.fn().mockResolvedValue([]), fetchProjectFolders: vi.fn().mockResolvedValue([]),
  fetchProjectDeployments: vi.fn().mockResolvedValue([]),
  fetchProjectFileText: vi.fn().mockResolvedValue('<!doctype html><html><body><h1>Hi</h1></body></html>'),
  fetchDesignSystem: vi.fn().mockResolvedValue(null), fetchDesignSystemPreview: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/state/projects', async original => ({
  ...await original<typeof import('../../src/state/projects')>(),
  listConversations: vi.fn().mockResolvedValue([{ id: 'c', projectId: 'p', createdAt: 1, updatedAt: 1 }]),
  loadMessagePage: vi.fn(), saveMessage: vi.fn().mockResolvedValue(undefined),
  loadTabs: vi.fn(), saveTabs: vi.fn(), persistTabsToDaemonNow: vi.fn(),
  patchProject: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/components/AppChromeHeader', async original => ({
  ...await original<typeof import('../../src/components/AppChromeHeader')>(),
  AppChromeHeader: () => null,
}));
vi.mock('../../src/components/AvatarMenu', () => ({ AvatarMenu: () => null }));

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as never;
  // jsdom has no layout scrolling; the send path anchors the new turn.
  HTMLElement.prototype.scrollTo ??= () => undefined;
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); });

const FILE_MTIME = 1_700_000_000_000;
const htmlFile: ProjectFile = { name: 'index.html', path: 'index.html', type: 'file', size: 60, mtime: 1, kind: 'html', mime: 'text/html' };
// Not an HTML entry point, so it stays in the Design Files list instead of auto-opening.
const notesFile: ProjectFile = { name: 'notes.md', path: 'notes.md', type: 'file', size: 10, mtime: FILE_MTIME, kind: 'text', mime: 'text/markdown' };
const newFile: ProjectFile = { name: 'notes-from-run.md', path: 'notes-from-run.md', type: 'file', size: 10, mtime: 2, kind: 'text', mime: 'text/markdown' };
const agent: AgentInfo = { id: 'agent-1', name: 'Agent', bin: 'agent', available: true, models: [{ id: 'model-1', label: 'Model 1' }] };
const agents = [agent];
const alpha: DesignSystemSummary = { id: 'ds-a', title: 'Alpha System', category: 'Brand', summary: 'Alpha', source: 'built-in' };
const beta: DesignSystemSummary = { id: 'ds-b', title: 'Beta System', category: 'Brand', summary: 'Beta', source: 'built-in' };

// The two memoized elements and what they mount below themselves.
const MEMOIZED_ELEMENTS = /^(DesignSystemPicker|EntrySettingsMenu|ThemeSwatch|AnimatedCollapsible)$/;

type ProjectViewProps = ComponentProps<typeof ProjectView>;

async function mountProject(scenario: 'design-files' | 'html-open', running: boolean, files: ProjectFile[] = scenario === 'html-open' ? [htmlFile] : []) {
  vi.mocked(fetchProjectFiles).mockResolvedValue(files);
  vi.mocked(loadTabs).mockResolvedValue(scenario === 'html-open' ? { tabs: ['index.html'], active: 'index.html' } : { tabs: [], active: null });
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const frame = async () => { await act(async () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); }); };
  const messages: ChatMessage[] = [
    { id: 'u', role: 'user', content: 'Build the page' },
    running
      ? { id: 'a', role: 'assistant', content: '', events: [], runStatus: 'running', runId: 'run' }
      : { id: 'a', role: 'assistant', content: 'Done.', events: [{ kind: 'text', text: 'Done.' }], runStatus: 'succeeded', runId: 'run' },
  ];
  vi.mocked(loadMessagePage).mockResolvedValue({ messages, nextPosition: null });
  let props: ProjectViewProps = {
    project: { id: 'p', name: 'p', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 1 }, routeFileName: null,
    config: { ...DEFAULT_CONFIG, mode: 'daemon', agentId: agent.id, agentModels: { [agent.id]: { model: 'model-1' } } },
    agents, skills: [], designTemplates: [], designSystems: [], daemonLive: true,
    onModeChange: vi.fn(), onAgentChange: vi.fn(), onAgentModelChange: vi.fn(), onRefreshAgents: vi.fn(), onOpenSettings: vi.fn(),
    onClearPendingPrompt: vi.fn(), onBack: vi.fn(), onTouchProject: vi.fn(), onProjectChange: vi.fn(), onProjectsRefresh: vi.fn(),
  };
  const tree = () => <AnalyticsProvider><ProjectView {...props} /></AnalyticsProvider>;
  let view: ReturnType<typeof render> | undefined;
  await act(async () => { view = render(tree()); });
  for (let i = 0; i < 8; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(20); }); await frame(); }
  if (!view) throw new Error('ProjectView did not mount');
  const mounted = view;
  const rerender = async (next: Partial<ProjectViewProps>) => {
    props = { ...props, ...next };
    await act(async () => { mounted.rerender(tree()); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  };
  return { container: mounted.container, frame, rerender };
}

async function mountStreamingProject(scenario: 'design-files' | 'html-open', files?: ProjectFile[]) {
  const mounted = await mountProject(scenario, true, files);
  const handlers = vi.mocked(reattachDaemonRun).mock.lastCall?.[0].handlers;
  if (!handlers) throw new Error('Stream was not attached');
  const streamText = async (delta: string) => {
    await act(async () => { handlers.onDelta?.(delta); handlers.onAgentEvent?.({ kind: 'text', text: delta }); });
    await mounted.frame();
  };
  return { ...mounted, handlers, streamText };
}

function renderedMatching(pattern: RegExp): Record<string, number> {
  return Object.fromEntries([...counts.names].filter(([name]) => pattern.test(name)));
}

describe('ProjectView streamed-frame render scope', () => {
  it.each([['design-files' as const], ['html-open' as const]])('keeps the design-system picker and the settings menu out of text flushes (%s)', async (scenario) => {
    const { container, streamText } = await mountStreamingProject(scenario);
    await streamText('Live');
    if (scenario === 'html-open') expect(container.querySelectorAll('iframe').length).toBeGreaterThan(0);
    expect(container.querySelector('[data-testid="project-ds-picker-trigger"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="entry-settings-menu-trigger"]')).not.toBeNull();

    counts.commits = 0; counts.names.clear();
    await streamText(' one');
    await streamText(' two');

    expect(container.querySelector('.chat-log')?.textContent).toContain('Live one two');
    expect(counts.names.get('AssistantMessageImpl')).toBe(2);
    // Their hosts still render on every frame, as before.
    expect(counts.names.get('ChatComposer2')).toBe(2);
    expect(counts.names.get('FileWorkspace')).toBe(2);
    expect(renderedMatching(MEMOIZED_ELEMENTS)).toEqual({});
  });
});

describe('ProjectView live tool input render scope', () => {
  it('re-renders the live code card per tool_input_delta and shows the decoded code', async () => {
    localStorage.setItem('readable:chat-composer:draft:p:c', 'Write the page');
    const { container, frame } = await mountProject('html-open', false);
    const send = container.querySelector<HTMLButtonElement>('[data-testid="chat-send"]');
    expect(send?.disabled).toBe(false);
    await act(async () => { fireEvent.click(send!); await vi.advanceTimersByTimeAsync(0); });
    for (let i = 0; i < 4; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(20); }); await frame(); }
    const handlers = vi.mocked(streamViaDaemon).mock.lastCall?.[0].handlers;
    if (!handlers?.onToolInputDelta) throw new Error('Send stream was not started');
    await act(async () => { handlers.onDelta('Writing.'); handlers.onAgentEvent({ kind: 'text', text: 'Writing.' }); });
    await frame();

    counts.commits = 0; counts.names.clear();
    const raw = String.raw`{"file_path":"site/index.html","content":"<h1 class=\"t\">Café</h1>\n<p>ok</p>"}`;
    const decoded = '<h1 class="t">Café</h1>\n<p>ok</p>';
    const deltas = [raw.slice(0, 20), raw.slice(20, 47), raw.slice(47, 61), raw.slice(61)];
    for (const delta of deltas) {
      await act(async () => { handlers.onToolInputDelta?.('tool-1', 'Write', delta); });
    }

    const card = container.querySelector('.live-code-box');
    expect(card?.querySelector('.op-meta')?.textContent).toBe('index.html');
    expect(card?.querySelector('.live-code-pre code')?.textContent).toBe(decoded);
    // One commit per delta, exactly as before.
    expect(counts.names.get('AssistantMessageImpl')).toBe(deltas.length);
    expect(renderedMatching(MEMOIZED_ELEMENTS)).toEqual({});

    // The authoritative tool_use replaces the live card.
    await act(async () => {
      handlers.onAgentEvent({ kind: 'tool_use', id: 'tool-1', name: 'Write', input: { file_path: 'site/index.html', content: decoded } });
    });
    await frame();
    expect(container.querySelector('.live-code-box')).toBeNull();
  });
});

describe('ProjectView memoized elements after streamed frames', () => {
  it('the design-system picker follows its systems, selection and change handler', async () => {
    const { container, streamText, rerender } = await mountStreamingProject('design-files');
    await streamText('Live');
    await streamText(' one');
    expect(container.querySelector('[data-testid="project-ds-picker-trigger"]')?.textContent).toBe('designSystemPicker.select');

    const onProjectChange = vi.fn();
    await rerender({
      designSystems: [alpha, beta],
      project: { id: 'p', name: 'p', skillId: null, designSystemId: 'ds-a', createdAt: 1, updatedAt: 1 },
      onProjectChange,
    });
    await streamText(' two');
    expect(container.querySelector('[data-testid="project-ds-picker-trigger"]')?.textContent).toBe('Alpha System');

    await act(async () => { fireEvent.click(container.querySelector('[data-testid="project-ds-picker-trigger"]')!); });
    await act(async () => { fireEvent.mouseDown(screen.getByTestId('project-ds-picker-option-ds-b')); });
    expect(onProjectChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'p', designSystemId: 'ds-b' }));
  });

  it('the settings menu follows its config, handlers and the active artifact', async () => {
    const { container, streamText, rerender } = await mountStreamingProject('design-files', [notesFile]);
    await streamText('Live');
    const trigger = () => container.querySelector<HTMLButtonElement>('[data-testid="entry-settings-menu-trigger"]')!;

    // No file tab is active yet: the tracked click carries no artifact.
    await act(async () => { fireEvent.click(trigger()); });
    expect(vi.mocked(trackArtifactHeaderClick).mock.lastCall?.[1]).toEqual({ page_name: 'artifact', area: 'artifact_header', element: 'settings' });
    await act(async () => { fireEvent.click(trigger()); });

    const onOpenSettings = vi.fn();
    const onThemeChange = vi.fn();
    await rerender({ config: { ...DEFAULT_CONFIG, mode: 'daemon', agentId: agent.id, agentModels: { [agent.id]: { model: 'model-1' } }, theme: 'dark' }, onOpenSettings, onThemeChange });
    await streamText(' one');
    await act(async () => { fireEvent.click(trigger()); });
    expect(container.querySelector('[data-theme-option="dark"]')?.getAttribute('aria-checked')).toBe('true');
    await act(async () => { fireEvent.click(container.querySelector('[data-theme-option="light"]')!); });
    expect(onThemeChange).toHaveBeenCalledWith('light');
    await act(async () => { fireEvent.click(trigger()); });
    await act(async () => { fireEvent.click(container.querySelector('[data-testid="entry-settings-open-details"]')!); });
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    // Opening the file makes it the active artifact; the next tracked click carries it.
    await act(async () => { fireEvent.doubleClick(container.querySelector('.df-row-time')!); });
    for (let i = 0; i < 4; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(20); }); }
    await streamText(' two');
    await act(async () => { fireEvent.click(trigger()); });
    expect(vi.mocked(trackArtifactHeaderClick).mock.lastCall?.[1]).toEqual(expect.objectContaining({
      element: 'settings', artifact_id: expect.any(String), artifact_kind: expect.any(String),
    }));
  });
});

describe('ProjectView workspace clock labels during streaming', () => {
  it('repaints the Design Files time label on the first streamed frame past a minute', async () => {
    const { container, streamText } = await mountStreamingProject('design-files', [notesFile]);
    vi.setSystemTime(FILE_MTIME + 59_000);
    await streamText('Live');
    expect(container.querySelector('.df-row-time')?.textContent).toBe('common.justNow');

    vi.setSystemTime(FILE_MTIME + 61_000);
    await streamText(' one');
    expect(container.querySelector('.df-row-time')?.textContent).toBe('common.minutesAgo');
  });
});

describe('ProjectView composer and workspace after streamed frames', () => {
  it('queues a composer send through the current handler and follows the run end', async () => {
    localStorage.setItem('readable:chat-composer:draft:p:c', 'Follow-up after stream');
    const { container, handlers, streamText } = await mountStreamingProject('design-files');
    await streamText('Live');
    await streamText(' one');
    await streamText(' two');

    // Draft present while streaming: the composer offers Send (queue).
    const send = container.querySelector<HTMLButtonElement>('[data-testid="chat-send"]');
    expect(send).not.toBeNull();
    expect(send?.disabled).toBe(false);
    await act(async () => { fireEvent.click(send!); await vi.advanceTimersByTimeAsync(0); });
    expect(container.querySelector('.composer-send.stop')).not.toBeNull();
    expect(container.textContent).toContain('Follow-up after stream');
    expect(streamViaDaemon).not.toHaveBeenCalled();

    // The run ends: the workspace picks up the refreshed file list and the
    // queued follow-up starts with the streamed reply in its history.
    vi.mocked(fetchProjectFiles).mockResolvedValue([newFile]);
    await act(async () => { handlers.onDone?.(''); await vi.advanceTimersByTimeAsync(50); });
    for (let i = 0; i < 6; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(50); }); }
    expect(container.textContent).toContain('notes-from-run.md');
    expect(streamViaDaemon).toHaveBeenCalledTimes(1);
    const history = vi.mocked(streamViaDaemon).mock.calls[0]?.[0].history ?? [];
    expect(history.map(message => [message.role, message.content])).toEqual([
      ['user', 'Build the page'],
      ['assistant', 'Live one two'],
      ['user', 'Follow-up after stream'],
    ]);
  });
});
