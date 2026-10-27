import vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { buildSrcdoc } from '../../src/runtime/srcdoc';

function focusGuardFixture() {
  const html = buildSrcdoc('<main>Preview</main>', { previewFocusGuard: true });
  const script = html.match(/<script data-readable-preview-focus-guard>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('preview focus guard missing');
  type InputEvent = { isTrusted: boolean; eventPhase: number };
  const handlers = new Map<string, Array<(event: InputEvent) => void>>();
  const nativeWindowFocus = vi.fn();
  const nativeElementFocus = vi.fn();
  const nativeSvgFocus = vi.fn();
  class PreviewElement { focus() { nativeElementFocus(); } }
  class PreviewSvg { focus() { nativeSvgFocus(); } }
  class PreviewNode {
    readonly attributes = new Map<string, string>();
    get inert() { return this.attributes.has('inert'); }
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    removeAttribute(name: string) { this.attributes.delete(name); }
  }
  const root = new PreviewNode();
  class PreviewDialog extends PreviewNode {
    open = false;
    returnValue = '';
    show() { return nativeDialogShow(this); }
    showModal() { return nativeDialogShowModal(this); }
    close(value?: string) { return nativeDialogClose(this, value); }
  }
  function showDialog(dialog: PreviewDialog) {
    dialog.open = true;
    // Browser dialog focusing steps do not invoke HTMLElement.focus().
    if (!dialog.inert) nativeElementFocus();
  }
  const nativeDialogShow = vi.fn(showDialog);
  const nativeDialogShowModal = vi.fn(showDialog);
  const nativeDialogClose = vi.fn((dialog: PreviewDialog, value?: string) => {
    const wasOpen = dialog.open;
    dialog.open = false;
    if (value !== undefined) dialog.returnValue = value;
    // Closing restores a previously focused opener outside the dialog.
    if (wasOpen && !root.inert) nativeElementFocus();
  });
  let ownsFocus = false;
  const previewWindow = { focus: nativeWindowFocus };
  vm.runInNewContext(script, {
    window: previewWindow,
    document: {
      documentElement: root,
      hasFocus: () => ownsFocus,
      addEventListener(type: string, handler: (event: InputEvent) => void) {
        handlers.set(type, [...(handlers.get(type) ?? []), handler]);
      },
    },
    HTMLElement: PreviewElement,
    SVGElement: PreviewSvg,
    HTMLDialogElement: PreviewDialog,
  });
  return {
    nativeWindowFocus,
    nativeElementFocus,
    nativeSvgFocus,
    nativeDialogShowModal,
    nativeDialogClose,
    root,
    dialog: () => new PreviewDialog(),
    focusWindow: () => previewWindow.focus(),
    focusElement: () => PreviewElement.prototype.focus(),
    focusSvg: () => PreviewSvg.prototype.focus(),
    setOwnsFocus(value: boolean) { ownsFocus = value; },
    pointerDown(isTrusted: boolean, duringDispatch?: () => void) {
      const event = { isTrusted, eventPhase: 1 };
      for (const handler of handlers.get('pointerdown') ?? []) handler(event);
      duringDispatch?.();
      event.eventPhase = 0;
    },
  };
}

describe('preview focus ownership', () => {
  it('blocks artifact focus while the host composer owns input', () => {
    const f = focusGuardFixture();
    f.focusWindow();
    f.focusElement();
    expect(f.nativeWindowFocus).not.toHaveBeenCalled();
    expect(f.nativeElementFocus).not.toHaveBeenCalled();
  });

  it('allows deliberate editing and delayed controls while the preview owns focus', () => {
    const f = focusGuardFixture();
    f.setOwnsFocus(true);
    f.focusWindow();
    f.focusElement();
    expect(f.nativeWindowFocus).toHaveBeenCalledOnce();
    expect(f.nativeElementFocus).toHaveBeenCalledOnce();
  });

  it('stops allowing focus as soon as input returns to the host composer', () => {
    const f = focusGuardFixture();
    f.setOwnsFocus(true);
    f.pointerDown(true);
    f.setOwnsFocus(false);
    f.focusWindow();
    f.focusElement();
    expect(f.nativeWindowFocus).not.toHaveBeenCalled();
    expect(f.nativeElementFocus).not.toHaveBeenCalled();
  });

  it('does not treat synthetic pointer events as user focus', () => {
    const f = focusGuardFixture();
    f.pointerDown(false);
    f.focusWindow();
    f.focusElement();
    expect(f.nativeWindowFocus).not.toHaveBeenCalled();
    expect(f.nativeElementFocus).not.toHaveBeenCalled();
  });

  it('allows synchronous trusted pointer handlers before the browser default focus action', () => {
    const f = focusGuardFixture();
    f.pointerDown(true, () => {
      f.focusWindow();
      f.focusElement();
    });
    expect(f.nativeWindowFocus).toHaveBeenCalledOnce();
    expect(f.nativeElementFocus).toHaveBeenCalledOnce();
    f.focusWindow();
    f.focusElement();
    expect(f.nativeWindowFocus).toHaveBeenCalledOnce();
    expect(f.nativeElementFocus).toHaveBeenCalledOnce();
  });

  it.each(['show', 'showModal'] as const)('opens a background dialog without its native focusing steps stealing input: %s', (method) => {
    const f = focusGuardFixture();
    const dialog = f.dialog();
    dialog[method]();
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute('inert')).toBeNull();
    expect(f.nativeElementFocus).not.toHaveBeenCalled();
  });

  it('preserves exact pre-existing inert state on a background dialog', () => {
    const f = focusGuardFixture();
    const dialog = f.dialog();
    dialog.setAttribute('inert', 'authored-value');
    dialog.showModal();
    expect(dialog.getAttribute('inert')).toBe('authored-value');
    expect(f.nativeElementFocus).not.toHaveBeenCalled();
  });

  it('allows deliberate dialog entry from a trusted pointer before default iframe focus', () => {
    const f = focusGuardFixture();
    const dialog = f.dialog();
    f.pointerDown(true, () => dialog.showModal());
    expect(dialog.open).toBe(true);
    expect(dialog.inert).toBe(false);
    expect(f.nativeElementFocus).toHaveBeenCalledOnce();
  });

  it('allows dialog autofocus while the preview already owns input', () => {
    const f = focusGuardFixture();
    f.setOwnsFocus(true);
    f.dialog().showModal();
    expect(f.nativeElementFocus).toHaveBeenCalledOnce();
  });

  it('restores absent inert state and propagates the original native dialog error', () => {
    const f = focusGuardFixture();
    const dialog = f.dialog();
    const error = new Error('InvalidStateError');
    f.nativeDialogShowModal.mockImplementationOnce(() => { throw error; });
    expect(() => dialog.showModal()).toThrow(error);
    expect(dialog.getAttribute('inert')).toBeNull();
  });

  it('protects SVG focus separately while preserving deliberate SVG interaction', () => {
    const f = focusGuardFixture();
    f.focusSvg();
    expect(f.nativeSvgFocus).not.toHaveBeenCalled();
    f.setOwnsFocus(true);
    f.focusSvg();
    expect(f.nativeSvgFocus).toHaveBeenCalledOnce();
  });
});

