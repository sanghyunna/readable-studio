// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HubSessionTree } from '../../src/components/hub/HubSessionTree';

const css = readFileSync(resolve(process.cwd(), 'src/styles/home/hub.css'), 'utf8');
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`).exec(css);
  if (!match) throw new Error(`Missing rule: ${selector}`);
  return `${selector} { ${match[1]} }`;
}
function applyRules(...selectors: string[]) {
  const style = document.createElement('style');
  style.textContent = selectors.map(rule).join('\n');
  document.head.append(style);
  return style;
}
afterEach(() => {
  cleanup();
  document.head.querySelectorAll('style').forEach((style) => style.remove());
  document.body.replaceChildren();
});

describe('Hub rail layout and disclosure contract', () => {
  it('assigns the flexible track to the tree, not the divider', () => {
    applyRules('.hub__nav');
    const nav = document.createElement('nav');
    nav.className = 'hub__nav';
    for (const name of ['head', 'actions', 'divider', 'list', 'foot']) {
      const child = document.createElement('div');
      child.dataset.slot = name;
      nav.append(child);
    }
    document.body.append(nav);
    expect(getComputedStyle(nav).gridTemplateRows).toBe('auto auto auto minmax(0, 1fr) auto');
    expect(nav.children[3]?.getAttribute('data-slot')).toBe('list');
  });

  it('packs optional tree rows at the top instead of stretching them', () => {
    applyRules('.hub-tree');
    const tree = document.createElement('div');
    tree.className = 'hub-tree';
    document.body.append(tree);
    expect(getComputedStyle(tree).alignContent).toBe('start');
    expect(getComputedStyle(tree).gridAutoRows).toBe('auto');
    expect(getComputedStyle(tree).gridTemplateRows).toBe('none');
  });

  it('keeps section actions visible and pointer-active without row hover', () => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    render(<HubSessionTree tree={{ folders: [], recents: [] }} currentSessionId={null} onOpenSession={vi.fn()} onCreateFolder={vi.fn()} />);
    const button = screen.getByTestId('hub-folder-create');
    expect(getComputedStyle(button).opacity).toBe('1');
    expect(getComputedStyle(button).pointerEvents).toBe('auto');
  });

  it('keeps the chevron and rendered session visibility in sync with disclosure', () => {
    applyRules('.hub-row__chevron', ".hub-row__chevron[data-open='true']", ".hub-tree__group[data-open='false']");
    render(<HubSessionTree
      tree={{ folders: [{ id: 'folder', name: 'Folder', updatedAt: 1, sessions: [{ id: 'session', workspaceId: 'workspace', folderId: 'folder', workspaceSessionCount: 1, title: 'Session', updatedAt: 1, state: 'idle' }] }], recents: [] }}
      compactByDefault currentSessionId={null} onOpenSession={vi.fn()}
    />);
    const folder = screen.getByTestId('hub-project-folder');
    const chevron = folder.querySelector<HTMLElement>('.hub-row__chevron')!;
    const group = folder.querySelector<HTMLElement>('[role="group"]')!;
    expect(folder.getAttribute('aria-expanded')).toBe('true');
    expect(group.hidden).toBe(false);
    expect(getComputedStyle(chevron).transform).toBe('rotate(45deg) scale(0.6)');
    fireEvent.click(folder);
    expect(folder.getAttribute('aria-expanded')).toBe('false');
    expect(group.hidden).toBe(true);
    expect(getComputedStyle(group).display).toBe('none');
    expect(getComputedStyle(chevron).transform).toBe('rotate(-45deg) scale(0.6)');
    fireEvent.click(folder);
    expect(folder.getAttribute('aria-expanded')).toBe('true');
    expect(group.hidden).toBe(false);
    expect(getComputedStyle(chevron).transform).toBe('rotate(45deg) scale(0.6)');
  });
});
