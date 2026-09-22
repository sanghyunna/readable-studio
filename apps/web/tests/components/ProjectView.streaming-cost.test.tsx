// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { ProjectView } from '../../src/components/ProjectView';
import { DEFAULT_CONFIG } from '../../src/state/config';
import { loadMessagePage } from '../../src/state/projects';
import { reattachDaemonRun } from '../../src/providers/daemon';
import { renderMarkdown } from '../../src/runtime/markdown';
import { highlightCode } from '../../src/runtime/shiki';
import type { ChatMessage } from '../../src/types';

type Fiber = { readonly tag: number; readonly flags: number; readonly child: Fiber | null; readonly sibling: Fiber | null; readonly type?: { readonly name?: string } };
const counts = vi.hoisted(() => {
  const originalHook = Object.getOwnPropertyDescriptor(globalThis, '__REACT_DEVTOOLS_GLOBAL_HOOK__');
  const counts = { commits: 0, components: 0, names: new Map<string, number>() };
  let previous = new Set<Fiber>();
  Reflect.set(globalThis, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
    supportsFiber: true, inject: () => 1,
    onCommitFiberRoot: (_id: number, root: { readonly current: Fiber }) => {
      counts.commits++;
      const current = new Set<Fiber>();
      const visit = (fiber: Fiber | null) => {
        if (!fiber) return;
        current.add(fiber);
        // React 18 PerformedWork, function/class/forwardRef/simple-memo tags.
        // Bailouts reuse children: don't count flags left on the previous committed tree.
        if (!previous.has(fiber) && (fiber.flags & 1) && [0, 1, 11, 15].includes(fiber.tag)) {
          counts.components++;
          const name = fiber.type?.name ?? 'anonymous';
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
vi.mock('../../src/i18n', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ locale: 'en', t }), useT: () => t };
});
vi.mock('../../src/router', () => ({ navigate: vi.fn() }));
vi.mock('../../src/providers/project-events', () => ({ useProjectFileEvents: vi.fn() }));
vi.mock('../../src/providers/daemon', () => ({
  listProjectRuns: vi.fn().mockResolvedValue([]), listActiveChatRuns: vi.fn().mockResolvedValue([]),
  fetchChatRunStatus: vi.fn().mockResolvedValue({ id: 'run', status: 'running' }),
  reattachDaemonRun: vi.fn(({ signal }: { readonly signal: AbortSignal }) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))),
}));
vi.mock('../../src/providers/registry', async original => ({
  ...await original<typeof import('../../src/providers/registry')>(),
  fetchLiveArtifacts: vi.fn().mockResolvedValue([]), fetchPreviewComments: vi.fn().mockResolvedValue([]), fetchProjectFiles: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/state/projects', async original => ({
  ...await original<typeof import('../../src/state/projects')>(),
  listConversations: vi.fn().mockResolvedValue([{ id: 'c', projectId: 'p', createdAt: 1, updatedAt: 1 }]),
  loadMessagePage: vi.fn(), saveMessage: vi.fn().mockResolvedValue(undefined),
  loadTabs: vi.fn().mockResolvedValue({ tabs: [], active: null }), saveTabs: vi.fn(), persistTabsToDaemonNow: vi.fn(),
}));
vi.mock('../../src/runtime/markdown', async original => {
  const actual = await original<typeof import('../../src/runtime/markdown')>();
  return { ...actual, renderMarkdown: vi.fn(actual.renderMarkdown) };
});
vi.mock('../../src/runtime/shiki', async original => {
  const actual = await original<typeof import('../../src/runtime/shiki')>();
  return { ...actual, highlightCode: vi.fn(actual.highlightCode) };
});
vi.mock('../../src/components/AppChromeHeader', () => ({ AppChromeHeader: () => null }));
vi.mock('../../src/components/AvatarMenu', () => ({ AvatarMenu: () => null }));
vi.mock('../../src/components/FileWorkspace', () => ({ FileWorkspace: () => null }));
vi.mock('../../src/components/ChatComposer', async () => ({ ChatComposer: (await import('react')).forwardRef(() => null) }));
vi.mock('../../src/components/InlineModelSwitcher', () => ({ InlineModelSwitcher: () => null }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); });