describe('native dialog close focus restoration', () => {
  it('closes in the background without taking input back from the composer', () => {
    const f = focusGuardFixture();
    const dialog = f.dialog();
    dialog.open = true;
    dialog.close('accepted');
    expect(dialog.open).toBe(false);
    expect(dialog.returnValue).toBe('accepted');
    expect(f.nativeElementFocus).not.toHaveBeenCalled();
    expect(f.root.getAttribute('inert')).toBeNull();
  });

  it('preserves the exact pre-existing root inert attribute', () => {
    const f = focusGuardFixture();
    f.root.setAttribute('inert', 'authored-root');
    const dialog = f.dialog();
    dialog.open = true;
    dialog.close();
    expect(dialog.open).toBe(false);
    expect(f.root.getAttribute('inert')).toBe('authored-root');
    expect(f.nativeElementFocus).not.toHaveBeenCalled();
  });

  it('retains native opener focus restoration during intentional preview interaction', () => {
    const f = focusGuardFixture();
    f.setOwnsFocus(true);
    const dialog = f.dialog();
    dialog.open = true;
    dialog.close();
    expect(f.nativeElementFocus).toHaveBeenCalledOnce();
    expect(f.root.getAttribute('inert')).toBeNull();
  });

  it('retains native close focus during a currently dispatched trusted pointer', () => {
    const f = focusGuardFixture();
    const dialog = f.dialog();
    dialog.open = true;
    f.pointerDown(true, () => dialog.close());
    expect(f.nativeElementFocus).toHaveBeenCalledOnce();
    expect(f.root.getAttribute('inert')).toBeNull();
  });

  it.each([null, 'authored-root'])('restores root inert %s and propagates the original close error', (inert) => {
    const f = focusGuardFixture();
    if (inert !== null) f.root.setAttribute('inert', inert);
    const dialog = f.dialog();
    const error = new TypeError('native close error');
    f.nativeDialogClose.mockImplementationOnce(() => { throw error; });
    expect(() => dialog.close()).toThrow(error);
    expect(f.root.getAttribute('inert')).toBe(inert);
  });
});
