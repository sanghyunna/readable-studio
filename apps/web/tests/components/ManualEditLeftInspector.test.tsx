// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { ManualEditLeftInspector } from '../../src/components/ManualEditLeftInspector';
import type { ManualEditRichFormatState } from '../../src/components/ManualEditTextControls';
import { emptyManualEditStyles, type ManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import type { SystemFontFamily } from '@readable-studio/contracts';

const systemFontsMock = vi.hoisted(() => ({ families: [] as SystemFontFamily[] }));
vi.mock('../../src/components/useSystemFonts', () => ({
  useSystemFonts: () => ({ families: systemFontsMock.families, loading: false }),
}));

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

function renderInspector(overrides: {
  target?: ManualEditTarget | null;
  styles?: ManualEditStyles;
  pageStylesEnabled?: boolean;
} = {}) {
  const onStyleField = vi.fn<(key: keyof ManualEditStyles, value: string) => void>();
  const onRichFormat = vi.fn();
  const onApplyPatch = vi.fn();
  const onError = vi.fn();
  const onUndo = vi.fn();
  const onRedo = vi.fn();
  const onPageStyleChange = vi.fn();
  const onPageInvalidStyle = vi.fn();
  const onExit = vi.fn();
  const utils = render(
    <ManualEditLeftInspector
      target={overrides.target === undefined ? target() : overrides.target}
      styles={overrides.styles ?? emptyManualEditStyles()}
      richFormat={idleFormat}
      draftAlt=""
      error={null}
      busy={false}
      canUndo
      canRedo
      pageStylesEnabled={overrides.pageStylesEnabled ?? true}
      onStyleField={onStyleField}
      onRichFormat={onRichFormat}
      onApplyPatch={onApplyPatch}
      onError={onError}
      onUndo={onUndo}
      onRedo={onRedo}
      onPageStyleChange={onPageStyleChange}
      onPageInvalidStyle={onPageInvalidStyle}
      onExit={onExit}
    />,
  );
  return { ...utils, onStyleField, onRichFormat, onApplyPatch, onUndo, onRedo, onPageStyleChange, onExit };
}

afterEach(() => {
  systemFontsMock.families = [];
  cleanup();
});

describe('ManualEditLeftInspector', () => {
  it('shows the Page section (and no element sections) when nothing is selected', () => {
    const { getByText, queryByText, getByLabelText } = renderInspector({ target: null });
    expect(getByText('Page')).toBeTruthy();
    expect(queryByText('Text')).toBeNull();
    expect(queryByText('Shape')).toBeNull();
    // Page fields render for a full-document source.
    expect(getByLabelText('Pick Background')).toBeTruthy();
  });

  it('shows the disabled-page hint for fragment sources', () => {
    const { getByText, queryByLabelText } = renderInspector({ target: null, pageStylesEnabled: false });
    expect(getByText('Page styles are available only for full HTML documents.')).toBeTruthy();
    expect(queryByLabelText('Pick Background')).toBeNull();
  });

  it('keeps quick text formatting visible and precision controls folded', () => {
    const { getByText, getAllByText, getByLabelText, getByRole } = renderInspector({ target: target({ kind: 'text', label: 'Title' }) });
    expect(getAllByText('Text').length).toBeGreaterThan(0);
    expect(getByText('Quick format')).toBeTruthy();
    expect(getByLabelText('Font')).toBeTruthy();
    expect(getByRole('button', { name: /Size & position/ }).getAttribute('aria-expanded')).toBe('false');
    expect(getByRole('button', { name: /Spacing/ }).getAttribute('aria-expanded')).toBe('false');
    expect(getByRole('button', { name: /Appearance/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('shows quick shape controls instead of typography for a non-text target', () => {
    const { getByText, getAllByText, queryByText } = renderInspector({ target: target({ kind: 'container' }) });
    expect(queryByText('Text')).toBeNull();
    expect(getAllByText('Shape').length).toBeGreaterThan(0);
    expect(getByText('Quick shape')).toBeTruthy();
    expect(queryByText('Quick format')).toBeNull();
  });

  it('routes a shape style-field change through onStyleField', () => {
    const { getByLabelText, onStyleField } = renderInspector({ target: target({ kind: 'container' }) });
    fireEvent.change(getByLabelText('Width'), { target: { value: '240' } });
    expect(onStyleField).toHaveBeenCalledWith('width', '240px');
  });

  it('offers an explicit no-fill option for shape appearance', () => {
    const styles = { ...emptyManualEditStyles(), backgroundColor: '#ef4444' };
    const { getByRole, onStyleField } = renderInspector({ target: target({ kind: 'container' }), styles });

    fireEvent.click(getByRole('button', { name: /Appearance/ }));
    const noFill = getByRole('checkbox', { name: 'No fill' });
    expect((noFill as HTMLInputElement).checked).toBe(false);

    fireEvent.click(noFill);
    expect(onStyleField).toHaveBeenLastCalledWith('backgroundColor', 'transparent');
  });

  it('does not coerce malformed quick opacity values into valid percentages', () => {
    const { getByText, onStyleField } = renderInspector({ target: target({ kind: 'container' }) });
    const quickShape = getByText('Quick shape').closest('section');
    if (!quickShape) throw new Error('Quick shape section not found');
    const opacity = within(quickShape).getByLabelText('Opacity');

    fireEvent.change(opacity, { target: { value: '12x' } });
    expect(onStyleField).toHaveBeenLastCalledWith('opacity', '12x');
    fireEvent.change(opacity, { target: { value: '1e2' } });
    expect(onStyleField).toHaveBeenLastCalledWith('opacity', '1e2');
    fireEvent.change(opacity, { target: { value: '50' } });
    expect(onStyleField).toHaveBeenLastCalledWith('opacity', '0.5');
  });

  it('keeps the quick text color value directly editable', () => {
    const { getByLabelText, onStyleField } = renderInspector({ target: target({ kind: 'text', label: 'Title' }) });
    fireEvent.change(getByLabelText('Text color value'), { target: { value: '#ef4444' } });
    expect(onStyleField).toHaveBeenCalledWith('color', '#ef4444');
  });

  it('routes a page font change through onPageStyleChange', () => {
    const { container, onPageStyleChange } = renderInspector({ target: null });
    const fontSelect = container.querySelector('.cc-row select') as HTMLSelectElement | null;
    if (!fontSelect) throw new Error('Font select not found');
    fireEvent.change(fontSelect, { target: { value: 'Georgia, serif' } });
    expect(onPageStyleChange).toHaveBeenCalledWith('__body__', { fontFamily: 'Georgia, serif' }, 'Page styles');
  });

  it('routes header undo/redo and exit', () => {
    const { getByLabelText, onUndo, onRedo, onExit } = renderInspector();
    fireEvent.click(getByLabelText('Undo'));
    fireEvent.click(getByLabelText('Redo'));
    fireEvent.click(getByLabelText('Exit edit mode'));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onRedo).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('shows layout controls only for layout containers', () => {
    const plain = renderInspector({ target: target({ isLayoutContainer: false }) });
    expect(plain.queryByLabelText('Direction')).toBeNull();
    plain.unmount();
    const layout = renderInspector({ target: target({ isLayoutContainer: true }) });
    fireEvent.change(layout.getByLabelText('Direction'), { target: { value: 'column' } });
    expect(layout.onStyleField).toHaveBeenCalledWith('flexDirection', 'column');
  });
});
