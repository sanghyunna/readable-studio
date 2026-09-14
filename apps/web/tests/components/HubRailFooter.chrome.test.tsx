// @vitest-environment jsdom

// Footer chrome contract after the hub-chrome pass:
//  - the profile row is presentational (no button, no focus, no menu),
//  - every capability the old profile menu owned is still reachable,
//  - the settings gear is enlarged in both glyph and hit target.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HubRailFooter } from '../../src/components/hub/HubRailFooter';

afterEach(cleanup);

function renderFooter(overrides: {
  onOpenSettings?: () => void;
  onOpenWorkspaceFolder?: () => void;
  onOpenDestination?: (destination: never) => void;
} = {}) {
  const onOpenSettings = overrides.onOpenSettings ?? vi.fn();
  const onOpenWorkspaceFolder = overrides.onOpenWorkspaceFolder ?? vi.fn();
  const onOpenDestination = overrides.onOpenDestination ?? vi.fn();
  render(
    <HubRailFooter
      username="winuser"
      onOpenDestination={onOpenDestination as never}
      onOpenSettings={onOpenSettings}
      onOpenWorkspaceFolder={onOpenWorkspaceFolder}
      onThemeChange={vi.fn()}
    />,
  );
  return { onOpenSettings, onOpenWorkspaceFolder, onOpenDestination };
}

describe('HubRailFooter profile row is non-interactive', () => {
  it('renders the profile as plain presentation, not a control', () => {
    // Given: the rail footer is on screen.
    renderFooter();

    // When: the profile row is inspected.
    const row = screen.getByTestId('hub-workspace-row');

    // Then: it is not a button and carries no menu wiring at all.
    expect(row.tagName).toBe('DIV');
    expect(row.closest('button')).toBeNull();
    expect(row.querySelector('button')).toBeNull();
    expect(row.getAttribute('role')).toBeNull();
    expect(row.getAttribute('aria-haspopup')).toBeNull();
    expect(row.getAttribute('aria-expanded')).toBeNull();
    expect(row.getAttribute('aria-controls')).toBeNull();
    expect(row.getAttribute('tabindex')).toBeNull();
    expect(row.onclick).toBeNull();
  });

  it('is not reachable by keyboard focus', () => {
    // Given: a footer whose only controls are library and settings.
    renderFooter();
    const row = screen.getByTestId('hub-workspace-row');

    // When: focus is walked through every focusable node in the footer.
    const focusables = within(screen.getByTestId('hub-rail-footer')).queryAllByRole('button');

    // Then: the profile is not among them and cannot take focus.
    expect(focusables.some((node) => node.contains(row))).toBe(false);
    row.focus();
    expect(document.activeElement).not.toBe(row);

    // And: clicking it opens nothing.
    fireEvent.click(row);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('never renders a workspace menu surface', () => {
    // Given: the footer as shipped.
    renderFooter();

    // When: the user clicks the profile row.
    fireEvent.click(screen.getByTestId('hub-workspace-row'));

    // Then: the retired workspace menu and its items are gone.
    expect(screen.queryByTestId('hub-workspace-menu')).toBeNull();
    expect(screen.queryByTestId('hub-workspace-settings')).toBeNull();
  });
});

describe('HubRailFooter capability reachability', () => {
  it('keeps open-workspace-folder reachable from the library menu', () => {
    // Given: the profile menu that used to own this item is gone.
    const { onOpenWorkspaceFolder } = renderFooter();

    // When: the user opens the library menu and picks the workspace folder.
    fireEvent.click(screen.getByTestId('hub-library'));
    const item = screen.getByTestId('hub-workspace-folder');
    expect(within(screen.getByTestId('hub-library-menu')).getByTestId('hub-workspace-folder')).toBe(item);
    fireEvent.click(item);

    // Then: the same handler the retired menu called still fires.
    expect(onOpenWorkspaceFolder).toHaveBeenCalledTimes(1);
  });

  it('keeps settings reachable from the footer gear', () => {
    // Given: the footer gear beside the library button.
    const { onOpenSettings } = renderFooter();

    // When: the user activates it.
    fireEvent.click(screen.getByTestId('hub-footer-settings'));

    // Then: the settings surface opens.
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe('HubRailFooter settings gear sizing', () => {
  it('renders an enlarged glyph inside a labelled control', () => {
    // Given: the footer gear, previously a 17px glyph.
    renderFooter();

    // When: its icon is measured.
    const gear = screen.getByTestId('hub-footer-settings');
    const svg = gear.querySelector('svg');

    // Then: the glyph is larger and the control keeps its accessible name.
    expect(svg?.getAttribute('width')).toBe('21');
    expect(svg?.getAttribute('height')).toBe('21');
    expect(gear.getAttribute('aria-label')).toBe('Settings');
  });
});
