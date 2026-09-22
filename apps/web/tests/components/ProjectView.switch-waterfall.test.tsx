// @vitest-environment jsdom
import { Profiler, type ComponentProps } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectView } from '../../src/components/ProjectView';
import { DEFAULT_CONFIG } from '../../src/state/config';
import type { ChatMessage } from '../../src/types';
import { deferred } from '../helpers/deferred';

const { pane } = vi.hoisted(() => ({ pane: vi.fn() }));
vi.mock('../../src/i18n', () => ({ useI18n: () => ({ locale: 'en', t: (key: string) => key }), useT: () => (key: string) => key }));
vi.mock('../../src/router', () => ({ navigate: vi.fn() }));
vi.mock('../../src/providers/project-events', () => ({ useProjectFileEvents: vi.fn() }));
vi.mock('../../src/components/AvatarMenu', () => ({ AvatarMenu: () => null }));
vi.mock('../../src/components/FileWorkspace', () => ({ FileWorkspace: () => null }));
vi.mock('../../src/components/ChatPane', () => ({ ChatPane: (props: ComponentProps<typeof import('../../src/components/ChatPane').ChatPane>) => {
  pane(props); return <output data-testid="messages">{props.messages.length}</output>;
} }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

it('publishes the newest history page while independent preview comments are still pending on project switch', async () => {
  // Given: a 1,200-message project; only its newest bounded page is transferred.
  const history: ChatMessage[] = Array.from({ length: 1200 }, (_, index) => ({ id: `m${index}`, role: 'user', content: `Review document ${index % 6}`, createdAt: index }));
  const comments = deferred<Response>();
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); requests.push(url);
    if (url.includes('/comments')) return comments.promise;
    if (url.includes('/messages')) return Response.json({ messages: history.slice(-60), nextPosition: 1140 });
    if (url.endsWith('/conversations')) return Response.json({ conversations: [{ id: 'c', projectId: 'p', createdAt: 1, updatedAt: 1, messageCount: 1200 }] });
    if (url.endsWith('/files')) return Response.json({ files: Array.from({ length: 6 }, (_, i) => ({ name: `doc-${i}.md`, path: `doc-${i}.md`, kind: 'text', mime: 'text/markdown', mtime: 1, size: 40000 })) });
    if (url.endsWith('/tabs')) return Response.json({ tabs: [], active: null });
    if (url.endsWith('/runs')) return Response.json({ runs: [] });
    if (url.includes('/live-artifacts')) return Response.json({ artifacts: [] });
    return Response.json({ project: { id: 'p', name: 'Long project', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 1 } });
  }));
  let commits = 0;
  const start = performance.now();
  // When: the keyed project view mounts, as it does when selecting another project.
  await act(async () => { render(<Profiler id="project" onRender={() => { commits += 1; }}>
    <ProjectView project={{ id: 'p', name: 'Long project', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 1 }} routeFileName={null}
      config={{ ...DEFAULT_CONFIG, mode: 'api' }} agents={[]} skills={[]} designTemplates={[]} designSystems={[]} daemonLive
      onModeChange={vi.fn()} onAgentChange={vi.fn()} onAgentModelChange={vi.fn()} onRefreshAgents={vi.fn()} onOpenSettings={vi.fn()}
      onClearPendingPrompt={vi.fn()} onBack={vi.fn()} onTouchProject={vi.fn()} onProjectChange={vi.fn()} onProjectsRefresh={vi.fn()} />
  </Profiler>); });
  const visibleWhileCommentsPending = document.querySelector('[data-testid="messages"]')?.textContent;
  console.info('PROJECT_SWITCH', JSON.stringify({ requests, commits, chatRenders: pane.mock.calls.length, visibleWhileCommentsPending, contentDomMs: performance.now() - start }));
  await act(async () => { comments.resolve(Response.json({ comments: [] })); });
  // Then: comments latency cannot hold the independently available bounded transcript hostage.
  expect(visibleWhileCommentsPending).toBe('60');
  expect(requests.filter(url => url.includes('/messages'))).toHaveLength(1);
  expect(requests.filter(url => url.endsWith('/files'))).toHaveLength(1);
  expect(pane.mock.lastCall?.[0].hasOlderMessages).toBe(true);
});
