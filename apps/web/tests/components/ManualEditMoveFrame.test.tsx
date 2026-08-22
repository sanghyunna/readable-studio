// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManualEditMoveFrame } from '../../src/components/ManualEditMoveFrame';

function renderFrame(overrides: Partial<Parameters<typeof ManualEditMoveFrame>[0]> = {}) {
  const callbacks = {
    onMoveStart: vi.fn(),
    onMovePreview: vi.fn(),
    onMoveCommit: vi.fn(),
    onMoveCancel: vi.fn(),
    onPressStart: vi.fn(),
    onActivate: vi.fn(),
    onSurfaceDoubleClick: vi.fn(),
    onHoverAt: vi.fn(),
    onBurstCancel: vi.fn(() => false),
  };
  const utils = render(
    <ManualEditMoveFrame
      rect={{ left: 100, top: 50, width: 200, height: 100 }}
      scale={1}
      mode="selected"
      label="Move element"
      selectBehindHint="Select behind"
      {...callbacks}
      {...overrides}
    />,
  );
  return {
    ...utils,
    ...callbacks,
    ring: utils.container.querySelector('[data-region="ring"]') as HTMLElement,
    interior: utils.container.querySelector('[data-region="interior"]') as HTMLElement | null,
  };
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ManualEditMoveFrame', () => {
  it('forwards idle pointer coordinates but not drag coordinates', () => {
    const { interior, onHoverAt } = renderFrame();

    fireEvent.pointerEnter(interior!, { clientX: 200, clientY: 100 });
    fireEvent.pointerMove(interior!, { pointerId: 1, clientX: 210, clientY: 110 });
    expect(onHoverAt).toHaveBeenNthCalledWith(1, 200, 100);
    expect(onHoverAt).toHaveBeenNthCalledWith(2, 210, 110);

    fireEvent.pointerDown(interior!, { pointerId: 1, clientX: 210, clientY: 110 });
    fireEvent.pointerMove(interior!, { pointerId: 1, clientX: 230, clientY: 130 });
    expect(onHoverAt).toHaveBeenCalledTimes(2);
  });

  it('reports press start and unified ring activation coordinates', () => {
    const { ring, onPressStart, onActivate, onMoveStart } = renderFrame();
    fireEvent.pointerDown(ring, { pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.pointerUp(ring, { pointerId: 1, clientX: 101, clientY: 52 });

    expect(onPressStart).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith({ region: 'ring', clientX: 101, clientY: 52, altKey: false });
    expect(onMoveStart).not.toHaveBeenCalled();
  });

  it('keeps a 4px by 4px movement as an immediate activation', () => {
    const onCtrlChange = vi.fn();
    const { interior, onActivate, onMoveStart, onMoveCommit } = renderFrame({ onCtrlChange });
    fireEvent.pointerDown(interior!, { pointerId: 2, clientX: 200, clientY: 100, ctrlKey: true });
    fireEvent.pointerMove(interior!, { pointerId: 2, clientX: 204, clientY: 104, ctrlKey: true });
    fireEvent.pointerUp(interior!, { pointerId: 2, clientX: 204, clientY: 104, ctrlKey: true });

    expect(onMoveStart).not.toHaveBeenCalled();
    expect(onMoveCommit).not.toHaveBeenCalled();
    expect(onCtrlChange).not.toHaveBeenCalled();
    expect(onActivate).toHaveBeenCalledWith({ region: 'interior', clientX: 204, clientY: 104, altKey: false });
  });

  it.each([
    [5, 0],
    [0, 5],
  ])('starts a drag at a %ipx by %ipx movement', (dx, dy) => {
    const { interior, onActivate, onMoveStart, onMoveCommit } = renderFrame();
    fireEvent.pointerDown(interior!, { pointerId: 3, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(interior!, { pointerId: 3, clientX: 200 + dx, clientY: 100 + dy });
    fireEvent.pointerUp(interior!, { pointerId: 3, clientX: 200 + dx, clientY: 100 + dy });

    expect(onMoveStart).toHaveBeenCalledTimes(1);
    expect(onMoveCommit).toHaveBeenCalledWith({ delta: { x: dx, y: dy }, shiftKey: false, axis: null });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('samples Shift at threshold crossing and updates preview while the pointer is stationary', () => {
    const { interior, onMovePreview } = renderFrame();
    fireEvent.pointerDown(interior!, { pointerId: 15, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(interior!, { pointerId: 15, clientX: 220, clientY: 110, shiftKey: true });

    expect(onMovePreview).toHaveBeenLastCalledWith({
      delta: { x: 20, y: 10 },
      shiftKey: true,
      axis: 'x',
    });

    fireEvent.keyUp(window, { key: 'Shift', shiftKey: false });
    expect(onMovePreview).toHaveBeenLastCalledWith({
      delta: { x: 20, y: 10 },
      shiftKey: false,
      axis: null,
    });
  });

  it('tracks one Shift transition per key state and removes listeners when the drag ends', () => {
    const { interior, onMovePreview, onMoveCancel } = renderFrame();
    fireEvent.pointerDown(interior!, { pointerId: 16, clientX: 200, clientY: 100 });
    fireEvent.keyDown(window, { key: 'Shift', shiftKey: true });
    fireEvent.pointerMove(interior!, { pointerId: 16, clientX: 220, clientY: 110, shiftKey: true });
    fireEvent.keyDown(window, { key: 'Shift', shiftKey: true });
    fireEvent.keyDown(window, { key: 'Shift', shiftKey: true });

    expect(onMovePreview).toHaveBeenCalledTimes(1);
    fireEvent.pointerCancel(interior!, { pointerId: 16 });
    fireEvent.keyUp(window, { key: 'Shift', shiftKey: false });

    expect(onMoveCancel).toHaveBeenCalledTimes(1);
    expect(onMovePreview).toHaveBeenCalledTimes(1);
  });

  it('reports Alt on a no-drag activation but keeps Alt-modified movement on the drag path', () => {
    const first = renderFrame();
    fireEvent.pointerDown(first.interior!, { pointerId: 4, clientX: 200, clientY: 100, altKey: true });
    fireEvent.pointerUp(first.interior!, { pointerId: 4, clientX: 200, clientY: 100, altKey: true });
    expect(first.onActivate).toHaveBeenCalledWith(expect.objectContaining({ altKey: true }));
    cleanup();

    const second = renderFrame();
    fireEvent.pointerDown(second.interior!, { pointerId: 5, clientX: 200, clientY: 100, altKey: true });
    fireEvent.pointerMove(second.interior!, { pointerId: 5, clientX: 230, clientY: 140, altKey: true });
    fireEvent.pointerUp(second.interior!, { pointerId: 5, clientX: 230, clientY: 140, altKey: true });
    expect(second.onMoveCommit).toHaveBeenCalledWith({ delta: { x: 30, y: 40 }, shiftKey: false, axis: null });
    expect(second.onActivate).not.toHaveBeenCalled();
  });

  it('reports the final pointerup coordinates even when a preview is still queued', () => {
    const queued: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queued.push(cb);
      return queued.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const { interior, onMovePreview, onMoveCommit } = renderFrame({ scale: 2 });
    fireEvent.pointerDown(interior!, { pointerId: 6, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(interior!, { pointerId: 6, clientX: 240, clientY: 160 });
    fireEvent.pointerUp(interior!, { pointerId: 6, clientX: 240, clientY: 160 });

    expect(onMovePreview).not.toHaveBeenCalled();
    expect(onMoveCommit).toHaveBeenCalledWith({ delta: { x: 20, y: 30 }, shiftKey: false, axis: null });
  });

  it.each(['Escape', 'pointercancel'])('cancels an active drag on %s', (ending) => {
    const { interior, onMoveCancel, onMoveCommit, onActivate } = renderFrame();
    fireEvent.pointerDown(interior!, { pointerId: 7, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(interior!, { pointerId: 7, clientX: 220, clientY: 120 });
    if (ending === 'Escape') fireEvent.keyDown(interior!, { key: 'Escape' });
    else fireEvent.pointerCancel(interior!, { pointerId: 7 });
    fireEvent.pointerUp(interior!, { pointerId: 7, clientX: 220, clientY: 120 });

    expect(onMoveCancel).toHaveBeenCalledTimes(1);
    expect(onMoveCommit).not.toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('preserves double-click reporting and selected/editing surface shapes', () => {
    const selected = renderFrame();
    fireEvent.doubleClick(selected.interior!);
    expect(selected.onSurfaceDoubleClick).toHaveBeenCalledWith('interior');
    expect(selected.interior).not.toBeNull();
    const selectedBand = parseFloat(selected.ring.style.height);
    cleanup();

    const editing = renderFrame({ mode: 'editing' });
    expect(editing.container.querySelector('[data-region="interior"]')).toBeNull();
    expect(parseFloat(editing.ring.style.height)).toBeLessThan(selectedBand);
  });

  it('focuses the pressed surface so Escape reaches the frame', () => {
    const { interior } = renderFrame();
    fireEvent.pointerDown(interior!, { pointerId: 8, clientX: 200, clientY: 100 });
    expect(document.activeElement).toBe(interior);
  });

  it('calls onBurstCancel on Escape when no drag is active and swallows the key if cancelled', () => {
    const onBurstCancel = vi.fn(() => true);
    const { interior } = renderFrame({ onBurstCancel });
    interior!.focus();
    const event = fireEvent.keyDown(interior!, { key: 'Escape' });
    expect(onBurstCancel).toHaveBeenCalledTimes(1);
    expect(event).toBe(false);
  });

  it('does not swallow Escape when onBurstCancel reports no active burst', () => {
    const onBurstCancel = vi.fn(() => false);
    const { interior } = renderFrame({ onBurstCancel });
    interior!.focus();
    const event = fireEvent.keyDown(interior!, { key: 'Escape' });
    expect(onBurstCancel).toHaveBeenCalledTimes(1);
    expect(event).toBe(true);
  });

  it('keeps the original pointer as the sole owner of an active press', () => {
    const { ring, interior, onPressStart, onMoveStart, onMovePreview, onMoveCommit, onMoveCancel } = renderFrame();
    fireEvent.pointerDown(interior!, { pointerId: 9, clientX: 200, clientY: 100 });
    fireEvent.pointerDown(ring, { pointerId: 10, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(ring, { pointerId: 10, clientX: 130, clientY: 80 });
    fireEvent.pointerUp(ring, { pointerId: 10, clientX: 130, clientY: 80 });
    fireEvent.pointerCancel(ring, { pointerId: 10 });

    expect(document.activeElement).toBe(interior);
    expect(onPressStart).toHaveBeenCalledTimes(1);
    expect(onMoveStart).not.toHaveBeenCalled();
    expect(onMovePreview).not.toHaveBeenCalled();
    expect(onMoveCancel).not.toHaveBeenCalled();

    fireEvent.pointerMove(interior!, { pointerId: 9, clientX: 220, clientY: 130 });
    fireEvent.pointerUp(interior!, { pointerId: 9, clientX: 220, clientY: 130 });

    expect(onMoveStart).toHaveBeenCalledTimes(1);
    expect(onMovePreview).toHaveBeenCalledWith({ delta: { x: 20, y: 30 }, shiftKey: false, axis: null });
    expect(onMoveCommit).toHaveBeenCalledWith({ delta: { x: 20, y: 30 }, shiftKey: false, axis: null });
  });

  it('coalesces queued moves to the latest absolute delta and starts movement once', () => {
    const queued: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      queued.push(callback);
      return queued.length;
    });
    const { interior, onMoveStart, onMovePreview } = renderFrame();
    fireEvent.pointerDown(interior!, { pointerId: 11, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(interior!, { pointerId: 11, clientX: 205, clientY: 100 });
    fireEvent.pointerMove(interior!, { pointerId: 11, clientX: 215, clientY: 120 });
    fireEvent.pointerMove(interior!, { pointerId: 11, clientX: 230, clientY: 140 });

    expect(queued).toHaveLength(1);
    expect(onMoveStart).toHaveBeenCalledTimes(1);
    expect(onMovePreview).not.toHaveBeenCalled();

    queued[0]!(0);
    expect(onMovePreview).toHaveBeenCalledTimes(1);
    expect(onMovePreview).toHaveBeenCalledWith({ delta: { x: 30, y: 40 }, shiftKey: false, axis: null });
  });

  it('chooses the Shift axis at the threshold crossing before an rAF flush', () => {
    const queued: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      queued.push(callback);
      return queued.length;
    });
    const { interior, onMovePreview } = renderFrame();
    fireEvent.pointerDown(interior!, { pointerId: 17, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(interior!, { pointerId: 17, clientX: 220, clientY: 170, shiftKey: true });
    fireEvent.pointerMove(interior!, { pointerId: 17, clientX: 340, clientY: 220, shiftKey: true });

    queued[0]!(0);

    expect(onMovePreview).toHaveBeenCalledWith({
      delta: { x: 140, y: 120 },
      shiftKey: true,
      axis: 'y',
    });
  });

  it.each(['Escape', 'pointercancel'])('makes a queued preview inert after %s', (ending) => {
    const queued: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      queued.push(callback);
      return queued.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { interior, onMovePreview, onMoveCommit, onMoveCancel } = renderFrame();
    fireEvent.pointerDown(interior!, { pointerId: 12, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(interior!, { pointerId: 12, clientX: 220, clientY: 120 });
    if (ending === 'Escape') fireEvent.keyDown(interior!, { key: 'Escape' });
    else fireEvent.pointerCancel(interior!, { pointerId: 12 });

    queued[0]!(0);

    expect(onMoveCancel).toHaveBeenCalledTimes(1);
    expect(onMovePreview).not.toHaveBeenCalled();
    expect(onMoveCommit).not.toHaveBeenCalled();
  });

  it('keeps pointerup-only distance on the activation path', () => {
    const { interior, onMoveStart, onMovePreview, onMoveCommit, onActivate } = renderFrame();
    fireEvent.pointerDown(interior!, { pointerId: 13, clientX: 200, clientY: 100 });
    fireEvent.pointerUp(interior!, { pointerId: 13, clientX: 260, clientY: 180 });

    expect(onMoveStart).not.toHaveBeenCalled();
    expect(onMovePreview).not.toHaveBeenCalled();
    expect(onMoveCommit).not.toHaveBeenCalled();
    expect(onActivate).toHaveBeenCalledWith({
      region: 'interior',
      clientX: 260,
      clientY: 180,
      altKey: false,
    });
  });

  it('keeps a threshold-crossed return to the origin on the movement path', () => {
    const { interior, onMoveStart, onMovePreview, onMoveCommit, onActivate } = renderFrame();
    fireEvent.pointerDown(interior!, { pointerId: 14, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(interior!, { pointerId: 14, clientX: 205, clientY: 100 });
    fireEvent.pointerMove(interior!, { pointerId: 14, clientX: 200, clientY: 100 });
    fireEvent.pointerUp(interior!, { pointerId: 14, clientX: 200, clientY: 100 });

    expect(onMoveStart).toHaveBeenCalledTimes(1);
    expect(onMovePreview).toHaveBeenLastCalledWith({ delta: { x: 0, y: 0 }, shiftKey: false, axis: null });
    expect(onMoveCommit).toHaveBeenCalledWith({ delta: { x: 0, y: 0 }, shiftKey: false, axis: null });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('reports the initial Alt state at the drag threshold and tracks keyboard toggles', () => {
    const onAltChange = vi.fn();
    const { interior } = renderFrame({ onAltChange });
    fireEvent.pointerDown(interior!, { pointerId: 15, clientX: 200, clientY: 100, altKey: true });
    // No report before the threshold: a below-threshold press carries Alt through onActivate.
    expect(onAltChange).not.toHaveBeenCalled();

    fireEvent.pointerMove(interior!, { pointerId: 15, clientX: 230, clientY: 100, altKey: true });
    expect(onAltChange).toHaveBeenLastCalledWith(true);

    fireEvent.keyUp(window, { key: 'Alt' });
    expect(onAltChange).toHaveBeenLastCalledWith(false);

    fireEvent.keyDown(window, { key: 'Alt' });
    expect(onAltChange).toHaveBeenLastCalledWith(true);
  });

  it('reports Ctrl at the exact threshold and tracks stationary keyboard toggles', () => {
    const onCtrlChange = vi.fn();
    const { interior, onMoveStart, onMoveCommit } = renderFrame({ onCtrlChange });
    fireEvent.pointerDown(interior!, { pointerId: 19, clientX: 200, clientY: 100, ctrlKey: true });
    fireEvent.pointerMove(interior!, { pointerId: 19, clientX: 204, clientY: 100, ctrlKey: true });
    expect(onMoveStart).not.toHaveBeenCalled();
    expect(onCtrlChange).not.toHaveBeenCalled();

    fireEvent.pointerMove(interior!, { pointerId: 19, clientX: 205, clientY: 100, ctrlKey: true });
    expect(onMoveStart).toHaveBeenCalledTimes(1);
    expect(onCtrlChange).toHaveBeenLastCalledWith(true);

    fireEvent.keyUp(window, { key: 'Control', ctrlKey: false });
    fireEvent.keyUp(window, { key: 'Control', ctrlKey: false });
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    expect(onCtrlChange).toHaveBeenCalledTimes(3);
    expect(onCtrlChange).toHaveBeenLastCalledWith(true);

    fireEvent.pointerUp(interior!, { pointerId: 19, clientX: 210, clientY: 100, ctrlKey: false });
    expect(onCtrlChange).toHaveBeenLastCalledWith(false);
    expect(onMoveCommit).toHaveBeenCalledWith({ delta: { x: 10, y: 0 }, shiftKey: false, axis: null });
  });

  it('uses pointerup modifier state when no keyboard transition was delivered', () => {
    const onAltChange = vi.fn();
    const onCtrlChange = vi.fn();
    const { interior, onMoveCommit } = renderFrame({ onAltChange, onCtrlChange });
    fireEvent.pointerDown(interior!, { pointerId: 20, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(interior!, { pointerId: 20, clientX: 205, clientY: 100, altKey: true, ctrlKey: true });
    fireEvent.pointerUp(interior!, { pointerId: 20, clientX: 210, clientY: 100, altKey: false, ctrlKey: false });

    expect(onAltChange).toHaveBeenLastCalledWith(false);
    expect(onCtrlChange).toHaveBeenLastCalledWith(false);
    expect(onMoveCommit).toHaveBeenCalledWith({ delta: { x: 10, y: 0 }, shiftKey: false, axis: null });
  });

  it('does not report Alt for a below-threshold press', () => {
    const onAltChange = vi.fn();
    const { interior } = renderFrame({ onAltChange });
    fireEvent.pointerDown(interior!, { pointerId: 16, clientX: 200, clientY: 100, altKey: true });
    fireEvent.pointerMove(interior!, { pointerId: 16, clientX: 203, clientY: 100, altKey: true });
    fireEvent.pointerUp(interior!, { pointerId: 16, clientX: 203, clientY: 100, altKey: true });
    expect(onAltChange).not.toHaveBeenCalled();
  });

  it('detaches Alt listeners when the drag ends', () => {
    const onAltChange = vi.fn();
    const { interior } = renderFrame({ onAltChange });
    fireEvent.pointerDown(interior!, { pointerId: 17, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(interior!, { pointerId: 17, clientX: 230, clientY: 100 });
    fireEvent.pointerUp(interior!, { pointerId: 17, clientX: 230, clientY: 100 });
    onAltChange.mockClear();

    fireEvent.keyDown(window, { key: 'Alt' });
    fireEvent.keyUp(window, { key: 'Alt' });
    expect(onAltChange).not.toHaveBeenCalled();
  });

  it.each(['pointerup', 'pointercancel', 'Escape'])('detaches Ctrl listeners after %s', (ending) => {
    const onCtrlChange = vi.fn();
    const { interior } = renderFrame({ onCtrlChange });
    fireEvent.pointerDown(interior!, { pointerId: 21, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(interior!, { pointerId: 21, clientX: 230, clientY: 100, ctrlKey: true });
    onCtrlChange.mockClear();

    if (ending === 'pointerup') {
      fireEvent.pointerUp(interior!, { pointerId: 21, clientX: 230, clientY: 100, ctrlKey: true });
    } else if (ending === 'pointercancel') {
      fireEvent.pointerCancel(interior!, { pointerId: 21 });
    } else {
      fireEvent.keyDown(interior!, { key: 'Escape' });
    }

    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.keyUp(window, { key: 'Control', ctrlKey: false });
    expect(onCtrlChange).not.toHaveBeenCalled();
  });

  it('detaches Ctrl listeners when the frame unmounts', () => {
    const onCtrlChange = vi.fn();
    const { interior, unmount } = renderFrame({ onCtrlChange });
    fireEvent.pointerDown(interior!, { pointerId: 22, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(interior!, { pointerId: 22, clientX: 230, clientY: 100, ctrlKey: true });
    onCtrlChange.mockClear();
    unmount();

    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    fireEvent.keyUp(window, { key: 'Control', ctrlKey: false });
    expect(onCtrlChange).not.toHaveBeenCalled();
  });

  it('never fires Alt reports outside of a drag', () => {
    const onAltChange = vi.fn();
    renderFrame({ onAltChange });
    fireEvent.keyDown(window, { key: 'Alt' });
    fireEvent.keyUp(window, { key: 'Alt' });
    expect(onAltChange).not.toHaveBeenCalled();
  });

  it('prevents default on Alt during a drag so it cannot reach the menu bar', () => {
    const { interior } = renderFrame({ onAltChange: vi.fn() });
    fireEvent.pointerDown(interior!, { pointerId: 18, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(interior!, { pointerId: 18, clientX: 230, clientY: 100 });
    // fireEvent returns false when the (cancelable) event had preventDefault called.
    const notCancelled = fireEvent.keyDown(window, { key: 'Alt' });
    expect(notCancelled).toBe(false);
  });
});
