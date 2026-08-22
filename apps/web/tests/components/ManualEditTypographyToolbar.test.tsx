// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { FONT_OPTS } from '../../src/components/ManualEditPanel';
import {
  ManualEditTypographyToolbar,
  filterFontOptions,
  fontValueFromComboboxInput,
  type ManualEditRichFormatState,
} from '../../src/components/ManualEditTypographyToolbar';
import { quoteFontFamily, systemFontOptions, type FontOption } from '../../src/components/font-options';
import { emptyManualEditStyles, type ManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import type { SystemFontFamily } from '@readable-studio/contracts';

const systemFontsMock = vi.hoisted(() => ({
  families: [] as SystemFontFamily[],
}));

vi.mock('../../src/components/useSystemFonts', () => ({
  useSystemFonts: () => ({ families: systemFontsMock.families, loading: false }),
}));

const target: ManualEditTarget = {
  id: 'hero-title',
  kind: 'text',
  label: 'Hero Title',
  tagName: 'h1',
  className: 'hero',
  text: 'Original',
  rect: { x: 0, y: 0, width: 120, height: 40 },
  fields: { text: 'Original' },
  attributes: {},
  styles: emptyManualEditStyles(),
  isLayoutContainer: false,
  outerHtml: '<h1>Original</h1>',
};

const idleFormat: ManualEditRichFormatState = {
  editing: false,
  hasSelection: false,
  bold: false,
  italic: false,
  underline: false,
};

function renderToolbar(overrides: {
  styles?: ManualEditStyles;
  richFormat?: ManualEditRichFormatState;
} = {}) {
  const onStyleField = vi.fn<(key: keyof ManualEditStyles, value: string) => void>();
  const onRichFormat = vi.fn<(command: 'bold' | 'italic' | 'underline') => void>();
  const utils = render(
    <ManualEditTypographyToolbar
      target={target}
      styles={overrides.styles ?? emptyManualEditStyles()}
      richFormat={overrides.richFormat ?? idleFormat}
      onStyleField={onStyleField}
      onRichFormat={onRichFormat}
    />,
  );
  return { ...utils, onStyleField, onRichFormat };
}

afterEach(() => {
  systemFontsMock.families = [];
  cleanup();
});

describe('font combobox helpers', () => {
  const options: FontOption[] = [
    { label: 'Briar', value: 'briar' },
    { label: 'Arial', value: 'arial' },
    { label: 'Archivo', value: 'archivo' },
    { label: 'Zar', value: 'zar' },
  ];

  it('filters case-insensitively with prefix matches before substring matches', () => {
    expect(filterFontOptions(options, 'AR').map((option) => option.label)).toEqual([
      'Arial',
      'Archivo',
      'Briar',
      'Zar',
    ]);
  });

  it('finds Arial through a substring query', () => {
    expect(filterFontOptions(options, 'rial').map((option) => option.label)).toEqual(['Arial']);
  });

  it('resolves committed font values', () => {
    const fontOptions = [
      ...FONT_OPTS,
      ...systemFontOptions([{ family: 'Cascadia Code', faces: [] }], FONT_OPTS),
    ];
    expect(fontValueFromComboboxInput('Georgia', fontOptions, true)).toBe('Georgia, serif');
    expect(fontValueFromComboboxInput('Cascadia Code', fontOptions, true)).toBe('"Cascadia Code"');
    expect(fontValueFromComboboxInput('My Display Font', fontOptions, true)).toBe(quoteFontFamily('My Display Font'));
    expect(fontValueFromComboboxInput('inherit', fontOptions, true)).toBe('');
  });

  it('preserves the current off-list value when committing its displayed label', () => {
    expect(fontValueFromComboboxInput('acme display', FONT_OPTS, true, '"Acme Display", serif')).toBe(
      '"Acme Display", serif',
    );
  });
});

describe('ManualEditTypographyToolbar', () => {
  it('disables B/I/U when nothing is being edited', () => {
    const { getByLabelText } = renderToolbar();
    for (const label of ['Bold', 'Italic', 'Underline']) {
      expect((getByLabelText(label) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('enables B/I/U and reflects pressed state during a live selection', () => {
    const { getByLabelText } = renderToolbar({
      richFormat: { editing: true, hasSelection: true, bold: true, italic: false, underline: false },
    });
    const bold = getByLabelText('Bold') as HTMLButtonElement;
    const italic = getByLabelText('Italic') as HTMLButtonElement;
    expect(bold.disabled).toBe(false);
    expect(bold.getAttribute('aria-pressed')).toBe('true');
    expect(italic.getAttribute('aria-pressed')).toBe('false');
  });

  it('calls onRichFormat when a live Bold button is clicked', () => {
    const { getByLabelText, onRichFormat } = renderToolbar({
      richFormat: { editing: true, hasSelection: true, bold: false, italic: false, underline: false },
    });
    fireEvent.click(getByLabelText('Bold'));
    expect(onRichFormat).toHaveBeenCalledWith('bold');
  });

  it('steps font size up in px from a numeric value', () => {
    const { getByLabelText, onStyleField } = renderToolbar({
      styles: { ...emptyManualEditStyles(), fontSize: '16px' },
    });
    fireEvent.click(getByLabelText('Font size increase'));
    expect(onStyleField).toHaveBeenCalledWith('fontSize', '17px');
  });

  it('floors the font-size stepper at zero', () => {
    const { getByLabelText, onStyleField } = renderToolbar({
      styles: { ...emptyManualEditStyles(), fontSize: '0px' },
    });
    fireEvent.click(getByLabelText('Font size decrease'));
    expect(onStyleField).toHaveBeenCalledWith('fontSize', '0px');
  });

  it('disables the size stepper for non-numeric values instead of collapsing them to px', () => {
    const { getByLabelText } = renderToolbar({
      styles: { ...emptyManualEditStyles(), fontSize: '1.5rem' },
    });
    expect((getByLabelText('Font size increase') as HTMLButtonElement).disabled).toBe(true);
    expect((getByLabelText('Font size decrease') as HTMLButtonElement).disabled).toBe(true);
  });

  it('steps line-height (unitless) and letter-spacing (px)', () => {
    const { getByLabelText, onStyleField } = renderToolbar({
      styles: { ...emptyManualEditStyles(), lineHeight: '1.4', letterSpacing: '0px' },
    });
    fireEvent.click(getByLabelText('Line height increase'));
    expect(onStyleField).toHaveBeenCalledWith('lineHeight', '2.4');
    onStyleField.mockClear();
    fireEvent.click(getByLabelText('Letter spacing increase'));
    expect(onStyleField).toHaveBeenCalledWith('letterSpacing', '1px');
  });

  it('sets text-align from an align button', () => {
    const { getByLabelText, onStyleField } = renderToolbar();
    fireEvent.click(getByLabelText('Align center'));
    expect(onStyleField).toHaveBeenCalledWith('textAlign', 'center');
  });

  it('toggles a set text-align off when its button is pressed again', () => {
    const { getByLabelText, onStyleField } = renderToolbar({
      styles: { ...emptyManualEditStyles(), textAlign: 'center' },
    });
    fireEvent.click(getByLabelText('Align center'));
    expect(onStyleField).toHaveBeenCalledWith('textAlign', '');
  });

  it('sets font weight from the weight select', () => {
    const { getByLabelText, onStyleField } = renderToolbar();
    fireEvent.change(getByLabelText('Weight') as HTMLSelectElement, { target: { value: '700' } });
    expect(onStyleField).toHaveBeenCalledWith('fontWeight', '700');
  });

  it('sets text color from a swatch tile', () => {
    const { getByLabelText, onStyleField } = renderToolbar();
    fireEvent.click(getByLabelText('Text color'));
    fireEvent.click(getByLabelText('#ef4444'));
    expect(onStyleField).toHaveBeenCalledWith('color', '#ef4444');
  });

  it('filters font rows as the user types', () => {
    const { getByRole, queryByRole } = renderToolbar();
    const input = getByRole('combobox', { name: 'Font' }) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'rial' } });
    expect(getByRole('option', { name: 'Arial' })).toBeTruthy();
    expect(queryByRole('option', { name: 'Georgia' })).toBeNull();
  });

  it('commits the top filtered font on Enter', () => {
    const { getByLabelText, onStyleField } = renderToolbar();
    const input = getByLabelText('Font') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'rial' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onStyleField).toHaveBeenCalledWith('fontFamily', 'Arial, Helvetica, sans-serif');
  });

  it('commits an exact font label on Enter', () => {
    const { getByLabelText, onStyleField } = renderToolbar();
    const input = getByLabelText('Font') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Georgia' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onStyleField).toHaveBeenCalledWith('fontFamily', 'Georgia, serif');
  });

  it('commits an exact font label when a sibling toolbar button prevents blur', () => {
    const { getByLabelText, onStyleField } = renderToolbar();
    const input = getByLabelText('Font') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Georgia' } });
    fireEvent.mouseDown(getByLabelText('Align center'));
    fireEvent.click(getByLabelText('Align center'));
    expect(onStyleField).toHaveBeenCalledWith('fontFamily', 'Georgia, serif');
  });

  it('preserves a current off-list font stack on Enter when the displayed label is unchanged', () => {
    const { getByLabelText, onStyleField } = renderToolbar({
      styles: { ...emptyManualEditStyles(), fontFamily: '"Acme Display", serif' },
    });
    const input = getByLabelText('Font') as HTMLInputElement;
    expect(input.value).toBe('acme display');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onStyleField).not.toHaveBeenCalled();
  });

  it('commits a custom typed font on Enter', () => {
    const { getByLabelText, onStyleField } = renderToolbar();
    const input = getByLabelText('Font') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'My Display Font' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onStyleField).toHaveBeenCalledWith('fontFamily', '"My Display Font"');
  });

  it('commits inherit as an empty font-family on Enter', () => {
    const { getByLabelText, onStyleField } = renderToolbar({
      styles: { ...emptyManualEditStyles(), fontFamily: 'Georgia, serif' },
    });
    const input = getByLabelText('Font') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'inherit' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onStyleField).toHaveBeenCalledWith('fontFamily', '');
  });

  it('commits a clicked system font row', () => {
    systemFontsMock.families = [{ family: 'Cascadia Code', faces: [] }];
    const { getByLabelText, getByRole, onStyleField } = renderToolbar();
    const input = getByLabelText('Font') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Casc' } });
    const option = getByRole('option', { name: 'Cascadia Code' });
    fireEvent.pointerDown(option);
    const mouseDownWasPrevented = !fireEvent.mouseDown(option);
    if (!mouseDownWasPrevented) fireEvent.blur(input);
    expect(mouseDownWasPrevented).toBe(true);
    fireEvent.click(option);
    expect(onStyleField).toHaveBeenCalledWith('fontFamily', '"Cascadia Code"');
  });

  it('reverts the font input on Escape', () => {
    const { getByLabelText, onStyleField } = renderToolbar({
      styles: { ...emptyManualEditStyles(), fontFamily: 'Georgia, serif' },
    });
    const input = getByLabelText('Font') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Inter' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('georgia');
    expect(onStyleField).not.toHaveBeenCalled();
  });

  it('reverts a non-matching font input on blur', () => {
    const { getByLabelText, onStyleField } = renderToolbar({
      styles: { ...emptyManualEditStyles(), fontFamily: 'Arial, Helvetica, sans-serif' },
    });
    const input = getByLabelText('Font') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'No Such Font' } });
    fireEvent.blur(input);
    expect(input.value).toBe('arial');
    expect(onStyleField).not.toHaveBeenCalled();
  });

  it('reverts a non-matching font input when a sibling toolbar button prevents blur', () => {
    const { getByLabelText, onStyleField } = renderToolbar({
      styles: { ...emptyManualEditStyles(), fontFamily: 'Arial, Helvetica, sans-serif' },
    });
    const input = getByLabelText('Font') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Georg' } });
    fireEvent.mouseDown(getByLabelText('Align center'));
    fireEvent.click(getByLabelText('Align center'));
    expect(input.value).toBe('arial');
    expect(onStyleField.mock.calls.some(([key]) => key === 'fontFamily')).toBe(false);
  });
});
