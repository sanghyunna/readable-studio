// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ManualEditShapeToolbar } from '../../src/components/ManualEditShapeToolbar';
import { emptyManualEditStyles, type ManualEditPatch, type ManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';

function target(overrides: Partial<ManualEditTarget> = {}): ManualEditTarget {
  return {
    id: 'hero-box',
    kind: 'container',
    label: 'Hero box',
    tagName: 'section',
    className: '',
    text: '',
    rect: { x: 0, y: 0, width: 120, height: 80 },
    fields: {},
    attributes: { 'data-readable-id': 'hero-box' },
    styles: emptyManualEditStyles(),
    isLayoutContainer: false,
    outerHtml: '<section data-readable-id="hero-box"></section>',
    ...overrides,
  };
}

function renderToolbar(overrides: {
  target?: ManualEditTarget;
  styles?: ManualEditStyles;
  error?: string | null;
  getActiveTarget?: () => ManualEditTarget | null;
  onPickImage?: (file: File) => Promise<string | null>;
} = {}) {
  const onStyleField = vi.fn<(key: keyof ManualEditStyles, value: string) => void>();
  const onApplyPatch = vi.fn<(patch: ManualEditPatch, label: string) => void>();
  const onUndo = vi.fn<() => void>();
  const onRedo = vi.fn<() => void>();
  const onError = vi.fn<(message: string) => void>();
  const utils = render(
    <ManualEditShapeToolbar
      target={overrides.target ?? target()}
      styles={overrides.styles ?? emptyManualEditStyles()}
      draftAlt="Hero alt"
      error={overrides.error}
      busy={false}
      canUndo
      canRedo
      getActiveTarget={overrides.getActiveTarget}
      onStyleField={onStyleField}
      onApplyPatch={onApplyPatch}
      onPickImage={overrides.onPickImage}
      onError={onError}
      onUndo={onUndo}
      onRedo={onRedo}
    />,
  );
  return { ...utils, onStyleField, onApplyPatch, onUndo, onRedo, onError };
}

afterEach(() => {
  cleanup();
});

describe('ManualEditShapeToolbar', () => {
  it('keeps the high-value fill, size, radius, and opacity controls direct', () => {
    const { getByLabelText, onStyleField } = renderToolbar();

    fireEvent.click(getByLabelText('Fill'));
    fireEvent.click(getByLabelText('#ef4444'));
    expect(onStyleField).toHaveBeenCalledWith('backgroundColor', '#ef4444');

    fireEvent.change(getByLabelText('Width'), { target: { value: '240' } });
    expect(onStyleField).toHaveBeenCalledWith('width', '240px');

    fireEvent.change(getByLabelText('Height'), { target: { value: '180' } });
    expect(onStyleField).toHaveBeenCalledWith('height', '180px');

    fireEvent.change(getByLabelText('Radius'), { target: { value: '8' } });
    expect(onStyleField).toHaveBeenCalledWith('borderRadius', '8px');

    fireEvent.change(getByLabelText('Opacity'), { target: { value: '0.5' } });
    expect(onStyleField).toHaveBeenCalledWith('opacity', '0.5');
  });

  it('keeps spacing and border controls in accessible popover groups without duplicate linked inputs', () => {
    const { getByLabelText, getByRole, onStyleField } = renderToolbar();

    fireEvent.click(getByLabelText('Spacing'));
    expect(getByRole('group', { name: 'Spacing' })).toBeTruthy();
    expect(() => getByLabelText('Padding')).toThrow();
    fireEvent.change(getByLabelText('Padding top'), { target: { value: '12' } });
    expect(onStyleField).toHaveBeenCalledWith('paddingTop', '12px');

    fireEvent.click(getByLabelText('Border'));
    expect(getByRole('group', { name: 'Border' })).toBeTruthy();
    expect(() => getByLabelText('Border widths')).toThrow();
    fireEvent.change(getByLabelText('Border widths left'), { target: { value: '3' } });
    expect(onStyleField).toHaveBeenCalledWith('borderLeftWidth', '3px');
    fireEvent.change(getByLabelText('Style'), { target: { value: 'dashed' } });
    expect(onStyleField).toHaveBeenCalledWith('borderStyle', 'dashed');
    fireEvent.click(getByLabelText('Border color'));
    fireEvent.click(getByLabelText('#3b82f6'));
    expect(onStyleField).toHaveBeenCalledWith('borderColor', '#3b82f6');
  });

  it('keeps grouped popovers trigger-relative on desktop', () => {
    const css = readFileSync('src/components/ManualEditShapeControls.module.css', 'utf8');

    expect(css).toMatch(/\.menuGroup \.popoverWrap \.popover\s*\{[^}]*right:\s*0;[^}]*left:\s*auto;/);
  });

  it('clamps grouped popovers to both toolbar edges in narrow containers', () => {
    const css = readFileSync('src/components/ManualEditShapeControls.module.css', 'utf8');
    const narrowRules = css.match(/@container \(max-width: 760px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';

    expect(narrowRules).toMatch(/\.menuGroup \.popoverWrap\s*\{[^}]*position:\s*static;/);
    expect(narrowRules).toMatch(/\.menuGroup \.popoverWrap \.popover\s*\{[^}]*inset-inline:\s*10px;[^}]*min-width:\s*0;/);
  });

  it('closes an open control group with Escape without propagating it', () => {
    const { getByLabelText, getByRole, queryByRole } = renderToolbar();
    const onWindowKeyDown = vi.fn();

    fireEvent.click(getByLabelText('Spacing'));
    expect(getByRole('group', { name: 'Spacing' })).toBeTruthy();
    window.addEventListener('keydown', onWindowKeyDown);
    try {
      fireEvent.keyDown(document, { key: 'Escape' });
    } finally {
      window.removeEventListener('keydown', onWindowKeyDown);
    }

    expect(queryByRole('group', { name: 'Spacing' })).toBeNull();
    expect(onWindowKeyDown).not.toHaveBeenCalled();
  });

  it('shows layout controls only for layout containers', () => {
    const nonLayout = renderToolbar();
    expect(nonLayout.queryByLabelText('Layout')).toBeNull();
    nonLayout.unmount();

    const layout = renderToolbar({ target: target({ isLayoutContainer: true }) });
    fireEvent.click(layout.getByLabelText('Layout'));
    fireEvent.change(layout.getByLabelText('Direction'), { target: { value: 'column' } });
    expect(layout.onStyleField).toHaveBeenCalledWith('flexDirection', 'column');
  });

  it('wires image replacement through set-image', async () => {
    const onPickImage = vi.fn(async () => '/assets/new.png');
    const { getByLabelText, container, onApplyPatch } = renderToolbar({
      target: target({ id: 'hero-image', kind: 'image', fields: { alt: 'Old alt' } }),
      onPickImage,
    });

    fireEvent.click(getByLabelText('More'));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'hero.png', { type: 'image/png' })] } });

    expect(onPickImage).toHaveBeenCalled();
    await waitFor(() => expect(onApplyPatch).toHaveBeenCalledWith(
      { id: 'hero-image', kind: 'set-image', src: '/assets/new.png', alt: 'Hero alt' },
      'Upload image',
    ));
  });

  it('does not replace any image when the selected target changes before upload resolves', async () => {
    let activeTarget = target({ id: 'hero-image', kind: 'image', fields: { alt: 'Old alt' } });
    const nextTarget = target({ id: 'next-image', kind: 'image', fields: { alt: 'Next alt' } });
    const onPickImage = vi.fn(async () => {
      activeTarget = nextTarget;
      return '/assets/new.png';
    });
    const { getByLabelText, container, onApplyPatch } = renderToolbar({
      target: activeTarget,
      getActiveTarget: () => activeTarget,
      onPickImage,
    });

    fireEvent.click(getByLabelText('More'));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'hero.png', { type: 'image/png' })] } });

    await waitFor(() => expect(onPickImage).toHaveBeenCalled());
    expect(onApplyPatch).not.toHaveBeenCalled();
  });

  it('keeps delete, undo, and redo reachable', () => {
    const { getByLabelText, onApplyPatch, onUndo, onRedo } = renderToolbar();

    fireEvent.click(getByLabelText('Undo'));
    expect(onUndo).toHaveBeenCalled();
    fireEvent.click(getByLabelText('Redo'));
    expect(onRedo).toHaveBeenCalled();

    fireEvent.click(getByLabelText('More'));
    fireEvent.click(getByLabelText('Delete element'));
    fireEvent.click(getByLabelText('Delete element'));
    expect(onApplyPatch).toHaveBeenCalledWith(
      { id: 'hero-box', kind: 'remove-element' },
      'Delete element',
    );
  });

  it('does not carry delete confirmation to a different selected shape', () => {
    const onStyleField = vi.fn<(key: keyof ManualEditStyles, value: string) => void>();
    const onApplyPatch = vi.fn<(patch: ManualEditPatch, label: string) => void>();
    const props = {
      styles: emptyManualEditStyles(),
      draftAlt: 'Hero alt',
      busy: false,
      canUndo: false,
      canRedo: false,
      onStyleField,
      onApplyPatch,
      onError: vi.fn<(message: string) => void>(),
      onUndo: vi.fn<() => void>(),
      onRedo: vi.fn<() => void>(),
    };
    const { getByLabelText, rerender } = render(
      <ManualEditShapeToolbar target={target({ id: 'first-box' })} {...props} />,
    );

    fireEvent.click(getByLabelText('More'));
    fireEvent.click(getByLabelText('Delete element'));
    rerender(<ManualEditShapeToolbar target={target({ id: 'second-box' })} {...props} />);
    fireEvent.click(getByLabelText('Delete element'));

    expect(onApplyPatch).not.toHaveBeenCalled();
    fireEvent.click(getByLabelText('Delete element'));
    expect(onApplyPatch).toHaveBeenCalledWith(
      { id: 'second-box', kind: 'remove-element' },
      'Delete element',
    );
  });

  it('renders shape edit errors in the docked toolbar', () => {
    const { getByRole } = renderToolbar({ error: 'Target not found' });

    expect(getByRole('alert').textContent).toBe('Target not found');
  });
});
