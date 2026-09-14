// @vitest-environment jsdom

/**
 * Rail footer Theme row and its modal.
 *
 * Contract: Theme sits directly above Library, opens a theme modal in ONE
 * click (no settings screen, no submenu, no navigation), the modal is a
 * document.body portal so the rail box can never clip it, theme choices are
 * selectable cards driving the app's appearance handler, and Escape / backdrop
 * / Done close it with focus handed back to the Theme row.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HubRailFooter } from '../../src/components/hub/HubRailFooter';
import { THEME_OPTIONS } from '../../src/state/themes';
import type { AppTheme } from '../../src/types';

afterEach(cleanup);

function renderFooter(initialTheme: AppTheme | undefined = undefined) {
  const onOpenSettings = vi.fn();
  const onOpenDestination = vi.fn();
  const onThemeChange = vi.fn<(theme: AppTheme) => void>();

  // Mirrors the production owner: App holds the theme and hands the footer
  // both the value and its appearance handler. The footer never owns a copy.
  function Host() {
    const [theme, setTheme] = useState<AppTheme | undefined>(initialTheme);
    return (
      <HubRailFooter
        username="winuser"
        onOpenDestination={onOpenDestination}
        onOpenSettings={onOpenSettings}
        onOpenWorkspaceFolder={vi.fn()}
        theme={theme}
        onThemeChange={(next) => {
          onThemeChange(next);
          setTheme(next);
        }}
      />
    );
  }

  render(<Host />);
  return { onOpenSettings, onOpenDestination, onThemeChange };
}

/**
 * A footer whose owner does not re-render on a change. The motion mock
 * (`tests/helpers/motion-mock.tsx`) recreates the animated elements on every
 * render, which throws away the focused DOM node; a static owner keeps the
 * focus assertions about the component, not about the mock.
 */
