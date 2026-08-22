import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ManualEditPanel,
  applyManualEditStyleFields,
  emptyManualEditDraft,
  normalizeManualEditStyles,
} from '../../src/components/ManualEditPanel';
import type { ManualEditStyles, ManualEditTarget } from '../../src/edit-mode/types';

type OnStyleChange = (id: string, styles: Partial<ManualEditStyles>, label: string) => void;
type OnInvalidStyle = (id: string, keys: Array<keyof ManualEditStyles>) => void;
type OnError = (message: string) => void;

describe('ManualEditPanel', () => {
  let dom: JSDOM;
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = dom.window.document.querySelector('#root') as HTMLDivElement;
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    dom.window.close();
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'HTMLElement');
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });

  it('renders only the page-style inspector in the fixed floating card', () => {
    renderPanel();

    expect(host.querySelector('.manual-edit-page-card')).not.toBeNull();
    expect(host.querySelector('.manual-edit-drag-handle')).toBeNull();
    expect(host.querySelector('.manual-edit-scroll')?.textContent).toContain('PAGE');
    expect(host.textContent).toContain('Background');
    expect(host.textContent).toContain('Font');
    expect(host.textContent).toContain('Base size');
    expect(host.textContent).not.toContain('SIZE');
    expect(host.textContent).not.toContain('BOX');
    expect(host.querySelector('button[aria-label="Delete element"]')).toBeNull();
  });

  it('routes the page-card close action', () => {
    const onExit = vi.fn();
    renderPanel({ onExit });

    const close = host.querySelector('button[aria-label="Close edit panel"]') as HTMLButtonElement | null;
    if (!close) throw new Error('Close button not found');
    act(() => {
      close.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('keeps page controls scrollable separately from footer actions', () => {
    renderPanel();

    const scrollRegion = host.querySelector('.manual-edit-scroll');
    const footer = host.querySelector('.manual-edit-footer');

    expect(scrollRegion?.textContent).toContain('PAGE');
    expect(footer?.textContent).toContain('Cancel');
    expect(footer?.textContent).toContain('Save');
    expect(scrollRegion?.contains(footer)).toBe(false);
  });

  it('routes page-card cancel and save actions', () => {
    const onCancelDraft = vi.fn();
    const onSaveDraft = vi.fn();
    renderPanel({ onCancelDraft, onSaveDraft });

    const footerButtons = Array.from(host.querySelectorAll('.manual-edit-footer button'));
    const cancel = footerButtons.find((button) => button.textContent === 'Cancel') as HTMLButtonElement | undefined;
    const save = footerButtons.find((button) => button.textContent === 'Save') as HTMLButtonElement | undefined;
    if (!cancel || !save) throw new Error('Footer action buttons not found');

    act(() => {
      cancel.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      save.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(onCancelDraft).toHaveBeenCalledTimes(1);
    expect(onSaveDraft).toHaveBeenCalledTimes(1);
  });

  it('normalizes valid style values before host preview and persistence', () => {
    expect(normalizeManualEditStyles({
      fontSize: '48',
      color: '#f00',
      opacity: '2',
      lineHeight: '1.4',
    }, { layoutEnabled: true })).toEqual({
      ok: true,
      styles: {
        fontSize: '48px',
        color: '#ff0000',
        opacity: '1',
        lineHeight: '1.4',
      },
    });
    expect(normalizeManualEditStyles({ backgroundColor: 'transparent' }, { layoutEnabled: true })).toEqual({
      ok: true,
      styles: { backgroundColor: 'transparent' },
    });
    expect(normalizeManualEditStyles({ lineHeight: '49px' }, { layoutEnabled: true })).toEqual({
      ok: true,
      styles: { lineHeight: '49px' },
    });
    for (const opacity of ['0x10', '0b10', '1e2']) {
      expect(normalizeManualEditStyles({ opacity }, { layoutEnabled: true })).toEqual({
        ok: false,
        error: 'Opacity must be a number.',
      });
    }
  });

  it('accepts the sizing modes emitted by the manual edit inspector', () => {
    expect(normalizeManualEditStyles({
      width: '100%',
      height: 'auto',
    }, { layoutEnabled: true })).toEqual({
      ok: true,
      styles: {
        width: '100%',
        height: 'auto',
      },
    });
  });

  it('dispatches linked style fields as one draft and preview update', () => {
    const draft = emptyManualEditDraft();
    const target = {
      id: 'card',
      label: 'Card',
      isLayoutContainer: false,
    } as ManualEditTarget;
    const onDraftChange = vi.fn();
    const onStyleChange = vi.fn<OnStyleChange>();
    const onError = vi.fn<OnError>();

    applyManualEditStyleFields({
      target,
      draft,
      styles: { width: '400px', height: '200px' },
      onDraftChange,
      onStyleChange,
      onError,
    });

    expect(onDraftChange).toHaveBeenCalledWith({
      ...draft,
      styles: { ...draft.styles, width: '400px', height: '200px' },
    });
    expect(onStyleChange).toHaveBeenCalledOnce();
    expect(onStyleChange).toHaveBeenCalledWith(
      'card',
      { width: '400px', height: '200px' },
      'Style: Card',
    );
    expect(onError).toHaveBeenCalledWith('');
  });

  it('rejects invalid style values before host preview and persistence', () => {
    expect(normalizeManualEditStyles({ color: 'tomato' }, { layoutEnabled: true })).toEqual({
      ok: false,
      error: 'color must be a hex color.',
    });
    expect(normalizeManualEditStyles({ lineHeight: '-1px' }, { layoutEnabled: true })).toEqual({
      ok: false,
      error: 'Line height must be a positive number or px value.',
    });
  });

  it('rejects negative dimensions while allowing negative margins and zero dimensions', () => {
    expect(normalizeManualEditStyles({ width: '-10px' }, { layoutEnabled: true })).toEqual({
      ok: false,
      error: 'width cannot be negative.',
    });
    expect(normalizeManualEditStyles({ height: '-1' }, { layoutEnabled: true })).toEqual({
      ok: false,
      error: 'height cannot be negative.',
    });
    expect(normalizeManualEditStyles({ minHeight: '-4px' }, { layoutEnabled: true })).toEqual({
      ok: false,
      error: 'min height cannot be negative.',
    });
    expect(normalizeManualEditStyles({ marginLeft: '-4px' }, { layoutEnabled: true })).toEqual({
      ok: true,
      styles: { marginLeft: '-4px' },
    });
    expect(normalizeManualEditStyles({ width: '0', height: '0px', minHeight: '0' }, { layoutEnabled: true })).toEqual({
      ok: true,
      styles: { width: '0px', height: '0px', minHeight: '0px' },
    });
  });

  it('treats empty values as inline style clears', () => {
    expect(normalizeManualEditStyles({ fontSize: '', color: '' }, { layoutEnabled: true })).toEqual({
      ok: true,
      styles: { fontSize: '', color: '' },
    });
  });

  it('does not emit page styles when the card opens', () => {
    const onStyleChange = vi.fn<OnStyleChange>();
    renderPanel({ onStyleChange });

    expect(onStyleChange).not.toHaveBeenCalled();
  });

  it('emits only the changed page background field', () => {
    const onStyleChange = vi.fn<OnStyleChange>();
    renderPanel({ onStyleChange });

    const bgSwatch = host.querySelector('button[aria-label="Pick Background"]') as HTMLButtonElement | null;
    if (!bgSwatch) throw new Error('Background swatch not found');
    act(() => {
      bgSwatch.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    const colorTile = host.querySelector('button[aria-label="#3b82f6"]') as HTMLButtonElement | null;
    if (!colorTile) throw new Error('Background color tile not found');
    act(() => {
      colorTile.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(onStyleChange).toHaveBeenCalledWith('__body__', { backgroundColor: '#3b82f6' }, 'Page styles');
    expect(onStyleChange).not.toHaveBeenCalledWith(
      '__body__',
      expect.objectContaining({ fontFamily: expect.any(String) }),
      'Page styles',
    );
  });

  it('emits only the changed page font field', () => {
    const onStyleChange = vi.fn<OnStyleChange>();
    renderPanel({ onStyleChange });

    const fontSelect = host.querySelector('.cc-row select') as HTMLSelectElement | null;
    if (!fontSelect) throw new Error('Font select not found');
    act(() => {
      fontSelect.value = 'Georgia, serif';
      fontSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });

    expect(onStyleChange).toHaveBeenCalledWith('__body__', { fontFamily: 'Georgia, serif' }, 'Page styles');
    expect(onStyleChange).not.toHaveBeenCalledWith(
      '__body__',
      expect.objectContaining({ backgroundColor: expect.any(String) }),
      'Page styles',
    );
  });

  it('shows an inactive page inspector for fragment HTML sources', () => {
    const onStyleChange = vi.fn<OnStyleChange>();
    renderPanel({ onStyleChange, pageStylesEnabled: false });

    expect(host.textContent).toContain('Page styles are available only for full HTML documents.');
    expect(host.textContent).not.toContain('Background');
    expect(host.querySelector('.manual-edit-scroll input')).toBeNull();
    expect(host.querySelector('.manual-edit-scroll select')).toBeNull();
    expect(onStyleChange).not.toHaveBeenCalled();
  });

  it('keeps explicit empty page values as field-specific clears', () => {
    const onStyleChange = vi.fn<OnStyleChange>();
    renderPanel({ onStyleChange });

    const fontSelect = host.querySelector('.cc-row select') as HTMLSelectElement | null;
    if (!fontSelect) throw new Error('Font select not found');
    act(() => {
      fontSelect.value = '';
      fontSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });

    expect(onStyleChange).toHaveBeenCalledWith('__body__', { fontFamily: '' }, 'Page styles');
  });

  it('drops layout-only styles when layout editing is disabled', () => {
    expect(normalizeManualEditStyles({ gap: '12', flexDirection: 'column' }, { layoutEnabled: false })).toEqual({
      ok: true,
      styles: {},
    });
  });

  it('routes enabled Undo and Redo controls', () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    renderPanel({ canUndo: true, canRedo: true, onUndo, onRedo });

    const undo = host.querySelector('button[aria-label="Undo"]') as HTMLButtonElement | null;
    const redo = host.querySelector('button[aria-label="Redo"]') as HTMLButtonElement | null;
    if (!undo || !redo) throw new Error('Undo/Redo controls not found');
    expect(undo.disabled).toBe(false);
    expect(redo.disabled).toBe(false);
    act(() => {
      undo.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      redo.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onRedo).toHaveBeenCalledTimes(1);
  });

  it('disables Undo and Redo when there is no history to traverse', () => {
    renderPanel();

    expect((host.querySelector('button[aria-label="Undo"]') as HTMLButtonElement | null)?.disabled).toBe(true);
    expect((host.querySelector('button[aria-label="Redo"]') as HTMLButtonElement | null)?.disabled).toBe(true);
  });

  it('renders page-style errors in the footer', () => {
    renderPanel({ error: 'Invalid style value.' });

    expect(host.querySelector('.manual-edit-error')?.textContent).toBe('Invalid style value.');
  });

  function renderPanel({
    error = null,
    canUndo = false,
    canRedo = false,
    busy = false,
    pageStylesEnabled = true,
    onStyleChange = vi.fn<OnStyleChange>(),
    onInvalidStyle = vi.fn<OnInvalidStyle>(),
    onError = vi.fn<OnError>(),
    onExit = vi.fn(),
    onCancelDraft = vi.fn(),
    onSaveDraft = vi.fn(),
    onUndo = vi.fn(),
    onRedo = vi.fn(),
  }: {
    error?: string | null;
    canUndo?: boolean;
    canRedo?: boolean;
    busy?: boolean;
    pageStylesEnabled?: boolean;
    onStyleChange?: OnStyleChange;
    onInvalidStyle?: OnInvalidStyle;
    onError?: OnError;
    onExit?: () => void;
    onCancelDraft?: () => void;
    onSaveDraft?: () => void;
    onUndo?: () => void;
    onRedo?: () => void;
  } = {}) {
    act(() => {
      root.render(
        <ManualEditPanel
          error={error}
          canUndo={canUndo}
          canRedo={canRedo}
          busy={busy}
          pageStylesEnabled={pageStylesEnabled}
          onStyleChange={onStyleChange}
          onInvalidStyle={onInvalidStyle}
          onError={onError}
          onExit={onExit}
          onCancelDraft={onCancelDraft}
          onSaveDraft={onSaveDraft}
          onUndo={onUndo}
          onRedo={onRedo}
        />,
      );
    });
  }
});
