// @vitest-environment jsdom

/**
 * The session-surface handoff must not leak a chat transcript into a workspace
 * tab the user never asked for.
 *
 * User, verbatim: "워크스페이스 탭에 가끔 채팅 내용이 들어가는데, 거기 대체 그게 왜
 * 들어가냐고."
 *
 * The symptom was INTERMITTENT, so a single clean pass proves nothing: the old
 * protocol also passed every straight-line test it had. These tests therefore
 * drive the two failure paths deliberately rather than waiting for them:
 *
 *   1. the request is collected by the WRONG project;
 *   2. the request is applied LATER, on a tab-state change that is not the
 *      navigation's hydration.
 *
 * Each one fails loudly against the previous protocol - the mismatch test
 * because a mismatched read left the entry armed, and the staleness test
 * because a pending request was applied on any subsequent tab-state identity
 * change with no time bound at all.
 */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  consumeHubSessionSurface,
  queueHubSessionSurface,
  HUB_SESSION_SURFACE_REQUEST_KEY,
  HUB_SESSION_SURFACE_TTL_MS,
} from '../../src/components/hub/HubSessionTree';
import { FileWorkspace } from '../../src/components/FileWorkspace';
import type { OpenTabsState } from '../../src/types';

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return { ...actual, createTerminal: vi.fn(), killTerminal: vi.fn() };
});

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return { ...actual, fetchProjectFolders: vi.fn().mockResolvedValue([]) };
});

vi.mock('../../src/components/workspace/TerminalViewer', () => ({
  TerminalViewer: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="terminal-viewer">{terminalId}</div>
  ),
}));

const baseProps = {
  projectKind: 'prototype' as const,
  files: [],
  onRefreshFiles: vi.fn(),
  isDeck: false,
};

/**
 * Mount a workspace and let it hydrate, exactly as ProjectView does.
 *
 * The negative assertions below cannot wait for a callback that correctly never
 * fires, so this returns only after React has flushed effects AND any promise
 * jobs they queued (the terminal path resolves through one). That is a
 * deterministic drain, not a timing guess: if a surface were going to open, it
 * has opened by the time this resolves.
 */
async function mountWorkspaceAndHydrate(
  projectId: string,
  onTabsStateChange: (n: OpenTabsState) => void,
) {
  const before: OpenTabsState = { tabs: [], active: null };
  const after: OpenTabsState = { tabs: [], active: null, hasSavedState: true };
  const view = render(
    <FileWorkspace
      {...baseProps}
      projectId={projectId}
      tabsState={before}
      onTabsStateChange={onTabsStateChange}
    />,
  );
  // A NEW object identity: this is the async tab hydration the handoff waits for.
  view.rerender(
    <FileWorkspace
      {...baseProps}
      projectId={projectId}
      tabsState={after}
      onTabsStateChange={onTabsStateChange}
    />,
  );
  await act(async () => {});
  return view;
}

