// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HubSessionTree } from '../../src/components/hub/HubSessionTree';
import type { HubProjectNode } from '../../src/components/hub/types';

afterEach(() => {
  cleanup();
});

function node(overrides: Partial<HubProjectNode> & { id: string }): HubProjectNode {
  return {
    name: overrides.id,
    updatedAt: 1,
    sessions: [],
    ...overrides,
  };
}

const MANY = node({
  id: 'p1',
  name: '분기 보고서',
  updatedAt: 900,
  sessions: Array.from({ length: 8 }, (_, i) => ({
    id: `s${i}`,
    projectId: 'p1',
    title: `세션 ${i}`,
    updatedAt: 900 - i,
    state: i === 0 ? ('running' as const) : i === 1 ? ('awaiting' as const) : ('idle' as const),
  })),
});

const OTHER = node({
  id: 'p2',
  name: '가격 페이지',
  updatedAt: 100,
  sessions: [
    { id: 's-other', projectId: 'p2', title: '요금제 비교표', updatedAt: 100, state: 'failed' as const },
  ],
});

describe('HubSessionTree', () => {
  it('caps visible sessions and reveals the rest on demand', () => {
    render(<HubSessionTree projects={[MANY]} currentSessionId={null} onOpenSession={vi.fn()} />);
    const sessionRows = () =>
      screen.getByTestId('hub-project-p1').querySelectorAll('[data-testid^="hub-session-"]');
    const overflowRow = () =>
      screen.getByTestId('hub-project-p1').querySelectorAll('[data-testid^="hub-tree-more-"]');
    // 5 sessions plus the overflow row before, all 8 after.
    expect(sessionRows()).toHaveLength(5);
    expect(overflowRow()).toHaveLength(1);
    fireEvent.click(screen.getByTestId('hub-tree-more-p1'));
    expect(sessionRows()).toHaveLength(8);
    expect(overflowRow()).toHaveLength(0);
  });

  it('filters to attention rows without duplicating them', () => {
    render(<HubSessionTree projects={[MANY, OTHER]} currentSessionId={null} onOpenSession={vi.fn()} />);
    fireEvent.click(screen.getByTestId('hub-filter-attention'));
    const titles = screen
      .getAllByTestId(/^hub-session-/)
      .map((el) => el.getAttribute('data-session-id'));
    expect(titles).toEqual(['s1', 's-other']);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('sorts projects by name when asked', () => {
    render(<HubSessionTree projects={[MANY, OTHER]} currentSessionId={null} onOpenSession={vi.fn()} />);
    fireEvent.click(screen.getByTestId('hub-sort-name'));
    const order = screen.getAllByTestId(/^hub-project-/).map((el) => el.getAttribute('data-project-id'));
    expect(order).toEqual(['p2', 'p1']);
  });

  it('opens a session on click without an intermediate view', () => {
    const onOpenSession = vi.fn();
    render(<HubSessionTree projects={[MANY]} currentSessionId={null} onOpenSession={onOpenSession} />);
    fireEvent.click(screen.getByTestId('hub-session-s0'));
    expect(onOpenSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's0', projectId: 'p1' }),
    );
  });
});
