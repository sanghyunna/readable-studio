// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManualEditBoxModelControls } from '../../src/components/ManualEditBoxModelControls';
import { emptyManualEditStyles, type ManualEditStyles } from '../../src/edit-mode/types';

afterEach(cleanup);

function boxStyles(): ManualEditStyles {
  return {
    ...emptyManualEditStyles(),
    paddingTop: '12px',
    paddingRight: '18px',
    paddingBottom: '12px',
    paddingLeft: '18px',
    marginTop: '10px',
    marginRight: '0px',
    marginBottom: '12px',
    marginLeft: '0px',
  };
}

describe('ManualEditBoxModelControls', () => {
  it('switches visual layers and edits the selected side', () => {
    const onStyleField = vi.fn<(key: keyof ManualEditStyles, value: string) => void>();
    render(<ManualEditBoxModelControls styles={boxStyles()} onStyleField={onStyleField} />);

    expect(screen.getByRole('button', { name: 'Padding' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Margin' }));
    expect(screen.getByRole('button', { name: 'Margin' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.change(screen.getByLabelText('Margin top'), { target: { value: '24' } });
    expect(onStyleField).toHaveBeenLastCalledWith('marginTop', '24px');
  });

  it('links all four values only when the user enables the chain control', () => {
    const onStyleField = vi.fn<(key: keyof ManualEditStyles, value: string) => void>();
    const onStyleFields = vi.fn<(styles: Partial<ManualEditStyles>) => void>();
    render(
      <ManualEditBoxModelControls
        styles={boxStyles()}
        onStyleField={onStyleField}
        onStyleFields={onStyleFields}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Link all sides' }));
    fireEvent.change(screen.getByLabelText('Padding left'), { target: { value: '20' } });

    expect(onStyleFields).toHaveBeenCalledWith({
      paddingTop: '20px',
      paddingRight: '20px',
      paddingBottom: '20px',
      paddingLeft: '20px',
    });
    expect(onStyleField).not.toHaveBeenCalled();
  });

  it('resets the active layer without touching the other layer', () => {
    const onStyleField = vi.fn<(key: keyof ManualEditStyles, value: string) => void>();
    const onStyleFields = vi.fn<(styles: Partial<ManualEditStyles>) => void>();
    render(
      <ManualEditBoxModelControls
        styles={boxStyles()}
        onStyleField={onStyleField}
        onStyleFields={onStyleFields}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reset to zero' }));

    expect(onStyleFields).toHaveBeenCalledWith({
      paddingTop: '0px',
      paddingRight: '0px',
      paddingBottom: '0px',
      paddingLeft: '0px',
    });
    expect(onStyleField).not.toHaveBeenCalled();
  });
});
