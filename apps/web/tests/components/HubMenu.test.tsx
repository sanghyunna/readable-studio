// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HubMenu, type HubMenuItem } from '../../src/components/hub/HubMenu';

afterEach(() => {
  cleanup();
});

const ITEMS = [
  { kind: 'action', id: 'rename', label: 'Rename', onSelect: vi.fn() },
  { kind: 'radio', id: 'recent', label: 'Recent', checked: true, onSelect: vi.fn() },
  {
    kind: 'toggle',
    id: 'preview',
    label: 'Preview',
    checked: false,
    onLabel: 'On',
    offLabel: 'Off',
    onSelect: vi.fn(),
  },
] satisfies readonly HubMenuItem[];

function MenuFixture({ items = ITEMS }: { readonly items?: readonly HubMenuItem[] }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={setAnchor} type="button">
        Open
      </button>
      <HubMenu title="Options" items={items} anchor={anchor} onClose={vi.fn()} testId="menu" />
    </>
  );
}

describe('HubMenu semantics', () => {
  it('renders action, exclusive choice, and independent toggle with only their valid ARIA states', () => {
    // Given / When: a menu contains each supported item kind.
    render(<MenuFixture />);

    // Then: each kind exposes its matching role and visible state treatment.
    const action = screen.getByRole('menuitem', { name: 'Rename' });
    const radio = screen.getByRole('menuitemradio', { name: 'Recent' });
    const toggle = screen.getByRole('menuitemcheckbox', { name: 'Preview Off' });
    expect(action.getAttribute('aria-checked')).toBeNull();
    expect(radio.getAttribute('aria-checked')).toBe('true');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.textContent).toContain('Off');
    expect(radio.style.background).toBe('var(--selected-soft)');
    expect(radio.style.color).toBe('var(--selected)');
    expect(screen.getByTestId('menu').querySelector('.hub-menu__check')).toBeNull();
  });

  it.each([
    ['ArrowDown', 'menu-rename', 'menu-recent'],
    ['ArrowUp', 'menu-preview', 'menu-recent'],
    ['Home', 'menu-preview', 'menu-rename'],
    ['End', 'menu-rename', 'menu-preview'],
  ] as const)('moves mixed-role focus with %s', (key, startId, targetId) => {
    // Given: focus starts on a menu item of any supported role.
    render(<MenuFixture />);
    const start = screen.getByTestId(startId);
    start.focus();

    // When: one navigation key is pressed.
    fireEvent.keyDown(start, { key });

    // Then: focus reaches the expected item regardless of its role.
    expect(document.activeElement).toBe(screen.getByTestId(targetId));
  });

  it('portals the menu and focuses its first item after placement', () => {
    // Given / When: the anchored menu is rendered and placed.
    render(<MenuFixture />);
    const menu = screen.getByTestId('menu');

    // Then: the portal is body-owned and focus enters its first action.
    expect(menu.parentElement).toBe(document.body);
    expect(document.activeElement).toBe(screen.getByTestId('menu-rename'));
  });

  it('moves focus to a mixed-role match with printable-key typeahead', () => {
    // Given: focus starts on the first menu action.
    render(<MenuFixture />);
    const action = screen.getByRole('menuitem', { name: 'Rename' });
    action.focus();

    // When: the first printable character of the toggle label is pressed.
    fireEvent.keyDown(action, { key: 'p' });

    // Then: focus reaches the matching checkbox-role menu item.
    expect(document.activeElement).toBe(
      screen.getByRole('menuitemcheckbox', { name: 'Preview Off' }),
    );
  });
});
