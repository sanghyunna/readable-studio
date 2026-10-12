// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubTestHost } from '../helpers/HubTestHost';

vi.mock('../../src/state/rail', async (original) => ({
  ...await original<typeof import('../../src/state/rail')>(),
  subscribeRailEvents: () => () => {},
}));

let pinned: string[];
let fail: boolean;
let resolveMutation: ((response: Response) => void) | undefined;
const fetchMock = vi.fn();
const open = vi.fn();
const session = (id: string, folderId: string | null) => ({
  id, title: `Session ${id}`, workspaceId: `w-${id}`, folderId,
  createdAt: 1, updatedAt: 1, state: 'idle', workspaceSessionCount: 1,
});
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

beforeEach(() => {
  pinned = [];
  fail = false;
  resolveMutation = undefined;
  fetchMock.mockReset();
  open.mockReset();
  window.localStorage.clear();
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url === '/api/rail') return response({
      folders: [{ id: 'f', name: 'Folder', createdAt: 1, updatedAt: 1, sessions: [session('a', 'f')] }],
      recents: [session('b', null)], pinned: [...pinned], generatedAt: 1,
    });
    if (url.endsWith('/pin')) {
      if (fail) return response({}, false);
      const id = url.split('/')[3]!;
      pinned = options?.method === 'PUT' ? [...pinned, id] : pinned.filter((pin) => pin !== id);
      return response({ pinned: [...pinned] });
    }
    return response({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function mount() {
  await act(async () => render(
    <HubTestHost currentSessionId={null} onOpenSession={open} onNewProject={vi.fn()}>
      <span>Home</span>
    </HubTestHost>,
  ));
}
async function toggle(id: string) {
  await act(async () => fireEvent.click(within(screen.getByTestId(`hub-session-${id}`)).getByTestId(`hub-pin-${id}`)));
}

describe('pinned rail shortcuts', () => {
  it('has no pinned section when empty and opening does not create one', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('hub-session-a'));
    expect(open).toHaveBeenCalledWith('w-a', 'a');
    expect(screen.queryByTestId('hub-pinned')).toBeNull();
    expect(screen.queryByTestId('hub-open-work')).toBeNull();
  });

  it('pins via PUT in pin order without moving folder or recent rows', async () => {
    await mount();
    await toggle('b');
    await toggle('a');
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/b/pin', { method: 'PUT' });
    const list = screen.getByTestId('hub-pinned');
    expect(list.getAttribute('role')).toBe('list');
    expect(list.closest('[role="tree"]')).toBeNull();
    expect(within(list).getAllByRole('listitem').map((row) => row.dataset.testid)).toEqual(['hub-pinned-b', 'hub-pinned-a']);
    expect(screen.getByTestId('hub-session-a').dataset.folder).toBe('f');
    expect(screen.getByTestId('hub-session-b').dataset.folder).toBe('none');
    expect(open).not.toHaveBeenCalled();
  });

  it('unpins through the shortcut and opens it with click and Enter', async () => {
    pinned = ['a'];
    await mount();
    const shortcut = screen.getByTestId('hub-pinned-a');
    fireEvent.click(shortcut);
    fireEvent.keyDown(shortcut, { key: 'Enter' });
    expect(open).toHaveBeenCalledTimes(2);
    await act(async () => fireEvent.click(within(shortcut).getByTestId('hub-pin-a')));
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/a/pin', { method: 'DELETE' });
    expect(screen.queryByTestId('hub-pinned')).toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('keeps descendant Enter and Space away from row activation', async () => {
    await mount();
    const button = screen.getByTestId('hub-pin-a');
    button.focus();
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.keyDown(button, { key: ' ' });
    // Native button activation is a click; jsdom does not synthesize it.
    await act(async () => fireEvent.click(button));
    expect(pinned).toEqual(['a']);
    expect(open).not.toHaveBeenCalled();
  });

  it('uses the shared row menu for pin and unpin, including shortcuts', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('hub-menu-session-a'));
    await act(async () => fireEvent.click(screen.getByTestId('hub-row-menu-pin')));
    fireEvent.click(within(screen.getByTestId('hub-pinned-a')).getByTestId('hub-menu-session-a'));
    await act(async () => fireEvent.click(screen.getByTestId('hub-row-menu-unpin')));
    expect(pinned).toEqual([]);
    expect(within(screen.getByRole('tree')).getAllByRole('treeitem').filter((row) => row.tabIndex === 0)).toHaveLength(1);
  });

  it('shows the optimistic shortcut before the mutation resolves and rolls back on failure', async () => {
    await mount();
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveMutation = resolve; }));
    fireEvent.click(screen.getByTestId('hub-pin-a'));
    expect(screen.getByTestId('hub-pinned-a')).toBeTruthy();
    await act(async () => resolveMutation?.(response({}, false)));
    expect(screen.queryByTestId('hub-pinned')).toBeNull();
    expect(screen.getByTestId('hub-session-a')).toBeTruthy();
  });

  it('restores a failed unpin', async () => {
    pinned = ['a'];
    await mount();
    fail = true;
    await toggle('a');
    expect(screen.getByTestId('hub-pinned-a')).toBeTruthy();
  });

  it('hides a shortcut during deletion and restores it on undo', async () => {
    pinned = ['a'];
    await mount();
    fireEvent.click(within(screen.getByTestId('hub-pinned-a')).getByTestId('hub-menu-session-a'));
    fireEvent.click(screen.getByTestId('hub-row-menu-delete'));
    expect(screen.queryByTestId('hub-pinned-a')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Undo|실행 취소/ }));
    expect(screen.getByTestId('hub-pinned-a')).toBeTruthy();
  });

  it('keeps shortcuts outside search and status filters and in the collapsed rail', async () => {
    pinned = ['b', 'a'];
    await mount();
    fireEvent.change(screen.getByTestId('hub-search'), { target: { value: 'no match' } });
    expect(screen.getByTestId('hub-pinned-a')).toBeTruthy();
    fireEvent.click(screen.getByTestId('hub-filter-running'));
    expect(screen.getByTestId('hub-pinned-b')).toBeTruthy();
    fireEvent.click(screen.getByTestId('hub-rail-toggle'));
    expect(screen.getByTestId('hub-nav').dataset.projectRailState).toBe('collapsed');
    expect(screen.getByTestId('hub-pinned-a').dataset.initial).toBe('S');
    expect(screen.getByTestId('hub-pinned-a').dataset.tooltip).toBe('Session a');
  });

  it('toggles pins on the reused session rows in collapsed folder flyouts', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('hub-rail-toggle'));
    fireEvent.click(screen.getByTestId('hub-project-f'));
    const flyout = screen.getByTestId('hub-project-flyout');
    await act(async () => fireEvent.click(within(flyout).getByTestId('hub-pin-a')));
    expect(screen.getByTestId('hub-pinned-a')).toBeTruthy();
    expect(within(flyout).getByTestId('hub-session-a')).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
  });
});
