// @vitest-environment jsdom

// Opening a session from the hub must not create a second tab for a project
// that already has one: WorkspaceTabsBar's route sync already reuses the
// existing project tab, so an unconditional append would double it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.hoisted(() => vi.fn());

vi.mock('../../src/router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/router')>();
  return { ...actual, navigate };
});

import { openSessionRoute } from '../../src/components/hub/openSessionRoute';

const OPEN_WORKSPACE_TAB_EVENT = 'readable-studio:workspace-tabs:open';

describe('hub session handoff tab identity', () => {
  let opened: Array<{ reuseExisting?: boolean }>;
  let listener: (event: Event) => void;

  beforeEach(() => {
    window.localStorage.clear();
    opened = [];
    listener = (event: Event) => {
      opened.push((event as CustomEvent<{ reuseExisting?: boolean }>).detail);
    };
    window.addEventListener(OPEN_WORKSPACE_TAB_EVENT, listener);
  });

  afterEach(() => {
    window.removeEventListener(OPEN_WORKSPACE_TAB_EVENT, listener);
    navigate.mockReset();
  });

  it('asks the tab bar to reuse an existing project tab', () => {
    openSessionRoute('p1', 'c1');
    expect(opened).toHaveLength(1);
    expect(opened[0]?.reuseExisting).toBe(true);
  });

  it('does not persist a duplicate tab for a project already open', () => {
    openSessionRoute('p1', 'c1');
    openSessionRoute('p1', 'c2');
    const projectTabs = opened.filter(
      (detail) => (detail as { route?: { projectId?: string } }).route?.projectId === 'p1',
    );
    expect(projectTabs).toHaveLength(2);
    expect(projectTabs.every((d) => d.reuseExisting === true)).toBe(true);
  });
});
