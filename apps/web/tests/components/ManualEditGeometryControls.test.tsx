// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManualEditGeometryControls } from '../../src/components/ManualEditGeometryControls';
import { emptyManualEditStyles, type ManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';

afterEach(cleanup);

function geometryTarget(): ManualEditTarget {
  return {
    id: 'card',
    kind: 'container',
    label: 'Card',
    tagName: 'section',
    className: '',
    text: '',
    rect: { x: 10, y: 20, width: 320, height: 160 },
    cssSize: { width: '320px', height: '160px' },
    fields: {},
    attributes: {},
    styles: emptyManualEditStyles(),
    isLayoutContainer: false,
    outerHtml: '<section></section>',
  };
}

function geometryStyles(): ManualEditStyles {
  return {
    ...emptyManualEditStyles(),
    width: '320px',
    height: '160px',
  };
}

describe('ManualEditGeometryControls', () => {
  it('maps familiar sizing modes to real CSS values', () => {
    const onStyleField = vi.fn<(key: keyof ManualEditStyles, value: string) => void>();
    render(
      <ManualEditGeometryControls
        target={geometryTarget()}
        styles={geometryStyles()}
        onStyleField={onStyleField}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fill Width' }));
    fireEvent.click(screen.getByRole('button', { name: 'Auto Height' }));

    expect(onStyleField.mock.calls).toEqual([
      ['width', '100%'],
      ['height', 'auto'],
    ]);
  });

  it('keeps the aspect ratio when the lock is enabled', () => {
    const onStyleField = vi.fn<(key: keyof ManualEditStyles, value: string) => void>();
    const onStyleFields = vi.fn<(styles: Partial<ManualEditStyles>) => void>();
    render(
      <ManualEditGeometryControls
        target={geometryTarget()}
        styles={geometryStyles()}
        onStyleField={onStyleField}
        onStyleFields={onStyleFields}
      />,
    );

    expect(screen.getByRole('button', { name: 'Keep aspect ratio' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '400' } });

    expect(onStyleFields).toHaveBeenCalledWith({ width: '400px', height: '200px' });
    expect(onStyleField).not.toHaveBeenCalled();
  });

  it('shows computed dimensions as Auto when no authored size is declared', () => {
    const target = { ...geometryTarget(), authoredSize: { width: '', height: '' } };
    render(
      <ManualEditGeometryControls
        target={target}
        styles={geometryStyles()}
        onStyleField={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Auto Width' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Auto Height' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('reconciles an optimistic sizing mode with the iframe cascade result', () => {
    const onStyleField = vi.fn<(key: keyof ManualEditStyles, value: string) => void>();
    const target = { ...geometryTarget(), authoredSize: { width: '320px', height: '160px' } };
    const { rerender } = render(
      <ManualEditGeometryControls
        target={target}
        styles={geometryStyles()}
        onStyleField={onStyleField}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fill Width' }));
    expect(screen.getByRole('button', { name: 'Fill Width' }).getAttribute('aria-pressed')).toBe('true');

    rerender(
      <ManualEditGeometryControls
        target={{ ...target, authoredSize: { width: '320px', height: '160px' } }}
        styles={{ ...geometryStyles(), width: '100%' }}
        onStyleField={onStyleField}
      />,
    );
    expect(screen.getByRole('button', { name: 'Fixed Width' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows and commits computed px when a fixed authored size uses another unit', () => {
    const onStyleField = vi.fn<(key: keyof ManualEditStyles, value: string) => void>();
    const target = {
      ...geometryTarget(),
      authoredSize: { width: '82%', height: 'fit-content' },
      cssSize: { width: '262.4px', height: '160px' },
    };
    const elementStyles = { ...geometryStyles(), width: '82%', height: 'fit-content' };
    render(
      <ManualEditGeometryControls
        target={target}
        styles={elementStyles}
        onStyleField={onStyleField}
      />,
    );

    expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('262.4');
    expect((screen.getByLabelText('Height') as HTMLInputElement).value).toBe('160');
    fireEvent.click(screen.getByRole('button', { name: 'Fixed Width' }));
    expect(onStyleField).toHaveBeenLastCalledWith('width', '262.4px');
  });

  it('turns direct movement into the existing translate style', () => {
    const onStyleField = vi.fn<(key: keyof ManualEditStyles, value: string) => void>();
    render(
      <ManualEditGeometryControls
        target={geometryTarget()}
        styles={geometryStyles()}
        onStyleField={onStyleField}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Direct move' }));
    fireEvent.change(screen.getByLabelText('X offset'), { target: { value: '24' } });

    expect(onStyleField).toHaveBeenLastCalledWith('translate', '24px 0px');
  });

  it('lets users type a negative offset without collapsing the intermediate minus sign', () => {
    const onStyleField = vi.fn<(key: keyof ManualEditStyles, value: string) => void>();
    render(
      <ManualEditGeometryControls
        target={geometryTarget()}
        styles={geometryStyles()}
        onStyleField={onStyleField}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Direct move' }));
    const input = screen.getByLabelText('X offset');
    fireEvent.change(input, { target: { value: '-' } });
    expect((input as HTMLInputElement).value).toBe('-');
    expect(onStyleField).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '-24' } });
    expect(onStyleField).toHaveBeenLastCalledWith('translate', '-24px 0px');
  });

  it('rejects partial numeric offset values instead of silently truncating them', () => {
    const onStyleField = vi.fn<(key: keyof ManualEditStyles, value: string) => void>();
    render(
      <ManualEditGeometryControls
        target={geometryTarget()}
        styles={geometryStyles()}
        onStyleField={onStyleField}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Direct move' }));
    const input = screen.getByLabelText('X offset') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '12x' } });
    expect(onStyleField).not.toHaveBeenCalled();
    expect(input.value).toBe('12x');
    fireEvent.blur(input);
    expect(input.value).toBe('0');
  });

  it('switches to direct movement when a canvas drag updates translate externally', () => {
    const onStyleField = vi.fn<(key: keyof ManualEditStyles, value: string) => void>();
    const target = geometryTarget();
    const { rerender } = render(
      <ManualEditGeometryControls
        target={target}
        styles={geometryStyles()}
        onStyleField={onStyleField}
      />,
    );

    expect(screen.getByRole('button', { name: 'With content' }).getAttribute('aria-pressed')).toBe('true');
    rerender(
      <ManualEditGeometryControls
        target={target}
        styles={{ ...geometryStyles(), translate: '20px -8px' }}
        onStyleField={onStyleField}
      />,
    );

    expect(screen.getByRole('button', { name: 'Direct move' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('X offset') as HTMLInputElement).value).toBe('20');
    expect((screen.getByLabelText('Y offset') as HTMLInputElement).value).toBe('-8');
  });
});
