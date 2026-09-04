// @vitest-environment jsdom

// The rail's right-click menu. What matters here is that the menu targets the
// row it was opened from, never navigates as a side effect of opening, is
// reachable without a mouse, cannot delete anything unconfirmed, and stays
// inside the viewport when the pointer is at an edge.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HubSessionTree } from '../../src/components/hub/HubSessionTree';
import type { HubProjectNode } from '../../src/components/hub/types';
import { I18nProvider } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';
import { ko } from '../../src/i18n/locales/ko';

afterEach(() => {
  cleanup();
});

const PROJECTS: HubProjectNode[] = [
  {
    id: 'p1',
    name: '분기 보고서',
    updatedAt: 900,
    sessions: [
      { id: 's1', projectId: 'p1', title: '차트 팔레트 정리', updatedAt: 900, state: 'idle' },
      { id: 's2', projectId: 'p1', title: '범례 겹침 수정', updatedAt: 800, state: 'idle' },
    ],
  },
  {
    id: 'p2',
    name: '가격 페이지',
    updatedAt: 100,
    sessions: [{ id: 's3', projectId: 'p2', title: '요금제 비교표', updatedAt: 100, state: 'idle' }],
  },
];

function renderTree(overrides: Partial<Parameters<typeof HubSessionTree>[0]> = {}) {
  const props = {
    projects: PROJECTS,
    currentSessionId: null,
    onOpenSession: vi.fn(),
    onOpenProject: vi.fn(),
    onPeekSession: vi.fn(),
    onNewSession: vi.fn(),
    onRenameProject: vi.fn(),
    onDeleteProject: vi.fn(),
    onRenameSession: vi.fn(),
    onDeleteSession: vi.fn(),
    ...overrides,
  };
  render(<HubSessionTree {...props} />);
  return props;
}

function contextMenu(element: HTMLElement, at: { clientX: number; clientY: number }) {
  fireEvent.contextMenu(element, { ...at, bubbles: true, cancelable: true });
}

