// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubRail } from '../../src/components/hub/HubRail';
import { HubRailProvider } from '../../src/components/hub/HubRailContext';
import { useHubRailController } from '../../src/components/hub/useHubRailController';

let folderId: string | null;
const request = vi.fn();
const folders = [{ id: 'f1', name: 'First', createdAt: 1, updatedAt: 2 }, { id: 'f2', name: 'Second', createdAt: 1, updatedAt: 1 }];
function Host() {
 const rail = useHubRailController({ currentSessionId: null, onOpenSession: vi.fn(), onNewProject: vi.fn() });
 return <HubRailProvider value={rail}><HubRail /><output data-testid="selected">{rail.selectedFolder?.id ?? 'none'}</output><output data-testid="chip">{rail.commandChip?.id}</output></HubRailProvider>;
}
beforeEach(() => {
 folderId = 'f1'; request.mockReset();
 vi.stubGlobal('fetch', request.mockImplementation(async (url: string, init?: RequestInit) => {
  if (init?.method === 'PATCH') { folderId = JSON.parse(String(init.body)).folderId; return { ok: true, json: async () => ({ session: {id: 's', folderId} }) }; }
  const session = { id: 's', workspaceId: 'workspace', folderId, title: 'Session', createdAt: 1, updatedAt: 2, state: 'idle', workspaceSessionCount: 1, messageCount: 0 };
  return { ok: true, json: async () => ({ folders: folders.map(f => ({...f, sessions: folderId === f.id ? [session] : []})), recents: folderId === null ? [session] : [], generatedAt: 1 }) };
 }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe('session move menu', () => {
 it('lists none and every folder, disables the current location, and PATCHes only placement', async () => {
  await act(async () => { render(<Host />); });
  fireEvent.contextMenu(screen.getByTestId('hub-session-s'));
  fireEvent.click(screen.getByTestId('hub-row-menu-move'));
  expect(screen.getAllByRole('menuitemradio')).toHaveLength(3);
  expect((screen.getByTestId('hub-row-menu-move-f1') as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByTestId('hub-row-menu-move-f1').getAttribute('aria-checked')).toBe('true');
  await act(async () => { fireEvent.click(screen.getByTestId('hub-row-menu-move-none')); });
  expect(request).toHaveBeenCalledWith('/api/sessions/s', expect.objectContaining({method: 'PATCH', body: JSON.stringify({folderId: null})}));
  expect(within(screen.getByTestId('hub-section-recents')).getByTestId('hub-session-s')).toBeTruthy();
  expect(screen.getByTestId('hub-session-s').dataset.folder).toBe('none');
 });
 it('supports Shift+F10, ArrowRight, Escape back and a folder target', async () => {
  await act(async () => { render(<Host />); });
  const row = screen.getByTestId('hub-session-s'); row.focus();
  fireEvent.keyDown(row, {key: 'F10', shiftKey: true});
  const move = screen.getByTestId('hub-row-menu-move'); move.focus();
  fireEvent.keyDown(move, {key: 'ArrowRight'});
  fireEvent.keyDown(screen.getByTestId('hub-row-menu'), {key: 'Escape'});
  expect(screen.getByTestId('hub-row-menu-move')).toBeTruthy();
  fireEvent.click(screen.getByTestId('hub-row-menu-move'));
  await act(async () => { fireEvent.click(screen.getByTestId('hub-row-menu-move-f2')); });
  expect(request).toHaveBeenCalledWith('/api/sessions/s', expect.objectContaining({body: JSON.stringify({folderId: 'f2'})}));
  expect(within(screen.getByTestId('hub-section-recents')).queryByTestId('hub-session-s')).toBeNull();
 });
 it('selects a folder for composition and clears it through new session', async () => {
  await act(async () => { render(<Host />); });
  fireEvent.click(screen.getByTestId('hub-project-f1'));
  expect(screen.getByTestId('selected').textContent).toBe('f1');
  fireEvent.click(screen.getByTestId('hub-new-session'));
  expect(screen.getByTestId('selected').textContent).toBe('none');
  expect(screen.getByTestId('chip').textContent).toBe('new-session');
 });
});
