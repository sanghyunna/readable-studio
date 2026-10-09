// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HubSessionTree } from '../../src/components/hub/HubSessionTree';
import type { HubRailTree } from '../../src/components/hub/types';
const key = 'readable-studio:hub-folder-collapsed';
const child = { id: 'child', workspaceId: 'workspace', folderId: 'folder', workspaceSessionCount: 1, title: 'Full session title', updatedAt: 1, state: 'idle' as const };
const recent = { ...child, id: 'recent', folderId: null };
const tree: HubRailTree = { folders: [{ id: 'folder', name: 'Folder', updatedAt: 1, sessions: [child] }], recents: [recent] };
beforeEach(() => localStorage.removeItem(key));
afterEach(() => { cleanup(); localStorage.removeItem(key); });
it('A-01 exposes the same info and menu handlers for folder sessions and recents in portalled flyouts', () => {
  const peek = vi.fn(), open = vi.fn(), rename = vi.fn();
  render(<HubSessionTree tree={tree} collapsed currentSessionId={null} onOpenSession={open} onPeekSession={peek} onRenameSession={rename} />);
  for (const [trigger, id] of [['hub-project-folder', 'child'], ['hub-recents-flyout-trigger', 'recent']]) {
    fireEvent.click(screen.getByTestId(trigger!));
    const flyout = screen.getByTestId('hub-project-flyout');
    expect(document.body.contains(flyout)).toBe(true);
    expect(flyout.closest('.hub-tree')).toBeNull();
    expect(within(flyout).getByTestId(`hub-session-${id}`).getAttribute('data-tooltip')).toBe(child.title);
    fireEvent.click(within(flyout).getByTestId(`hub-peek-${id}`));
    expect(peek).toHaveBeenLastCalledWith(id === 'child' ? child : recent);
    fireEvent.click(within(flyout).getByTestId(`hub-menu-session-${id}`));
    fireEvent.click(screen.getByTestId('hub-row-menu-rename'));
    const input = screen.getByTestId(`hub-rename-s-${id}`);
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(rename).toHaveBeenLastCalledWith(id === 'child' ? child : recent, 'Renamed');
    fireEvent.keyDown(within(flyout).getByTestId(`hub-session-${id}`), { key: 'Escape' });
    expect(screen.queryByTestId('hub-project-flyout')).toBeNull();
  }
});
it('A-02 retains disclosure through renderer remount and prunes deleted folders', () => {
  const props = { tree, currentSessionId: null, onOpenSession: vi.fn() };
  const first = render(<HubSessionTree {...props} />);
  fireEvent.click(screen.getByTestId('hub-project-folder'));
  expect(screen.getByTestId('hub-project-folder').getAttribute('aria-expanded')).toBe('false');
  first.unmount(); sessionStorage.clear();
  const second = render(<HubSessionTree {...props} />);
  expect(screen.getByTestId('hub-project-folder').getAttribute('aria-expanded')).toBe('false');
  second.rerender(<HubSessionTree {...props} tree={{ folders: [], recents: [recent] }} />);
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual({});
});
it('A-05 reveals newly created and navigated current sessions but respects explicit collapse until navigation', () => {
  const props = { onOpenSession: vi.fn(), currentSessionId: null as string | null };
  const view = render(<HubSessionTree {...props} tree={{ ...tree, folders: [{ ...tree.folders[0]!, sessions: [] }] }} />);
  fireEvent.click(screen.getByTestId('hub-project-folder'));
  view.rerender(<HubSessionTree {...props} tree={tree} currentSessionId="child" />);
  expect(screen.getByTestId('hub-project-folder').getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(screen.getByTestId('hub-project-folder'));
  view.rerender(<HubSessionTree {...props} tree={{ ...tree }} currentSessionId="child" />);
  expect(screen.getByTestId('hub-project-folder').getAttribute('aria-expanded')).toBe('false');
  view.rerender(<HubSessionTree {...props} tree={tree} currentSessionId="recent" />);
  view.rerender(<HubSessionTree {...props} tree={tree} currentSessionId="child" />);
  expect(screen.getByTestId('hub-project-folder').getAttribute('aria-expanded')).toBe('true');
});