function renderStaticFooter(theme: AppTheme) {
  const onThemeChange = vi.fn<(theme: AppTheme) => void>();
  render(
    <HubRailFooter
      username="winuser"
      onOpenDestination={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenWorkspaceFolder={vi.fn()}
      theme={theme}
      onThemeChange={onThemeChange}
    />,
  );
  return { onThemeChange };
}

function themeRow(): HTMLButtonElement {
  return screen.getByTestId('hub-theme') as HTMLButtonElement;
}

function openModal(): HTMLElement {
  fireEvent.click(themeRow());
  return screen.getByTestId('hub-theme-modal');
}

describe('HubRailFooter Theme row placement', () => {
  it('stacks Theme directly above Library, with the user profile last', () => {
    // Given: the rail footer as shipped.
    renderFooter();
    const footer = screen.getByTestId('hub-rail-footer');
    const theme = themeRow();
    const library = screen.getByTestId('hub-library');
    const profile = screen.getByTestId('hub-workspace-row');

    // Then: Theme is the first footer row and Library's row is the very next
    // one, so nothing sits between them; the profile follows both.
    expect(footer.firstElementChild).toBe(theme);
    expect(theme.nextElementSibling).toBe(library.closest('.hub__dest-row'));
    expect(theme.compareDocumentPosition(library) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(library.compareDocumentPosition(profile) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(footer.lastElementChild).toBe(profile);

    // And: the footer's controls read Theme, Library, then the settings gear.
    expect(within(footer).getAllByRole('button').map((node) => node.dataset['testid'])).toEqual([
      'hub-theme',
      'hub-library',
      'hub-footer-settings',
    ]);
  });

  it('matches the Library row chrome: same row class, same glyph size, a labelled row', () => {
    // Given: the two stacked footer rows.
    renderFooter();
    const theme = themeRow();
    const library = screen.getByTestId('hub-library');

    // Then: Theme borrows Library's row contract exactly rather than a new one.
    expect(theme.className).toBe(library.className);
    expect(theme.querySelector('svg')?.getAttribute('width')).toBe(
      library.querySelector('svg')?.getAttribute('width'),
    );
    expect(theme.querySelector('span')?.textContent).toBe('Theme');
    expect(theme.getAttribute('aria-haspopup')).toBe('dialog');
    expect(theme.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('HubRailFooter Theme row opens the modal directly', () => {
  it('opens a modal dialog in one click with no intermediate surface', () => {
    // Given: nothing is open.
    const { onOpenSettings, onOpenDestination } = renderFooter();
    expect(screen.queryByRole('dialog')).toBeNull();

    // When: the user clicks Theme once.
    const modal = openModal();

    // Then: the dialog is up, it is modal, and the trigger points at it.
    expect(modal.getAttribute('role')).toBe('dialog');
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(themeRow().getAttribute('aria-expanded')).toBe('true');
    expect(themeRow().getAttribute('aria-controls')).toBe(modal.id);
    expect(screen.getByText('Theme', { selector: 'h2' })).toBeTruthy();

    // And: no menu, no settings surface, no navigation was involved.
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onOpenSettings).not.toHaveBeenCalled();
    expect(onOpenDestination).not.toHaveBeenCalled();
  });

  it('portals the modal to document.body, outside the rail footer box', () => {
    // Given: the footer lives inside the rail's overflow-hidden box.
    renderFooter();
    const footer = screen.getByTestId('hub-rail-footer');

    // When: the modal opens.
    const modal = openModal();
    const backdrop = screen.getByTestId('hub-theme-backdrop');

    // Then: the backdrop is a direct child of the body, never of the rail, so
    // no rail state (44px strip included) can clip it.
    expect(backdrop.parentElement).toBe(document.body);
    expect(backdrop.contains(modal)).toBe(true);
    expect(footer.contains(modal)).toBe(false);
    expect(modal.closest('[data-testid="hub-rail-footer"]')).toBeNull();
    expect(backdrop.classList.contains('modal-backdrop')).toBe(true);
    expect(modal.classList.contains('modal')).toBe(true);
  });

  it('moves focus onto the current theme card when it opens', () => {
    // Given: dark is the active theme.
    renderFooter('dark');

    // When: the modal opens.
    openModal();

    // Then: focus lands on the selected card, ready for arrow keys.
    expect(document.activeElement).toBe(screen.getByTestId('hub-theme-option-dark'));
  });
});

describe('HubRailFooter theme choices', () => {
  it('presents every theme as a selectable card, never a checkbox or select', () => {
    // Given: the modal is open.
    renderFooter('light');
    const modal = openModal();
    const group = within(modal).getByRole('radiogroup');

    // Then: one card per theme, in the catalogue order, marked as radios.
    const cards = within(group).getAllByRole('radio');
    expect(cards.map((card) => card.dataset['themeOption'])).toEqual(THEME_OPTIONS.map((option) => option.id));
    expect(cards.every((card) => card.tagName === 'BUTTON')).toBe(true);
    expect(cards.filter((card) => card.getAttribute('aria-checked') === 'true').map((card) => card.dataset['themeOption'])).toEqual(['light']);

    // And: no checkbox UI and no native select anywhere in the dialog.
    expect(modal.querySelector('input')).toBeNull();
    expect(modal.querySelector('select')).toBeNull();
    expect(modal.querySelector('[role="checkbox"], [role="menuitemcheckbox"]')).toBeNull();
  });

  it('hands a selected theme to the appearance handler and reflects the new value', () => {
    // Given: light is active and the modal is open.
    const { onThemeChange } = renderFooter('light');
    openModal();

    // When: the user picks Dracula.
    fireEvent.click(screen.getByTestId('hub-theme-option-dracula'));

    // Then: the owner's handler receives exactly that theme, once; the modal
    // stays open so the user can keep comparing, and the selection follows
    // the value the owner now holds - the footer keeps no copy of its own.
    expect(onThemeChange).toHaveBeenCalledTimes(1);
    expect(onThemeChange).toHaveBeenCalledWith('dracula');
    expect(screen.getByTestId('hub-theme-modal')).toBeTruthy();
    expect(screen.getByTestId('hub-theme-option-dracula').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('hub-theme-option-light').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('hub-theme-option-dracula').tabIndex).toBe(0);
    expect(screen.getByTestId('hub-theme-option-light').tabIndex).toBe(-1);

    // And: re-selecting the active card is not a change.
    fireEvent.click(screen.getByTestId('hub-theme-option-dracula'));
    expect(onThemeChange).toHaveBeenCalledTimes(1);
  });

  it('moves selection and focus with the arrow keys', () => {
    // Given: light (index 1) is active and focused.
    const { onThemeChange } = renderStaticFooter('light');
    openModal();
    const light = screen.getByTestId('hub-theme-option-light');
    expect(document.activeElement).toBe(light);

    // When: the user presses ArrowRight.
    fireEvent.keyDown(light, { key: 'ArrowRight' });

    // Then: the next theme in the catalogue is selected and focused.
    expect(onThemeChange).toHaveBeenLastCalledWith('dark');
    expect(document.activeElement).toBe(screen.getByTestId('hub-theme-option-dark'));

    // When: End jumps to the last card.
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    const last = THEME_OPTIONS[THEME_OPTIONS.length - 1]!.id;
    expect(onThemeChange).toHaveBeenLastCalledWith(last);
    expect(document.activeElement).toBe(screen.getByTestId(`hub-theme-option-${last}`));
  });
});

describe('HubRailFooter theme modal dismissal', () => {
  it('closes on Escape and returns focus to the Theme row', () => {
    // Given: the modal is open with focus inside it.
    renderFooter();
    openModal();
    expect(themeRow().contains(document.activeElement)).toBe(false);

    // When: Escape is pressed.
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    // Then: the dialog is gone and the Theme row has focus again.
    expect(screen.queryByTestId('hub-theme-modal')).toBeNull();
    expect(document.activeElement).toBe(themeRow());
    expect(themeRow().getAttribute('aria-expanded')).toBe('false');
    expect(themeRow().getAttribute('aria-controls')).toBeNull();
  });

  it('closes on a backdrop press and returns focus to the Theme row', () => {
    // Given: the modal is open.
    renderFooter();
    const modal = openModal();

    // When: the user presses inside the dialog itself.
    fireEvent.mouseDown(modal, { clientY: 320 });

    // Then: nothing happens - only the scrim dismisses.
    expect(screen.getByTestId('hub-theme-modal')).toBeTruthy();

    // When: the user presses the scrim (below the shared backdrop's desktop
    // window-drag strip, which is reserved for moving the window).
    fireEvent.mouseDown(screen.getByTestId('hub-theme-backdrop'), { clientY: 320 });

    // Then: the dialog is gone and the Theme row has focus again.
    expect(screen.queryByTestId('hub-theme-modal')).toBeNull();
    expect(document.activeElement).toBe(themeRow());
  });

  it.each(['hub-theme-close', 'hub-theme-done'] as const)('closes from %s and returns focus to the Theme row', (control) => {
    // Given: the modal is open.
    renderFooter();
    openModal();

    // When: the user activates the close control.
    fireEvent.click(screen.getByTestId(control));

    // Then: the dialog is gone and the Theme row has focus again.
    expect(screen.queryByTestId('hub-theme-modal')).toBeNull();
    expect(document.activeElement).toBe(themeRow());
  });

  it('keeps Tab inside the dialog while it is open', () => {
    // Given: the modal is open; its tab stops are close, the active card, Done.
    renderFooter('light');
    const modal = openModal();
    const close = screen.getByTestId('hub-theme-close');
    const done = screen.getByTestId('hub-theme-done');

    // When: Tab is pressed on the last stop.
    done.focus();
    fireEvent.keyDown(done, { key: 'Tab' });

    // Then: focus wraps to the first stop.
    expect(document.activeElement).toBe(close);

    // When: Shift+Tab is pressed on the first stop.
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });

    // Then: focus wraps back to the last stop.
    expect(document.activeElement).toBe(done);

    // And: focus moved outside by another control is pulled back in.
    screen.getByTestId('hub-library').focus();
    expect(modal.contains(document.activeElement)).toBe(true);
  });
});