describe('HubSessionTree context menu', () => {
  it('opens on right-click without activating the row', () => {
    const props = renderTree();
    const row = screen.getByTestId('hub-project-p2');
    const before = row.getAttribute('aria-expanded');
    contextMenu(row, { clientX: 120, clientY: 200 });

    expect(screen.getByTestId('hub-row-menu')).toBeTruthy();
    // Activating a project row toggles it; right-clicking must leave the
    // expansion exactly as it found it and must not navigate.
    expect(props.onOpenProject).not.toHaveBeenCalled();
    expect(props.onOpenSession).not.toHaveBeenCalled();
    expect(row.getAttribute('aria-expanded')).toBe(before);
    // Non-vacuous: a plain click on the same row DOES toggle it, so the
    // unchanged state above is the contextmenu handler's doing.
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).not.toBe(before);
  });

  it('anchors the menu at the pointer', () => {
    renderTree();
    contextMenu(screen.getByTestId('hub-project-p1'), { clientX: 140, clientY: 220 });
    const menu = screen.getByTestId('hub-row-menu') as HTMLElement;
    expect(menu.style.left).toBe('140px');
    // 220 plus the menu's 6px gap.
    expect(menu.style.top).toBe('226px');
  });

  it('clamps the menu into the viewport when right-clicked at the edge', () => {
    renderTree();
    contextMenu(screen.getByTestId('hub-project-p1'), {
      clientX: window.innerWidth - 2,
      clientY: 300,
    });
    const menu = screen.getByTestId('hub-row-menu') as HTMLElement;
    const left = Number.parseFloat(menu.style.left);
    // 208px menu, 10px margin: the right edge must still fit on screen.
    expect(left).toBeLessThanOrEqual(window.innerWidth - 208 - 10);
    expect(left).toBeGreaterThanOrEqual(10);
  });

  it('is reachable from the keyboard with Shift+F10 and the context-menu key', () => {
    renderTree();
    const row = screen.getByTestId('hub-project-p1');
    row.focus();
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    expect(screen.getByTestId('hub-row-menu')).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('hub-row-menu'), { key: 'Escape' });
    expect(screen.queryByTestId('hub-row-menu')).toBeNull();
    expect(document.activeElement).toBe(row);

    fireEvent.keyDown(row, { key: 'ContextMenu' });
    expect(screen.getByTestId('hub-row-menu')).toBeTruthy();
  });

  it('leaves a bare F10 alone so it does not shadow the platform key', () => {
    renderTree();
    const row = screen.getByTestId('hub-project-p1');
    row.focus();
    fireEvent.keyDown(row, { key: 'F10' });
    expect(screen.queryByTestId('hub-row-menu')).toBeNull();
  });

  it('opens the project from the menu, using the localized open label', () => {
    const props = renderTree();
    contextMenu(screen.getByTestId('hub-project-p2'), { clientX: 40, clientY: 40 });
    const open = screen.getByTestId('hub-row-menu-open');
    expect(open.textContent).toContain(en['quickSwitcher.open']);
    fireEvent.click(open);
    expect(props.onOpenProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'p2' }));
  });

  it('renames through the existing in-row rename flow', () => {
    const props = renderTree();
    contextMenu(screen.getByTestId('hub-project-p2'), { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByTestId('hub-row-menu-rename'));
    const field = screen.getByTestId('hub-rename-p-p2') as HTMLInputElement;
    expect(field.value).toBe('가격 페이지');
    fireEvent.change(field, { target: { value: '가격표' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(props.onRenameProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p2' }),
      '가격표',
    );
  });

  it('creates a session from the project context menu', () => {
    const props = renderTree();
    contextMenu(screen.getByTestId('hub-project-p1'), { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByTestId('hub-row-menu-new-session'));
    expect(props.onNewSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });

  it('confirms before deleting a project and names the project it will delete', () => {
    const props = renderTree();
    contextMenu(screen.getByTestId('hub-project-p2'), { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByTestId('hub-row-menu-delete'));

    const dialog = screen.getByTestId('hub-delete-confirm');
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(dialog.textContent).toContain('가격 페이지');
    expect(props.onDeleteProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('hub-delete-confirm-cta'));
    expect(props.onDeleteProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'p2' }));
  });

  // Non-vacuousness: the confirmation is a real gate, not decoration. Cancel
  // and Escape must both dismiss it having deleted nothing.
  it('deletes nothing when the confirmation is cancelled', () => {
    const props = renderTree();
    const row = screen.getByTestId('hub-project-p2');
    contextMenu(row, { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByTestId('hub-row-menu-delete'));
    fireEvent.click(screen.getByTestId('hub-delete-cancel'));

    expect(screen.queryByTestId('hub-delete-confirm')).toBeNull();
    expect(props.onDeleteProject).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(row);
  });

  it('deletes nothing when the confirmation is dismissed with Escape or the backdrop', () => {
    const props = renderTree();
    contextMenu(screen.getByTestId('hub-project-p2'), { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByTestId('hub-row-menu-delete'));
    fireEvent.keyDown(screen.getByTestId('hub-delete-confirm'), { key: 'Escape' });
    expect(screen.queryByTestId('hub-delete-confirm')).toBeNull();
    expect(props.onDeleteProject).not.toHaveBeenCalled();

    contextMenu(screen.getByTestId('hub-project-p2'), { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByTestId('hub-row-menu-delete'));
    fireEvent.click(screen.getByTestId('hub-delete-confirm-backdrop'));
    expect(screen.queryByTestId('hub-delete-confirm')).toBeNull();
    expect(props.onDeleteProject).not.toHaveBeenCalled();
  });

  it('gives session rows the same context menu, opening the session it targets', () => {
    const props = renderTree();
    contextMenu(screen.getByTestId('hub-session-s2'), { clientX: 60, clientY: 90 });
    const open = screen.getByTestId('hub-row-menu-open');
    expect(open.textContent).toContain(en['hub.inspectorOpen']);
    fireEvent.click(open);
    expect(props.onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 's2' }));
    // Right-clicking a session must not have toggled its parent project.
    expect(screen.getByTestId('hub-project-p1').getAttribute('aria-expanded')).toBe('true');
  });

  // Sessions delete through an undoable optimistic removal upstream, so the
  // modal is deliberately reserved for the unrecoverable project delete.
  it('deletes a session without the project confirmation dialog', () => {
    const props = renderTree();
    contextMenu(screen.getByTestId('hub-session-s1'), { clientX: 60, clientY: 90 });
    fireEvent.click(screen.getByTestId('hub-row-menu-delete'));
    expect(screen.queryByTestId('hub-delete-confirm')).toBeNull();
    expect(props.onDeleteSession).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
    expect(props.onDeleteProject).not.toHaveBeenCalled();
  });

  it('moves between items with the arrow keys and closes on a click outside', () => {
    renderTree();
    contextMenu(screen.getByTestId('hub-project-p1'), { clientX: 40, clientY: 40 });
    const menu = screen.getByTestId('hub-row-menu');
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(items.length).toBeGreaterThan(2);
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[0]);

    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('hub-row-menu')).toBeNull();
  });

  it('takes every label from the locale dictionary, never a literal', () => {
    renderTree();
    contextMenu(screen.getByTestId('hub-project-p1'), { clientX: 40, clientY: 40 });
    const labels = Array.from(
      screen.getByTestId('hub-row-menu').querySelectorAll('.hub-menu__text'),
    ).map((node) => node.textContent);
    expect(labels).toEqual([
      en['quickSwitcher.open'],
      en['common.rename'],
      en['hub.newSession'],
      en['common.delete'],
    ]);
  });

  it('renders every label in the configured locale', () => {
    render(
      <I18nProvider initial="ko">
        <HubSessionTree
          projects={PROJECTS}
          currentSessionId={null}
          onOpenSession={vi.fn()}
          onOpenProject={vi.fn()}
          onNewSession={vi.fn()}
          onRenameProject={vi.fn()}
          onDeleteProject={vi.fn()}
        />
      </I18nProvider>,
    );
    contextMenu(screen.getByTestId('hub-project-p1'), { clientX: 40, clientY: 40 });
    const labels = Array.from(
      screen.getByTestId('hub-row-menu').querySelectorAll('.hub-menu__text'),
    ).map((node) => node.textContent);
    expect(labels).toEqual([
      ko['quickSwitcher.open'],
      ko['common.rename'],
      ko['hub.newSession'],
      ko['common.delete'],
    ]);
    // A Korean UI must not be showing the English strings.
    expect(labels).not.toContain(en['common.delete']);

    fireEvent.click(screen.getByTestId('hub-row-menu-delete'));
    const dialog = screen.getByTestId('hub-delete-confirm');
    expect(dialog.textContent).toContain(ko['designs.deleteTitle']);
    expect(dialog.textContent).toContain(ko['designs.menuDelete']);
  });

  it('drops a menu whose row disappears', () => {
    const { rerender } = render(
      <HubSessionTree
        projects={PROJECTS}
        currentSessionId={null}
        onOpenSession={vi.fn()}
        onDeleteProject={vi.fn()}
      />,
    );
    contextMenu(screen.getByTestId('hub-project-p2'), { clientX: 40, clientY: 40 });
    expect(screen.getByTestId('hub-row-menu')).toBeTruthy();
    rerender(
      <HubSessionTree
        projects={[PROJECTS[0]!]}
        currentSessionId={null}
        onOpenSession={vi.fn()}
        onDeleteProject={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('hub-row-menu')).toBeNull();
  });
});
