// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubRail } from '../../src/components/hub/HubRail';
import { HubRailProvider } from '../../src/components/hub/HubRailContext';
import { HUB_SESSION_DRAG_TYPE } from '../../src/components/hub/HubSessionTree';
import { useHubRailController } from '../../src/components/hub/useHubRailController';

const request = vi.fn();
let folderId: string | null;
function Host() {
 const rail = useHubRailController({currentSessionId: null, onOpenSession: vi.fn(), onNewProject: vi.fn()});
 return <HubRailProvider value={rail}><HubRail /></HubRailProvider>;
}
function transfer(types: string[] = []) {
 const data = new Map<string, string>();
 return { types, effectAllowed: '', dropEffect: '', setData: (type: string, value: string) => {data.set(type, value); if (!types.includes(type)) types.push(type);}, getData: (type: string) => data.get(type) ?? '' };
}
beforeEach(() => {
 folderId = null; request.mockReset();
 vi.stubGlobal('fetch', request.mockImplementation(async (_url: string, init?: RequestInit) => {
  if(init?.method === 'PATCH') { folderId = JSON.parse(String(init.body)).folderId; return {ok: true, json: async () => ({session: {id: 's', folderId}})}; }
  const session = {id: 's', workspaceId: 'w', folderId, title: 'Session', updatedAt: 1, createdAt: 1, state: 'idle', workspaceSessionCount: 1, messageCount: 0};
  return {ok: true, json: async () => ({folders: [{id: 'f', name: 'Folder', updatedAt: 1, createdAt: 1, sessions: folderId === 'f' ? [session] : []}], recents: folderId === null ? [session] : [], generatedAt: 1})};
 }));
});
afterEach(() => {cleanup(); vi.unstubAllGlobals(); window.localStorage.clear();});

describe('native rail drag and drop', () => {
 it('highlights and moves onto a folder and back onto recents through the same PATCH', async () => {
  await act(async () => { render(<Host />); });
  const dataTransfer = transfer();
  fireEvent.dragStart(screen.getByTestId('hub-session-s'), {dataTransfer});
  expect(dataTransfer.getData(HUB_SESSION_DRAG_TYPE)).toBe('s');
  expect(dataTransfer.getData('text/plain')).toBe('s');
  expect(screen.getByTestId('hub-session-s').dataset.dragging).toBe('true');
  const folder = screen.getByTestId('hub-project-f');
  fireEvent.dragOver(folder, {dataTransfer}); expect(folder.dataset.drop).toBe('active');
  fireEvent.dragLeave(folder, {dataTransfer}); expect(folder.dataset.drop).toBeUndefined();
  fireEvent.dragOver(folder, {dataTransfer});
  await act(async () => { fireEvent.drop(folder, {dataTransfer}); });
  expect(folder.dataset.drop).toBeUndefined();
  expect(request).toHaveBeenCalledWith('/api/sessions/s', expect.objectContaining({method: 'PATCH', body: JSON.stringify({folderId: 'f'})}));
  expect(within(screen.getByTestId('hub-section-recents')).queryByTestId('hub-session-s')).toBeNull();
  fireEvent.dragStart(screen.getByTestId('hub-session-s'), {dataTransfer});
  const recents = screen.getByTestId('hub-section-recents');
  fireEvent.dragOver(recents, {dataTransfer}); expect(recents.dataset.drop).toBe('active');
  await act(async () => {fireEvent.drop(recents, {dataTransfer});});
  expect(recents.dataset.drop).toBeUndefined();
  expect(request).toHaveBeenCalledWith('/api/sessions/s', expect.objectContaining({body: JSON.stringify({folderId: null})}));
  expect(within(recents).getByTestId('hub-session-s')).toBeTruthy();
 });
 it('ignores file drops and same-location drops', async () => {
  await act(async () => {render(<Host />);});
  const folder = screen.getByTestId('hub-project-f');
  fireEvent.dragOver(folder, {dataTransfer: transfer(['Files'])});
  expect(folder.dataset.drop).toBeUndefined();
  const dataTransfer = transfer(); fireEvent.dragStart(screen.getByTestId('hub-session-s'), {dataTransfer});
  fireEvent.drop(screen.getByTestId('hub-section-recents'), {dataTransfer});
  expect(request.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
 });
 it('accepts the same session payload on collapsed folder glyphs', async () => {
  await act(async () => {render(<Host />);});
  const dataTransfer = transfer(); fireEvent.dragStart(screen.getByTestId('hub-session-s'), {dataTransfer});
  fireEvent.click(screen.getByTestId('hub-rail-toggle'));
  expect(screen.queryByTestId('hub-section-recents')).toBeNull();
  const folder = screen.getByTestId('hub-project-f'); fireEvent.dragOver(folder, {dataTransfer});
  expect(folder.dataset.drop).toBe('active');
  await act(async () => {fireEvent.drop(folder, {dataTransfer});});
  expect(request).toHaveBeenCalledWith('/api/sessions/s', expect.objectContaining({body: JSON.stringify({folderId: 'f'})}));
 });
});