/** Every tab id this workspace ever tried to persist. */
function persistedTabIds(onTabsStateChange: ReturnType<typeof vi.fn>): string[] {
  return onTabsStateChange.mock.calls.flatMap((call) => (call[0] as OpenTabsState).tabs);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

describe('session-surface handoff: a request cannot reach the wrong project', () => {
  it('refuses a request addressed to another project AND disarms it', async () => {
    // The user asked for a side chat in p1.
    queueHubSessionSurface({ projectId: 'p1', kind: 'side-chat', conversationId: 'c1' });

    // Navigation lands on p2 instead - the race the intermittent report comes
    // from. p2 must not open p1's transcript.
    const p2Tabs = vi.fn();
    const p2 = await mountWorkspaceAndHydrate('p2', p2Tabs);
    expect(persistedTabIds(p2Tabs).some((id) => id.startsWith('chat:'))).toBe(false);
    p2.unmount();

    // ...and the request must be SPENT, not left armed. Under the old protocol
    // a mismatched read returned null without removing the entry, so this next
    // ordinary visit to p1 is where the mystery chat tab appeared.
    const p1Tabs = vi.fn();
    const p1 = await mountWorkspaceAndHydrate('p1', p1Tabs);
    expect(persistedTabIds(p1Tabs).some((id) => id.startsWith('chat:'))).toBe(false);
    p1.unmount();
  });

  it('leaves nothing in the mailbox after a mismatched read', () => {
    queueHubSessionSurface({ projectId: 'p1', kind: 'side-chat', conversationId: 'c1' });

    // The wrong project looks, and gets nothing...
    expect(consumeHubSessionSurface('p2')).toBeNull();

    // ...and the mailbox is empty afterwards, so the request cannot be
    // collected by anyone later. This is the assertion the old code failed.
    const remaining = Object.keys(window.sessionStorage).filter((key) =>
      key.startsWith(HUB_SESSION_SURFACE_REQUEST_KEY),
    );
    expect(remaining).toEqual([]);
    expect(consumeHubSessionSurface('p1')).toBeNull();
  });

  it('never hands one project a request addressed to another, for either surface', () => {
    for (const request of [
      { projectId: 'p1', kind: 'terminal' },
      { projectId: 'p1', kind: 'side-chat', conversationId: 'c1' },
    ] as const) {
      queueHubSessionSurface(request);
      expect(consumeHubSessionSurface('p2')).toBeNull();
      window.sessionStorage.clear();
    }
  });
});

describe('session-surface handoff: a request cannot fire at an arbitrary later time', () => {
  it('drops a request whose navigation window has passed before collection', () => {
    queueHubSessionSurface({ projectId: 'p1', kind: 'side-chat', conversationId: 'c1' });

    vi.setSystemTime(Date.now() + HUB_SESSION_SURFACE_TTL_MS + 1);

    expect(consumeHubSessionSurface('p1')).toBeNull();
  });

  it('does not open a surface on a tab-state change that is not this navigation', async () => {
    queueHubSessionSurface({ projectId: 'p1', kind: 'side-chat', conversationId: 'c1' });

    const onTabsStateChange = vi.fn();
    const hydrating: OpenTabsState = { tabs: [], active: null };
    const view = render(
      <FileWorkspace
        {...baseProps}
        projectId="p1"
        tabsState={hydrating}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    // The navigation window elapses while the workspace sits there un-hydrated
    // (slow or offline tab loading, per the investigation).
    vi.setSystemTime(Date.now() + HUB_SESSION_SURFACE_TTL_MS + 1);

    // NOW an unrelated tab-state mutation arrives. The old consumer treated any
    // new tabsState identity as its cue and opened the transcript here - long
    // after the click, which is exactly what the user could not explain.
    view.rerender(
      <FileWorkspace
        {...baseProps}
        projectId="p1"
        tabsState={{ tabs: ['README.md'], active: 'README.md' }}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    await act(async () => {});
    expect(persistedTabIds(onTabsStateChange).some((id) => id.startsWith('chat:'))).toBe(false);
    view.unmount();
  });

  it('still delivers promptly inside the navigation window', async () => {
    // The guards must not have cost the feature: the honest path still works.
    queueHubSessionSurface({ projectId: 'p1', kind: 'side-chat', conversationId: 'c1' });

    const onTabsStateChange = vi.fn();
    await mountWorkspaceAndHydrate('p1', onTabsStateChange);

    await waitFor(() => {
      expect(onTabsStateChange).toHaveBeenCalledWith({ tabs: ['chat:c1'], active: 'chat:c1' });
    });
  });
});

describe('session-surface handoff: requests stay one-shot per navigation', () => {
  it('does not replay a delivered request into a later visit', async () => {
    queueHubSessionSurface({ projectId: 'p1', kind: 'side-chat', conversationId: 'c1' });

    const first = vi.fn();
    const view = await mountWorkspaceAndHydrate('p1', first);
    await waitFor(() => {
      expect(first).toHaveBeenCalledWith({ tabs: ['chat:c1'], active: 'chat:c1' });
    });
    view.unmount();

    // Re-opening the same project must not re-open the surface: the request was
    // consumed by the navigation it belonged to.
    const second = vi.fn();
    await mountWorkspaceAndHydrate('p1', second);
    expect(persistedTabIds(second).some((id) => id.startsWith('chat:'))).toBe(false);
  });
});