it.each([[10, 1], [70, 1], [300, 1], [10, 3], [70, 3], [300, 3]])('bounds rendering for %i messages and %i chunks per frame', async (size, chunks) => {
  // Given: real ProjectView -> ChatPane -> AssistantMessage and markdown, with SSE at the transport boundary.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const frame = async () => { await act(async () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); }); };
  const messages: ChatMessage[] = Array.from({ length: size }, (_, index) => ({
    id: `m${index}`, role: 'assistant', content: `Complete **${index}**.`,
    events: [{ kind: 'text', text: `Complete **${index}**.` }],
    runStatus: index === size - 1 ? 'running' : 'succeeded',
    ...(index === size - 1 ? { runId: 'run' } : {}),
  }));
  const codeMessage = messages[size - 2];
  if (!codeMessage) throw new Error('Missing completed code fixture');
  const code = '```typescript\nconst answer = 42;\n```';
  messages[size - 2] = { ...codeMessage, content: code, events: [{ kind: 'text', text: code }] };
  vi.mocked(loadMessagePage).mockResolvedValue({ messages, nextPosition: null });
  let view: ReturnType<typeof render> | undefined;
  await act(async () => { view = render(<ProjectView project={{ id: 'p', name: 'p', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 1 }} routeFileName={null}
    config={{ ...DEFAULT_CONFIG, mode: 'daemon' }} agents={[]} skills={[]} designTemplates={[]} designSystems={[]} daemonLive
    onModeChange={vi.fn()} onAgentChange={vi.fn()} onAgentModelChange={vi.fn()} onRefreshAgents={vi.fn()} onOpenSettings={vi.fn()}
    onClearPendingPrompt={vi.fn()} onBack={vi.fn()} onTouchProject={vi.fn()} onProjectChange={vi.fn()} onProjectsRefresh={vi.fn()} />); });
  const handlers = vi.mocked(reattachDaemonRun).mock.lastCall?.[0].handlers;
  if (!view || !handlers) throw new Error('Stream was not attached');
  const log = view.container.querySelector('.chat-log');
  if (!(log instanceof HTMLElement)) throw new Error('Missing chat log');
  const spacer = log.querySelector<HTMLElement>('.chat-virtual-spacer');
  const height = () => spacer ? Number.parseFloat(spacer.style.height) : size * 170;
  Object.defineProperties(log, { scrollHeight: { get: height }, clientHeight: { value: 600 } });
  await frame();
  log.scrollTop = height() - 600;
  fireEvent.scroll(log);
  await frame();
  // Seed a prose node before measuring ordinary text updates, not the empty-to-first-token transition.
  await act(async () => { handlers.onDelta?.('Live'); handlers.onAgentEvent?.({ kind: 'text', text: 'Live' }); });
  await frame();
  await act(async () => {
    await vi.dynamicImportSettled();
    // MarkdownCodeBlock retains its plain-code fallback if the highlighter rejects.
    // Observe either completion so no pending highlight can contaminate chunk counts.
    await Promise.allSettled(vi.mocked(highlightCode).mock.results.map(result => result.value));
  });
  expect(highlightCode).toHaveBeenCalled();
  vi.mocked(highlightCode).mockClear();
  const nodes = [...log.querySelectorAll('.msg')];
  const mutations: MutationRecord[] = [];
  const observer = new MutationObserver(records => mutations.push(...records));
  observer.observe(log, { subtree: true, childList: true, characterData: true, attributes: true });
  counts.commits = 0; counts.components = 0; counts.names.clear(); vi.mocked(renderMarkdown).mockClear();
  // When: independently delivered chunks arrive before the next animation frame.
  const deltas = [' one', ' two', ' three'].slice(0, chunks);
  for (const delta of deltas) {
    await act(async () => { handlers.onDelta?.(delta); handlers.onAgentEvent?.({ kind: 'text', text: delta }); });
  }
  const beforeFrameCommits = counts.commits;
  await frame();
  mutations.push(...observer.takeRecords()); observer.disconnect();
  const result = { size, chunks, mounted: nodes.length, components: counts.components, commits: counts.commits,
    assistantRenders: counts.names.get('AssistantMessageImpl') ?? 0, markdown: vi.mocked(renderMarkdown).mock.calls.length,
    highlight: vi.mocked(highlightCode).mock.calls.length,
    dom: mutations.length, added: mutations.reduce((sum, record) => sum + record.addedNodes.length, 0),
    removed: mutations.reduce((sum, record) => sum + record.removedNodes.length, 0) };
  // Then: batching and all complete rows bail out; no history nodes are replaced.
  expect(beforeFrameCommits).toBe(0);
  expect(log.textContent).toContain(`Live${deltas.join('')}`);
  expect([...log.querySelectorAll('.msg')]).toEqual(nodes);
  expect(result.dom).toBe(1);
  expect(result.added).toBe(0); expect(result.removed).toBe(0);
  expect(result.commits).toBe(1);
  expect(result.assistantRenders).toBe(1);
  expect(result.markdown).toBe(1);
  expect(result.highlight).toBe(0);
  expect(result.components).toBeLessThan(40);
});
