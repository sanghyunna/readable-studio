// @vitest-environment jsdom

// The two session-row actions (peek + row menu) sit right after the session
// title. They were clickable but invisible: `.hub-row__action` is a 22px
// border-box square that inherited the global `button` padding (6px 12px), so
// the 14px icon had zero content width to paint in. These tests pin the
// contract that each control renders an accessible name, carries a real icon,
// and that the stylesheet zeroes the padding so the icon has room.

import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HubSessionTree } from '../../src/components/hub/HubSessionTree';
import type { HubFolderNode } from '../../src/components/hub/types';

const hubCss = readFileSync(resolve(process.cwd(), 'src/styles/home/hub.css'), 'utf8');

function declarations(selector: string): string {
  const withoutComments = hubCss.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (selectors.includes(selector)) return match[2] ?? '';
  }
  throw new Error(`Missing CSS block for ${selector}`);
}

afterEach(() => {
  cleanup();
});

const SESSION_TITLE = '차트 팔레트 정리';
const PROJECTS: HubFolderNode[] = [
  {
    id: 'p1',
    name: '분기 보고서',
    updatedAt: 900,
    sessions: [{ id: 's1', workspaceId: 'p1', folderId: 'p1', workspaceSessionCount: 1, title: SESSION_TITLE, updatedAt: 900, state: 'idle' }],
  },
];

function renderTree() {
  const props = {
    tree: { folders: PROJECTS, recents: [] },
    currentSessionId: 's1',
    onOpenSession: vi.fn(),
    onPeekSession: vi.fn(),
    onNewSession: vi.fn(),
    onRenameFolder: vi.fn(),
    onDeleteFolder: vi.fn(),
    onRenameSession: vi.fn(),
    onDeleteSession: vi.fn(),
  };
  render(<HubSessionTree {...props} />);
  return props;
}

function expectPaintableIconButton(button: HTMLElement): void {
  expect(button.tagName).toBe('BUTTON');
  expect(button.className).toContain('hub-row__action');
  const name = button.getAttribute('aria-label') ?? '';
  expect(name.length).toBeGreaterThan(0);
  expect(name).toContain(SESSION_TITLE);
  const icon = button.querySelector('svg');
  expect(icon).not.toBeNull();
  expect(Number(icon?.getAttribute('width'))).toBeGreaterThan(0);
  expect(Number(icon?.getAttribute('height'))).toBeGreaterThan(0);
  // Without this the 22px border-box square has no content width for the icon.
  expect(declarations('.hub-row__action')).toContain('padding: 0;');
  expect(declarations('.hub-row__action')).toContain('width: 22px;');
}

describe('HubSessionTree row action visibility', () => {
  it('exposes current-session actions without hover or keyboard focus', () => {
    // jsdom does not evaluate hover media features. Exercise the actual base
    // and reveal rules outside that touch-device fallback.
    const style = document.createElement('style');
    style.textContent = hubCss.slice(hubCss.indexOf('.hub-row__action {'), hubCss.indexOf('@media (hover: none)'));
    document.head.append(style);
    try {
      renderTree();
      const row = screen.getByTestId('hub-session-s1');
      expect(row.getAttribute('aria-current')).toBe('true');
      expect(row.contains(document.activeElement)).toBe(false);
      for (const id of ['hub-peek-s1', 'hub-menu-session-s1']) {
        const computed = getComputedStyle(screen.getByTestId(id));
        expect(computed.opacity).toBe('1');
        expect(computed.pointerEvents).toBe('auto');
      }
    } finally {
      style.remove();
    }
  });

  it('renders the session peek control as a named, paintable icon button', () => {
    renderTree();
    expectPaintableIconButton(screen.getByTestId('hub-peek-s1'));
  });

  it('renders the session row menu control as a named, paintable icon button', () => {
    renderTree();
    const menu = screen.getByTestId('hub-menu-session-s1');
    expectPaintableIconButton(menu);
    expect(menu.getAttribute('aria-haspopup')).toBe('menu');
  });
});
