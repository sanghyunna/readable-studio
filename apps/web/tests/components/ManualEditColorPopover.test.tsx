// @vitest-environment jsdom

// The left inspector clips its children twice (`.root` overflow: hidden and
// `.scroll` overflow-y: auto), which cut every in-flow colour popover off at
// the panel edge. These tests pin the fix: every colour swatch in the panel
// opens ONE shared popover that mounts on document.body (outside both
// clipping boxes), enters focus, closes on Escape with focus returned to the
// swatch, and closes on an outside mousedown.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ManualEditLeftInspector } from '../../src/components/ManualEditLeftInspector';
import { MANUAL_EDIT_COLOR_POPOVER_TESTID } from '../../src/components/ManualEditColorPopover';
import popoverStyles from '../../src/components/ManualEditColorPopover.module.css';
import type { ManualEditRichFormatState } from '../../src/components/ManualEditTextControls';
import { emptyManualEditStyles, type ManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import type { SystemFontFamily } from '@readable-studio/contracts';
import { collectCssHardcodedColorMatches } from '../../../../scripts/style-policy';

vi.mock('../../src/components/useSystemFonts', () => ({
  useSystemFonts: () => ({ families: [] as SystemFontFamily[], loading: false }),
}));

const inspectorCss = readFileSync('src/components/ManualEditLeftInspector.module.css', 'utf8');
const popoverCss = readFileSync('src/components/ManualEditColorPopover.module.css', 'utf8');

const idleFormat: ManualEditRichFormatState = {
  editing: false, hasSelection: false, bold: false, italic: false, underline: false,
};

function target(overrides: Partial<ManualEditTarget> = {}): ManualEditTarget {
  return {
    id: 'hero',
    kind: 'container',
    label: 'Hero box',
    tagName: 'section',
    className: '',
    text: '',
    rect: { x: 0, y: 0, width: 120, height: 80 },
    fields: {},
    attributes: {},
    styles: emptyManualEditStyles(),
    isLayoutContainer: false,
    outerHtml: '<section></section>',
    ...overrides,
  };
}

function renderInspector(selected: ManualEditTarget | null) {
  const onStyleField = vi.fn<(key: keyof ManualEditStyles, value: string) => void>();
  const onPageStyleChange = vi.fn();
  const utils = render(
    <ManualEditLeftInspector
      target={selected}
      styles={{ ...emptyManualEditStyles(), color: '#111111', backgroundColor: '#ef4444', borderColor: '#222222' }}
      richFormat={idleFormat}
      draftAlt=""
      error={null}
      busy={false}
      canUndo
      canRedo
      pageStylesEnabled
      onStyleField={onStyleField}
      onRichFormat={vi.fn()}
      onApplyPatch={vi.fn()}
      onError={vi.fn()}
      onUndo={vi.fn()}
      onRedo={vi.fn()}
      onPageStyleChange={onPageStyleChange}
    />,
  );
  return { ...utils, onStyleField, onPageStyleChange };
}

const POPOVER_SELECTOR = `[data-testid="${MANUAL_EDIT_COLOR_POPOVER_TESTID}"]`;
const POPOVER_CLASS = popoverStyles.popover as string;
const OPEN_CLASS = popoverStyles.popoverOpen as string;

/** The one popover carrying the open class (every owner keeps its node mounted). */
function popover(): HTMLElement | null {
  const open = [...document.querySelectorAll<HTMLElement>(POPOVER_SELECTOR)]
    .filter((node) => node.classList.contains(POPOVER_CLASS) && node.classList.contains(OPEN_CLASS));
  if (open.length > 1) throw new Error(`${open.length} colour popovers are open at once`);
  return open[0] ?? null;
}

/** Closed = still mounted (so the exit transition runs), class off, inert. */
function expectClosedButMounted(node: HTMLElement) {
  expect(node.isConnected).toBe(true);
  expect(node.classList.contains(POPOVER_CLASS)).toBe(true);
  expect(node.classList.contains(OPEN_CLASS)).toBe(false);
  expect(node.hasAttribute('inert')).toBe(true);
  expect(node.getAttribute('aria-hidden')).toBe('true');
}

/** Opens the swatch from a keyboard/click focus state and returns the popover. */
function openFrom(swatch: HTMLElement): HTMLElement {
  act(() => { swatch.focus(); });
  fireEvent.click(swatch);
  const node = popover();
  if (!node) throw new Error(`popover did not open for ${swatch.getAttribute('aria-label')}`);
  return node;
}

function expectPortaledOutsidePanel(node: HTMLElement) {
  const panel = document.querySelector('.manual-edit-left-inspector');
  if (!panel) throw new Error('inspector panel not rendered');
  expect(node.parentElement).toBe(document.body);
  expect(panel.contains(node)).toBe(false);
}

function exerciseSwatch(swatch: HTMLElement) {
  const node = openFrom(swatch);
  expectPortaledOutsidePanel(node);
  expect(swatch.getAttribute('aria-expanded')).toBe('true');
  // Focus enters the popover on open (first swatch tile).
  expect(node.contains(document.activeElement)).toBe(true);

  // Escape closes and returns focus to the trigger.
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  expect(popover()).toBeNull();
  expectClosedButMounted(node);
  expect(document.activeElement).toBe(swatch);
  expect(swatch.getAttribute('aria-expanded')).toBe('false');

  // Outside mousedown dismisses.
  openFrom(swatch);
  expect(node.hasAttribute('inert')).toBe(false);
  fireEvent.mouseDown(document.body);
  expect(popover()).toBeNull();
  expectClosedButMounted(node);

  // A mousedown inside the popover does not dismiss it (it is not a
  // descendant of the trigger any more, so containment must include the portal).
  const reopened = openFrom(swatch);
  fireEvent.mouseDown(reopened.querySelector('button')!);
  expect(popover()).not.toBeNull();
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(popover()).toBeNull();
}

afterEach(cleanup);

describe('ManualEditColorPopover in the left inspector', () => {
  it('text colour (quick-format panel) escapes the panel and keeps keyboard access', () => {
    const { onStyleField } = renderInspector(target({ kind: 'text', label: 'Title' }));
    const swatch = screen.getByRole('button', { name: 'Text color' });
    exerciseSwatch(swatch);
    // Picking a tile patches the element and closes the popover.
    const node = openFrom(swatch);
    fireEvent.click(node.querySelector('button[aria-label="#3b82f6"]')!);
    expect(onStyleField).toHaveBeenLastCalledWith('color', '#3b82f6');
    expect(popover()).toBeNull();
    expectClosedButMounted(node);
    expect(document.activeElement).toBe(swatch);
  });

  it('a pressed tile applies the colour and closes the picker for every inspector owner', () => {
    const { onStyleField } = renderInspector(target({ kind: 'container' }));
    fireEvent.click(screen.getByRole('button', { name: /Appearance/ }));
    const owners: ReadonlyArray<[string, keyof ManualEditStyles]> = [
      ['Fill', 'backgroundColor'],
      ['Border color', 'borderColor'],
      ['Pick Fill', 'backgroundColor'],
      ['Pick Border color', 'borderColor'],
    ];
    for (const [name, key] of owners) {
      const swatch = screen.getByRole('button', { name });
      const node = openFrom(swatch);
      const tile = node.querySelector<HTMLElement>('button[aria-label="#3b82f6"]')!;
      // Real pointer sequence: the press must not dismiss before the click lands.
      fireEvent.mouseDown(tile);
      expect(popover(), `${name}: press inside the picker dismissed it`).toBe(node);
      fireEvent.mouseUp(tile);
      fireEvent.click(tile);
      expect(onStyleField, name).toHaveBeenLastCalledWith(key, '#3b82f6');
      expect(popover()).toBeNull();
      expectClosedButMounted(node);
    }
    cleanup();

    const { onPageStyleChange } = renderInspector(null);
    const bg = openFrom(screen.getByRole('button', { name: 'Pick Background' }));
    const tile = bg.querySelector<HTMLElement>('button[aria-label="#3b82f6"]')!;
    fireEvent.mouseDown(tile);
    expect(popover()).toBe(bg);
    fireEvent.mouseUp(tile);
    fireEvent.click(tile);
    expect(onPageStyleChange).toHaveBeenLastCalledWith('__body__', { backgroundColor: '#3b82f6' }, 'Page styles');
    expect(popover()).toBeNull();
    expectClosedButMounted(bg);
  });

  it('fill and border colour (quick-shape panel and Appearance section) escape the panel', () => {
    renderInspector(target({ kind: 'container' }));
    exerciseSwatch(screen.getByRole('button', { name: 'Fill' }));
    exerciseSwatch(screen.getByRole('button', { name: 'Border color' }));
    fireEvent.click(screen.getByRole('button', { name: /Appearance/ }));
    exerciseSwatch(screen.getByRole('button', { name: 'Pick Fill' }));
    exerciseSwatch(screen.getByRole('button', { name: 'Pick Border color' }));
  });

  it('page background / text colour (Page section) escape the panel', () => {
    renderInspector(null);
    exerciseSwatch(screen.getByRole('button', { name: 'Pick Background' }));
  });

  it('only one popover is open at a time across swatches (pointer activation)', () => {
    renderInspector(target({ kind: 'container' }));
    const fill = screen.getByRole('button', { name: 'Fill' });
    const first = openFrom(fill);
    // Opening a second swatch counts as an outside mousedown for the first.
    const border = screen.getByRole('button', { name: 'Border color' });
    fireEvent.mouseDown(border);
    fireEvent.click(border);
    expect(popover()).not.toBe(first);
    expect(fill.getAttribute('aria-expanded')).toBe('false');
    expect(border.getAttribute('aria-expanded')).toBe('true');
  });

  it('keyboard/focus activation of a second trigger closes the first (no mousedown)', () => {
    renderInspector(target({ kind: 'container' }));
    fireEvent.click(screen.getByRole('button', { name: /Appearance/ }));
    const fill = screen.getByRole('button', { name: 'Pick Fill' });
    const border = screen.getByRole('button', { name: 'Pick Border color' });
    const first = openFrom(fill);
    // Enter/Space on a focused button dispatches click without any mousedown.
    const second = openFrom(border);
    expect(second).not.toBe(first);
    expectClosedButMounted(first);
    expect(fill.getAttribute('aria-expanded')).toBe('false');
    expect(border.getAttribute('aria-expanded')).toBe('true');
    // Same route across different owner components.
    const quickFill = openFrom(screen.getByRole('button', { name: 'Fill' }));
    expect(quickFill).not.toBe(second);
    expectClosedButMounted(second);
    expect(border.getAttribute('aria-expanded')).toBe('false');
  });

  it('honours the exit transition: closing toggles the class instead of unmounting', () => {
    renderInspector(target({ kind: 'text', label: 'Title' }));
    const swatch = screen.getByRole('button', { name: 'Text color' });
    const node = openFrom(swatch);
    expect(node.getAttribute('aria-hidden')).toBe('false');
    expect(node.hasAttribute('inert')).toBe(false);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    // Still in the DOM with the open class removed: CSS owns the 140ms exit.
    expect(document.querySelector(POPOVER_SELECTOR)).toBe(node);
    expectClosedButMounted(node);
    // Re-opening flips the same node back rather than mounting a new one.
    expect(openFrom(swatch)).toBe(node);
  });

  it('style contract: the clipping ancestors cannot re-trap a fixed body-level popover', () => {
    // The clipping context is real and documented, not removed: the panel
    // still owns its scroll.
    expect(inspectorCss).toMatch(/\.root\s*\{[^}]*overflow:\s*hidden;/);
    expect(inspectorCss).toMatch(/\.scroll\s*\{[^}]*overflow-y:\s*auto;/);
    // The popover is a fixed layer on document.body, so no ancestor overflow,
    // border-radius, contain, transform or filter inside the panel applies.
    expect(popoverCss).toMatch(/\.popover\s*\{[^}]*position:\s*fixed;/);
    expect(popoverCss).not.toMatch(/position:\s*absolute/);
    // No swatch owner may reintroduce an in-flow popover.
    for (const file of [
      'src/components/ManualEditAppearanceControls.module.css',
      'src/components/ManualEditShapeControls.module.css',
      'src/components/ManualEditTextControls.module.css',
    ]) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\.colorPopover\s*\{/);
    }
    // Tokens only; enter/exit motion on the shared easing and durations with
    // reduced-motion and reduced-transparency variants. pointer-events is
    // paired with opacity in BOTH states so visibility and clickability share
    // one timeline: none the moment the exit starts, auto the moment the
    // visible phase starts. Visibility waits for the exit to finish so the
    // fading surface stays painted.
    expect(collectCssHardcodedColorMatches(popoverCss)).toEqual([]);
    const closed = /\.popover\s*\{([^}]*)\}/.exec(popoverCss)?.[1] ?? '';
    expect(closed).toMatch(/opacity:\s*0;/);
    expect(closed).toMatch(/pointer-events:\s*none;/);
    expect(closed).toMatch(/visibility:\s*hidden;/);
    expect(closed).toMatch(/opacity var\(--dur-exit\) var\(--ease-out\)/);
    expect(closed).toMatch(/visibility 0s linear var\(--dur-exit\)/);
    const opened = /\.popoverOpen\s*\{([^}]*)\}/.exec(popoverCss)?.[1] ?? '';
    expect(opened).toMatch(/opacity:\s*1;/);
    expect(opened).toMatch(/pointer-events:\s*auto;/);
    expect(opened).toMatch(/visibility:\s*visible;/);
    expect(opened).toMatch(/opacity var\(--dur-enter\) var\(--ease-out\)/);
    expect(opened).toMatch(/visibility 0s linear 0s/);
    expect(popoverCss).not.toMatch(/ease-in\b/);
    expect(popoverCss).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.popover,\s*\.popoverOpen\s*\{\s*transition:\s*none;/);
    expect(popoverCss).toMatch(/@media \(prefers-reduced-transparency: reduce\)/);
  });
});
