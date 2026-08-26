// @vitest-environment jsdom

// ARIA tree ownership: a project's group of sessions must be a DESCENDANT of
// the project treeitem, not a sibling, or assistive tech cannot infer which
// project owns which sessions. Activating "show more" must also keep focus
// inside the tree instead of dropping it to the body.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HubSessionTree } from '../../src/components/hub/HubSessionTree';
import type { HubProjectNode } from '../../src/components/hub/types';

afterEach(() => {
  cleanup();
});

const MANY: HubProjectNode = {
  id: 'p1',
  name: '분기 보고서',
  updatedAt: 900,
  sessions: Array.from({ length: 8 }, (_, i) => ({
    id: `s${i}`,
    projectId: 'p1',
    title: `세션 ${i}`,
    updatedAt: 900 - i,
    state: 'idle' as const,
  })),
};

describe('HubSessionTree ownership and focus', () => {
  it('nests each session group inside its owning treeitem', () => {
    render(<HubSessionTree projects={[MANY]} currentSessionId={null} onOpenSession={vi.fn()} />);
    const project = screen.getByTestId('hub-project-p1');
    const group = project.querySelector('[role="group"]');
    expect(group).not.toBeNull();
    expect(project.contains(group!)).toBe(true);
    expect(group!.querySelectorAll('[role="treeitem"]').length).toBeGreaterThan(0);
  });

  it('keeps status readable to assistive tech instead of overriding it', () => {
    render(
      <HubSessionTree
        projects={[
          {
            ...MANY,
            sessions: [
              { id: 'sx', projectId: 'p1', title: '차트', updatedAt: 1, state: 'failed' as const },
            ],
          },
        ]}
        currentSessionId={null}
        onOpenSession={vi.fn()}
      />,
    );
    const row = screen.getByTestId('hub-session-sx');
    // An aria-label would silence the visible status text; describedby keeps it.
    expect(row.getAttribute('aria-label')).toBeNull();
    const describedBy = row.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBeTruthy();
  });

  it('restores focus into the tree after revealing hidden sessions', () => {
    render(<HubSessionTree projects={[MANY]} currentSessionId={null} onOpenSession={vi.fn()} />);
    const more = screen.getByTestId('hub-tree-more-p1');
    more.focus();
    fireEvent.keyDown(more, { key: 'Enter' });
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.getAttribute('role')).toBe('treeitem');
  });
});
