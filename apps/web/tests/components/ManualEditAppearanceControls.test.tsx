// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { ManualEditAppearanceControls } from '../../src/components/ManualEditAppearanceControls';
import { emptyManualEditStyles, type ManualEditStyles } from '../../src/edit-mode/types';
import { collectCssHardcodedColorMatches } from '../../../../scripts/style-policy';

const appearanceCss = readFileSync('src/components/ManualEditAppearanceControls.module.css', 'utf8');

function renderControls(overrides: Partial<ManualEditStyles> = {}, withBatch = true) {
  const onStyleField = vi.fn<(key: keyof ManualEditStyles, value: string) => void>();
  const onStyleFields = vi.fn<(styles: Partial<ManualEditStyles>) => void>();
  const utils = render(
    <ManualEditAppearanceControls
      styles={{ ...emptyManualEditStyles(), ...overrides }}
      onStyleField={onStyleField}
      onStyleFields={withBatch ? onStyleFields : undefined}
    >
      <button type="button">Delete element</button>
    </ManualEditAppearanceControls>,
  );
  return { ...utils, onStyleField, onStyleFields };
}

afterEach(cleanup);

describe('ManualEditAppearanceControls', () => {
  it('keeps fill, no-fill, border colour, style, widths, radius, opacity and the action zone reachable', () => {
    const { getByLabelText, getByRole } = renderControls({ backgroundColor: '#ef4444', borderColor: '#111111' });
    expect(getByLabelText('Fill')).toBeTruthy();
    expect(getByRole('button', { name: 'No fill' }).getAttribute('aria-pressed')).toBe('false');
    expect(getByLabelText('Border color')).toBeTruthy();
    expect(getByRole('radiogroup', { name: 'Style' })).toBeTruthy();
    expect(getByRole('group', { name: 'Border widths' })).toBeTruthy();
    expect(getByLabelText('Radius')).toBeTruthy();
    expect(getByRole('slider', { name: 'Opacity' })).toBeTruthy();
    expect(within(getByRole('group', { name: 'Element' })).getByText('Delete element')).toBeTruthy();
  });

  it('toggles no-fill through the shared ToggleButton and restores the last fill', () => {
    const { getByRole, onStyleField } = renderControls({ backgroundColor: '#ef4444' });
    const noFill = getByRole('button', { name: 'No fill' });
    expect(noFill.querySelector('input')).toBeNull();
    fireEvent.click(noFill);
    expect(onStyleField).toHaveBeenLastCalledWith('backgroundColor', 'transparent');
  });

  it('draws border styles as a radio group and emits the raw CSS keyword', () => {
    const { getByRole, onStyleField } = renderControls({ borderStyle: 'solid' });
    expect(getByRole('radio', { name: 'Solid border' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(getByRole('radio', { name: 'Dashed border' }));
    expect(onStyleField).toHaveBeenLastCalledWith('borderStyle', 'dashed');
    fireEvent.click(getByRole('radio', { name: 'No border' }));
    expect(onStyleField).toHaveBeenLastCalledWith('borderStyle', 'none');
  });

  it('keeps an off-list authored border style selectable', () => {
    const { getByRole } = renderControls({ borderStyle: 'groove' });
    expect(getByRole('radio', { name: 'groove' }).getAttribute('aria-checked')).toBe('true');
  });

  it('defaults border width to linked when all sides agree and batches all four sides', () => {
    const { getByLabelText, getByRole, onStyleFields, queryByLabelText } = renderControls({
      borderTopWidth: '1px', borderRightWidth: '1px', borderBottomWidth: '1px', borderLeftWidth: '1px',
    });
    expect(getByRole('button', { name: 'Link all sides' }).getAttribute('aria-pressed')).toBe('true');
    expect(queryByLabelText('Border widths top')).toBeNull();
    fireEvent.change(getByLabelText('Border width, all sides'), { target: { value: '3' } });
    expect(onStyleFields).toHaveBeenLastCalledWith({
      borderTopWidth: '3px', borderRightWidth: '3px', borderBottomWidth: '3px', borderLeftWidth: '3px',
    });
  });

  it('falls back to four onStyleField calls when no batch callback exists', () => {
    const { getByLabelText, onStyleField } = renderControls({}, false);
    fireEvent.change(getByLabelText('Border width, all sides'), { target: { value: '2' } });
    expect(onStyleField.mock.calls).toEqual([
      ['borderTopWidth', '2px'], ['borderRightWidth', '2px'], ['borderBottomWidth', '2px'], ['borderLeftWidth', '2px'],
    ]);
  });

  it('opens per-side editing when the widths differ and routes each side to its own property', () => {
    const { getByLabelText, getByRole, onStyleField } = renderControls({
      borderTopWidth: '1px', borderRightWidth: '2px', borderBottomWidth: '1px', borderLeftWidth: '2px',
    });
    expect(getByRole('button', { name: 'Link all sides' }).getAttribute('aria-pressed')).toBe('false');
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(getByLabelText(`Border widths ${side}`)).toBeTruthy();
    }
    fireEvent.change(getByLabelText('Border widths left'), { target: { value: '4' } });
    expect(onStyleField).toHaveBeenLastCalledWith('borderLeftWidth', '4px');
  });

  it('re-linking unequal sides normalises them to the top value', () => {
    const { getByRole, onStyleFields } = renderControls({
      borderTopWidth: '1px', borderRightWidth: '2px', borderBottomWidth: '1px', borderLeftWidth: '2px',
    });
    fireEvent.click(getByRole('button', { name: 'Link all sides' }));
    expect(onStyleFields).toHaveBeenLastCalledWith({
      borderTopWidth: '1px', borderRightWidth: '1px', borderBottomWidth: '1px', borderLeftWidth: '1px',
    });
  });

  it('keeps radius and opacity value semantics (px and 0-1 fraction)', () => {
    const { getByLabelText, getByRole, onStyleField } = renderControls({ borderRadius: '8px', opacity: '0.5' });
    fireEvent.change(getByLabelText('Radius'), { target: { value: '12' } });
    expect(onStyleField).toHaveBeenLastCalledWith('borderRadius', '12px');
    fireEvent.click(getByRole('button', { name: 'Radius increase' }));
    expect(onStyleField).toHaveBeenLastCalledWith('borderRadius', '9px');
    const slider = getByRole('slider', { name: 'Opacity' }) as HTMLInputElement;
    expect(slider.value).toBe('50');
    fireEvent.change(slider, { target: { value: '25' } });
    expect(onStyleField).toHaveBeenLastCalledWith('opacity', '0.25');
  });

  it('uses only semantic tokens and owns no in-flow colour popover (that lives in the body portal)', () => {
    expect(collectCssHardcodedColorMatches(appearanceCss)).toEqual([]);
    expect(appearanceCss).not.toMatch(/\.colorPopover/);
    expect(appearanceCss).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(appearanceCss).toMatch(/@media \(prefers-reduced-transparency: reduce\)/);
    expect(appearanceCss).not.toMatch(/checkbox/);
  });
});
