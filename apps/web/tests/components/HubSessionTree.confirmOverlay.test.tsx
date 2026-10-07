// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HubSessionTree } from '../../src/components/hub/HubSessionTree';
import type { HubFolderNode } from '../../src/components/hub/types';
import { useModalWindowDragGuard } from '../../src/hooks/useModalWindowDragGuard';

const projects: HubFolderNode[] = [
  { id: 'one', name: 'One', updatedAt: 2, sessions: [] },
  {
    id: 'two', name: 'Two', updatedAt: 1,
    sessions: [{ id: 's2', workspaceId: 'two', folderId: 'two', workspaceSessionCount: 1, title: 'Session two', updatedAt: 1, state: 'idle' }],
  },
];
afterEach(cleanup);

function GuardedRail({
  collapsed, width, onDeleteFolder, onDeleteSession, onShellClick,
}: {
  collapsed: boolean;
  width: number;
  onDeleteFolder: () => void;
  onDeleteSession: () => void;
  onShellClick: () => void;
}) {
  // AppInner installs this native document-capture listener above the portal.
  useModalWindowDragGuard();
  return (
    <aside className="hub__nav" onClick={onShellClick}
      style={{ width, overflow: 'hidden', backdropFilter: 'blur(20px)' }}>
      <HubSessionTree tree={{ folders: projects, recents: [] }} collapsed={collapsed} currentSessionId={null}
        onOpenSession={vi.fn()} onDeleteFolder={onDeleteFolder} onDeleteSession={onDeleteSession} />
    </aside>
  );
}

function setup(collapsed = false, width = 262, openConfirmation = true) {
  const onDeleteFolder = vi.fn();
  const onDeleteSession = vi.fn();
  const onShellClick = vi.fn();
  render(<GuardedRail collapsed={collapsed} width={width} onDeleteFolder={onDeleteFolder}
    onDeleteSession={onDeleteSession} onShellClick={onShellClick} />);
  const row = screen.getByTestId('hub-project-two');
  row.focus();
  if (openConfirmation) fireEvent.keyDown(row, { key: 'Delete' });
  return { row, onDeleteFolder, onDeleteSession, onShellClick };
}

function pointerClick(target: HTMLElement, clientY = 120) {
  const mouse = { button: 0, clientX: 12, clientY };
  fireEvent.pointerDown(target, { ...mouse, pointerId: 1, pointerType: 'mouse', isPrimary: true });
  fireEvent.mouseDown(target, mouse);
  fireEvent.pointerUp(target, { ...mouse, pointerId: 1, pointerType: 'mouse', isPrimary: true });
  fireEvent.mouseUp(target, mouse);
  fireEvent.click(target, mouse);
}

describe('rail delete confirmation overlay', () => {
  it.each([false, true])('escapes the rail containing block (collapsed=%s)', (collapsed) => {
    const { onDeleteFolder } = setup(collapsed);
    const backdrop = screen.getByTestId('hub-delete-confirm-backdrop');
    expect(backdrop.parentElement).toBe(document.body);
    expect(backdrop.closest('.hub__nav')).toBeNull();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '');
    const description = document.getElementById(dialog.getAttribute('aria-describedby') ?? '');
    expect(title).not.toBeNull();
    expect(description?.id).toBe(dialog.getAttribute("aria-describedby"));
    expect(onDeleteFolder).not.toHaveBeenCalled();
  });

  it('starts on cancel, traps both tab boundaries, and restores the originating row on Escape', () => {
    const { row, onDeleteFolder } = setup();
    const cancel = screen.getByTestId('hub-delete-cancel');
    const confirm = screen.getByTestId('hub-delete-confirm-cta');
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(confirm, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(document.activeElement).toBe(confirm);
    row.focus();
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(cancel, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(row);
    expect(onDeleteFolder).not.toHaveBeenCalled();
  });

  it.each([
    [262, 12], [262, 120], [420, 12], [420, 120],
  ])('owns inside and backdrop pointer clicks at rail width %i and y=%i', (width, clientY) => {
    const { row, onDeleteFolder, onDeleteSession, onShellClick } = setup(false, width);
    const dialog = screen.getByRole('alertdialog');
    const backdrop = screen.getByTestId('hub-delete-confirm-backdrop');
    expect(backdrop.parentElement).toBe(document.body);
    pointerClick(dialog, clientY);
    pointerClick(document.getElementById(dialog.getAttribute('aria-labelledby')!)!, clientY);
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    expect(document.activeElement).toBe(screen.getByTestId('hub-delete-confirm-cta'));
    expect(onShellClick).not.toHaveBeenCalled();
    pointerClick(backdrop, clientY);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(row);
    expect(onDeleteFolder).not.toHaveBeenCalled();
    expect(onDeleteSession).not.toHaveBeenCalled();
    // Portals bubble through their React owners despite living under body.
    expect(onShellClick).not.toHaveBeenCalled();
  });

  it('cancels by mouse click and restores the row without deleting', () => {
    const { row, onDeleteFolder } = setup();
    pointerClick(screen.getByTestId('hub-delete-cancel'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(row);
    expect(onDeleteFolder).not.toHaveBeenCalled();
  });

  it.each([262, 420])('keeps session deletion undoable without a confirmation at rail width %i', (width) => {
    const { onDeleteFolder, onDeleteSession } = setup(false, width, false);
    pointerClick(screen.getByTestId('hub-menu-session-s2'));
    const menu = screen.getByTestId('hub-row-menu');
    expect(menu.parentElement).toBe(document.body);
    pointerClick(screen.getByTestId('hub-row-menu-delete'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByTestId('hub-row-menu')).toBeNull();
    expect(onDeleteSession).toHaveBeenCalledExactlyOnceWith(projects[1]!.sessions[0]);
    expect(onDeleteFolder).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByTestId('hub-session-s2'));
  });

  it.each([262, 420])('confirms the selected project through its portalled menu at rail width %i', (width) => {
    const { row, onDeleteFolder, onDeleteSession } = setup(false, width, false);
    pointerClick(screen.getByTestId('hub-menu-folder-two'));
    expect(screen.getByTestId('hub-row-menu').parentElement).toBe(document.body);
    pointerClick(screen.getByTestId('hub-row-menu-delete'));
    expect(screen.queryByTestId('hub-row-menu')).toBeNull();
    expect(screen.getByTestId('hub-delete-confirm-backdrop').parentElement).toBe(document.body);
    expect(document.activeElement).toBe(screen.getByTestId('hub-delete-confirm-cta'));
    expect(onDeleteFolder).not.toHaveBeenCalled();
    pointerClick(screen.getByTestId('hub-delete-confirm-cta'));
    expect(onDeleteFolder).toHaveBeenCalledExactlyOnceWith(projects[1], 'keep');
    expect(onDeleteSession).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(row);
  });
});
