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

function popover(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${MANUAL_EDIT_COLOR_POPOVER_TESTID}"]`);
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
  expect(document.activeElement).toBe(swatch);
  expect(swatch.getAttribute('aria-expanded')).toBe('false');

  // Outside mousedown dismisses.
  openFrom(swatch);
  fireEvent.mouseDown(document.body);
  expect(popover()).toBeNull();

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
    expect(document.activeElement).toBe(swatch);
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

  it('only one popover is open at a time across swatches', () => {
    renderInspector(target({ kind: 'container' }));
    openFrom(screen.getByRole('button', { name: 'Fill' }));
    // Opening a second swatch counts as an outside mousedown for the first.
    const border = screen.getByRole('button', { name: 'Border color' });
    fireEvent.mouseDown(border);
    fireEvent.click(border);
    expect(document.querySelectorAll(`[data-testid="${MANUAL_EDIT_COLOR_POPOVER_TESTID}"]`).length).toBe(1);
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
    // Tokens only; enter motion on the shared easing with reduced-motion and
    // reduced-transparency variants; pointer-events paired with opacity and
    // restored at the START of the visible phase.
    expect(collectCssHardcodedColorMatches(popoverCss)).toEqual([]);
    expect(popoverCss).toMatch(/animation:\s*manual-edit-color-pop-in var\(--dur-enter\) var\(--ease-out\) both;/);
    expect(popoverCss).toMatch(/@keyframes manual-edit-color-pop-in\s*\{[^}]*from\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/);
    expect(popoverCss).toMatch(/1%\s*\{\s*pointer-events:\s*auto;\s*\}/);
    expect(popoverCss).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.popover\s*\{\s*animation:\s*none;/);
    expect(popoverCss).toMatch(/@media \(prefers-reduced-transparency: reduce\)/);
  });
});
