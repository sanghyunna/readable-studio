// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ManualEditResizeHandles } from '../../src/components/ManualEditResizeHandles';
import type { ResizeHandleDirection } from '../../src/edit-mode/resize-geometry';

const labels: Record<ResizeHandleDirection, string> = {
  nw: 'Resize northwest',
  n: 'Resize north',
  ne: 'Resize northeast',
  e: 'Resize east',
  se: 'Resize southeast',
  s: 'Resize south',
  sw: 'Resize southwest',
  w: 'Resize west',
};

function renderHandles(overrides: Partial<Parameters<typeof ManualEditResizeHandles>[0]> = {}) {
  const onResizePreview = vi.fn();
  const onResizeCommit = vi.fn();
  const onResizeCancel = vi.fn();
  const onBurstCancel = vi.fn(() => false);
  const onHoverClear = vi.fn();
  const utils = render(
    <ManualEditResizeHandles
      rect={{ left: 100, top: 50, width: 200, height: 100 }}
      startSize={{ width: 200, height: 100 }}
      scale={1}
      labels={labels}
      frameLabel="Resize element"
      onResizePreview={onResizePreview}
      onResizeCommit={onResizeCommit}
      onResizeCancel={onResizeCancel}
      onBurstCancel={onBurstCancel}
      onHoverClear={onHoverClear}
      {...overrides}
    />,
  );
  return { ...utils, onResizePreview, onResizeCommit, onResizeCancel, onBurstCancel, onHoverClear };
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

describe('ManualEditResizeHandles', () => {
  it('clears hover on handle entry and pointer ownership', () => {
    const { getByLabelText, onHoverClear } = renderHandles();
    const se = getByLabelText(labels.se);

    fireEvent.pointerEnter(se, { clientX: 300, clientY: 150 });
    fireEvent.pointerDown(se, { pointerId: 1, clientX: 300, clientY: 150 });

    expect(onHoverClear).toHaveBeenCalledTimes(2);
  });

  it('renders 8 handles with direction-scoped aria labels', () => {
    const { getByLabelText } = renderHandles();
    for (const direction of Object.keys(labels) as ResizeHandleDirection[]) {
      const handle = getByLabelText(labels[direction]);
      expect(handle.getAttribute('data-direction')).toBe(direction);
      expect(handle.tagName).toBe('BUTTON');
      expect(handle.getAttribute('tabindex')).toBe('-1');
    }
  });

  it('streams a live preview while dragging the SE handle', () => {
    const { getByLabelText, onResizePreview } = renderHandles();
    const se = getByLabelText(labels.se);

    fireEvent.pointerDown(se, { pointerId: 1, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(se, { pointerId: 1, clientX: 340, clientY: 170 });

    expect(onResizePreview).toHaveBeenCalledWith(
      'se',
      { width: 240, height: 120 },
      { width: 200, height: 100 },
    );
  });

  it('commits per-axis styles on pointerup after real movement', () => {
    const { getByLabelText, onResizeCommit, onResizeCancel } = renderHandles();
    const e = getByLabelText(labels.e);

    fireEvent.pointerDown(e, { pointerId: 2, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(e, { pointerId: 2, clientX: 350, clientY: 150 });
    fireEvent.pointerUp(e, { pointerId: 2, clientX: 350, clientY: 150 });

    expect(onResizeCommit).toHaveBeenCalledWith(
      'e',
      { width: 250, height: 100 },
      { width: 200, height: 100 },
    );
    expect(onResizeCancel).not.toHaveBeenCalled();
  });

  it('cancels instead of committing when pointerup happens with no movement', () => {
    const { getByLabelText, onResizeCommit, onResizeCancel } = renderHandles();
    const s = getByLabelText(labels.s);

    fireEvent.pointerDown(s, { pointerId: 3, clientX: 200, clientY: 150 });
    fireEvent.pointerUp(s, { pointerId: 3, clientX: 200, clientY: 150 });

    expect(onResizeCommit).not.toHaveBeenCalled();
    expect(onResizeCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels on pointercancel', () => {
    const { getByLabelText, onResizeCommit, onResizeCancel } = renderHandles();
    const nw = getByLabelText(labels.nw);

    fireEvent.pointerDown(nw, { pointerId: 4, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(nw, { pointerId: 4, clientX: 60, clientY: 20 });
    fireEvent.pointerCancel(nw, { pointerId: 4 });

    expect(onResizeCommit).not.toHaveBeenCalled();
    expect(onResizeCancel).toHaveBeenCalled();
  });

  it('cancels an active drag on Escape and swallows the key', () => {
    const { getByLabelText, onResizeCommit, onResizeCancel } = renderHandles();
    const se = getByLabelText(labels.se);

    fireEvent.pointerDown(se, { pointerId: 5, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(se, { pointerId: 5, clientX: 340, clientY: 170 });
    fireEvent.keyDown(se, { key: 'Escape' });

    expect(onResizeCommit).not.toHaveBeenCalled();
    expect(onResizeCancel).toHaveBeenCalledTimes(1);

    // A further pointerup for the (now-ended) drag must not double-fire cancel/commit.
    fireEvent.pointerUp(se, { pointerId: 5, clientX: 340, clientY: 170 });
    expect(onResizeCommit).not.toHaveBeenCalled();
    expect(onResizeCancel).toHaveBeenCalledTimes(1);
  });

  it('focuses the handle on pointerdown so real Escape keydown reaches it', () => {
    const { getByLabelText } = renderHandles();
    const se = getByLabelText(labels.se);

    fireEvent.pointerDown(se, { pointerId: 8, clientX: 300, clientY: 150 });

    expect(document.activeElement).toBe(se);
  });

  it('calls onBurstCancel on Escape when no drag is active and swallows the key if cancelled', () => {
    const onBurstCancel = vi.fn(() => true);
    const { getByLabelText } = renderHandles({ onBurstCancel });
    const se = getByLabelText(labels.se);
    se.focus();
    const event = fireEvent.keyDown(se, { key: 'Escape' });
    expect(onBurstCancel).toHaveBeenCalledTimes(1);
    expect(event).toBe(false);
  });

  it('does not swallow Escape when onBurstCancel reports no active burst', () => {
    const onBurstCancel = vi.fn(() => false);
    const { getByLabelText } = renderHandles({ onBurstCancel });
    const se = getByLabelText(labels.se);
    se.focus();
    const event = fireEvent.keyDown(se, { key: 'Escape' });
    expect(onBurstCancel).toHaveBeenCalledTimes(1);
    expect(event).toBe(true);
  });

  it('keeps the pointerdown baseline when the startSize prop changes mid-drag', () => {
    const { getByLabelText, rerender, onResizePreview } = renderHandles();
    const se = getByLabelText(labels.se);

    fireEvent.pointerDown(se, { pointerId: 9, clientX: 300, clientY: 150 });
    // Simulate a mid-drag rect re-broadcast changing the live prop.
    rerender(
      <ManualEditResizeHandles
        rect={{ left: 100, top: 50, width: 400, height: 300 }}
        startSize={{ width: 400, height: 300 }}
        scale={1}
        labels={labels}
        frameLabel="Resize element"
        onResizePreview={onResizePreview}
        onResizeCommit={vi.fn()}
        onResizeCancel={vi.fn()}
        onBurstCancel={vi.fn(() => false)}
      />,
    );
    fireEvent.pointerMove(se, { pointerId: 9, clientX: 340, clientY: 170 });

    // Delta (40,20) applied to the snapshot 200x100, not the changed 400x300 prop.
    expect(onResizePreview).toHaveBeenLastCalledWith(
      'se',
      { width: 240, height: 120 },
      { width: 200, height: 100 },
    );
  });

  it('renders handle positions from the rect prop, not the mouse, while dragging', () => {
    // The rect prop is fed by per-frame measurement acks from the iframe; the
    // mouse-implied size is a request the layout may clamp or ignore. Handles
    // must stick to the element, not the cursor.
    const { getByLabelText, rerender, onResizePreview } = renderHandles();
    const se = getByLabelText(labels.se);

    fireEvent.pointerDown(se, { pointerId: 10, clientX: 300, clientY: 150 });
    // Mouse implies 240x120…
    fireEvent.pointerMove(se, { pointerId: 10, clientX: 340, clientY: 170 });
    // …but the measured element box came back 210x110.
    rerender(
      <ManualEditResizeHandles
        rect={{ left: 100, top: 50, width: 210, height: 110 }}
        startSize={{ width: 200, height: 100 }}
        scale={1}
        labels={labels}
        frameLabel="Resize element"
        onResizePreview={onResizePreview}
        onResizeCommit={vi.fn()}
        onResizeCancel={vi.fn()}
        onBurstCancel={vi.fn(() => false)}
      />,
    );

    const seAfter = getByLabelText(labels.se) as HTMLButtonElement;
    expect(seAfter.style.left).toBe('210px');
    expect(seAfter.style.top).toBe('110px');
  });

  it('flushes a still-queued final preview frame before committing on pointerup', () => {
    // The preview stream is rAF-throttled; without the flush the last mouse
    // move can die in the cancelled rAF queue and the element never renders
    // the exact size that gets committed (and the iframe never acks it).
    const queued: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queued.push(cb);
      return queued.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    const { getByLabelText, onResizePreview, onResizeCommit } = renderHandles();
    const se = getByLabelText(labels.se);

    fireEvent.pointerDown(se, { pointerId: 11, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(se, { pointerId: 11, clientX: 340, clientY: 170 });
    expect(onResizePreview).not.toHaveBeenCalled();

    fireEvent.pointerUp(se, { pointerId: 11, clientX: 340, clientY: 170 });

    expect(onResizePreview).toHaveBeenCalledWith(
      'se',
      { width: 240, height: 120 },
      { width: 200, height: 100 },
    );
    expect(onResizeCommit).toHaveBeenCalledTimes(1);
    const previewOrder = onResizePreview.mock.invocationCallOrder[0] ?? 0;
    const commitOrder = onResizeCommit.mock.invocationCallOrder[0] ?? 0;
    expect(previewOrder).toBeLessThan(commitOrder);
  });

  it('locks aspect ratio on a corner drag when shift is held', () => {
    const { getByLabelText, onResizePreview } = renderHandles({
      startSize: { width: 200, height: 100 },
    });
    const se = getByLabelText(labels.se);

    fireEvent.pointerDown(se, { pointerId: 6, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(se, { pointerId: 6, clientX: 340, clientY: 152, shiftKey: true });

    // dominant axis is x (40 > 2), height follows the 2:1 start ratio -> 240/2=120.
    expect(onResizePreview).toHaveBeenCalledWith(
      'se',
      { width: 240, height: 120 },
      { width: 200, height: 100 },
    );
  });
});
