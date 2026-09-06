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

  it('exposes sort choices as an exclusive radio group without selection glyphs', () => {
    // Given: the recent sort is active by default.
    render(<HubSessionTree projects={[MANY, OTHER]} currentSessionId={null} onOpenSession={vi.fn()} />);

    // When: the sort menu opens.
    fireEvent.click(screen.getByTestId('hub-sort'));

    // Then: exactly one radio choice is selected and tone replaces the old glyph.
    const choices = screen.getAllByRole('menuitemradio');
    expect(choices).toHaveLength(2);
    expect(choices.map((choice) => choice.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(screen.getByTestId('hub-sort-menu').querySelector('.hub-menu__check')).toBeNull();
    expect(choices[0]?.style.background).toBe('var(--selected-soft)');
  });

  it('sorts projects by name through the single sort control', () => {
    render(<HubSessionTree projects={[MANY, OTHER]} currentSessionId={null} onOpenSession={vi.fn()} />);
    // One control, not one pill per order: opening it reveals both orders.
    expect(screen.getAllByTestId(/^hub-sort$/)).toHaveLength(1);
    fireEvent.click(screen.getByTestId('hub-sort'));
    fireEvent.click(screen.getByTestId('hub-sort-menu-name'));
    const order = screen.getAllByTestId(/^hub-project-/).map((el) => el.getAttribute('data-project-id'));
    expect(order).toEqual(['p2', 'p1']);
  });

  it('exposes collapsed-project sessions as exclusive radio choices', () => {
    // Given: one session is the current destination in a collapsed rail.
    render(
      <HubSessionTree
        projects={[MANY]}
        collapsed
        currentSessionId="s1"
        onOpenSession={vi.fn()}
      />,
    );

    // When: the project session menu opens.
    fireEvent.click(screen.getByTestId('hub-project-p1'));

    // Then: every session is a radio item and only the current one is selected.
    const choices = screen.getAllByRole('menuitemradio');
    expect(choices).toHaveLength(MANY.sessions.length);
    expect(choices.filter((choice) => choice.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    expect(screen.getByTestId('hub-project-flyout-s1').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('hub-project-flyout').querySelector('.hub-menu__check')).toBeNull();
  });

  it('exposes full project and session names through the portal tooltip contract', () => {
    // Given: the tree contains names that may exceed the rail width.
    render(<HubSessionTree projects={[MANY]} currentSessionId={null} onOpenSession={vi.fn()} />);

    // When: the project and nested session rows render.
    const projectRow = screen.getByTestId('hub-project-p1');
    const sessionRow = screen.getByTestId('hub-session-s0');

    // Then: TooltipLayer can reveal the full names without native title popups.
    expect(projectRow.classList.contains('readable-tooltip')).toBe(true);
    expect(projectRow.getAttribute('data-tooltip')).toBe(MANY.name);
    expect(projectRow.hasAttribute('title')).toBe(false);
    expect(sessionRow.classList.contains('readable-tooltip')).toBe(true);
    expect(sessionRow.getAttribute('data-tooltip')).toBe(MANY.sessions[0]?.title);
    expect(sessionRow.hasAttribute('title')).toBe(false);
  });

  it('opens a compact-default closed project on its first click without replacing the row', () => {
    render(
      <HubSessionTree
        projects={[MANY, OTHER]}
        compactByDefault
        currentSessionId={null}
        onOpenSession={vi.fn()}
      />,
    );
    const row = screen.getByTestId('hub-project-p2');
    expect(row.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(row);

    expect(screen.getByTestId('hub-project-p2')).toBe(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
  });

  it('expands an unloaded compact project instead of navigating from its disclosure row', () => {
    const onOpenProject = vi.fn();
    render(
      <HubSessionTree
        projects={[MANY, node({ id: 'loading', sessionsStatus: 'loading' })]}
        compactByDefault
        currentSessionId={null}
        onOpenSession={vi.fn()}
        onOpenProject={onOpenProject}
      />,
    );
    const row = screen.getByTestId('hub-project-loading');
    expect(row.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(row);

    expect(screen.getByTestId('hub-project-loading')).toBe(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(onOpenProject).not.toHaveBeenCalled();
    expect(screen.getByTestId('hub-new-terminal-loading')).toBeTruthy();
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
