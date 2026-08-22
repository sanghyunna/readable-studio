import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { selectManualEditMovementAxis, type ManualEditMovementAxis } from '../edit-mode/movement-session';
import styles from './ManualEditMoveFrame.module.css';

type Rect = { left: number; top: number; width: number; height: number };
type Delta = { x: number; y: number };
type Region = 'ring' | 'interior';
export type ManualEditMoveUpdate = {
  delta: Delta;
  shiftKey: boolean;
  axis: ManualEditMovementAxis | null;
};
export type ManualEditMoveActivation = {
  region: Region;
  clientX: number;
  clientY: number;
  altKey: boolean;
};

export type ManualEditMoveFrameProps = {
  rect: Rect; // overlay rect in canvas space (host passes manualEditResizeRect)
  scale: number; // overlayPreviewScale (client px per rect px)
  mode: 'editing' | 'selected';
  label: string; // aria-label for the move surface
  selectBehindHint?: string; // tooltip/aria-label for z-stack cycling
  onMoveStart: () => void; // drag threshold crossed
  onMovePreview: (update: ManualEditMoveUpdate) => void; // rect-space update, per rAF frame
  onMoveCommit: (update: ManualEditMoveUpdate) => void; // final pointerup update after a real drag
  onMoveCancel: () => void; // Esc / pointercancel mid-drag
  onPressStart: () => void;
  onActivate: (activation: ManualEditMoveActivation) => void;
  onSurfaceDoubleClick: (region: Region) => void;
  /** Idle pointer coordinates for resolving the iframe target below this overlay. */
  onHoverAt?: (clientX: number, clientY: number) => void;
  /** Fired when the Alt/Option key changes state during an active drag. */
  onAltChange?: (altKey: boolean) => void;
  /** Fired when the Ctrl/Control key changes state during an active drag. */
  onCtrlChange?: (ctrlKey: boolean) => void;
  // Returns true if a burst was in progress and got cancelled. The caller uses
  // this to decide whether to stop propagation of the Escape event.
  onBurstCancel: () => boolean;
};

// px, unscaled — the frame lives in canvas-space overlay coords.
const RING_SELECTED = 10;
// Editing mode's ring overlays the editable element's own edge (PPT keeps the
// frame outside the text box); a thinner band leaves more of the content edge
// clickable for caret placement instead of hitting the move ring.
const RING_EDITING = 4;
// client px per axis; movement through 4px remains a click, 5px starts a drag.
const DRAG_THRESHOLD = 5;

type DragState = {
  region: Region;
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
  target: HTMLElement;
};

export function ManualEditMoveFrame({
  rect,
  scale,
  mode,
  label,
  selectBehindHint,
  onMoveStart,
  onMovePreview,
  onMoveCommit,
  onMoveCancel,
  onPressStart,
  onActivate,
  onSurfaceDoubleClick,
  onHoverAt,
  onAltChange,
  onCtrlChange,
  onBurstCancel,
}: ManualEditMoveFrameProps) {
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef<number | null>(null);
  // Tracked separately from the rAF id: a synchronously-executing
  // requestAnimationFrame (test stubs, polyfills) runs flushPreview BEFORE the
  // id is assigned, so the id alone cannot answer "is a flush still queued".
  const flushScheduledRef = useRef(false);
  const pendingUpdateRef = useRef<ManualEditMoveUpdate | null>(null);
  const latestDeltaRef = useRef<Delta | null>(null);
  const latestShiftKeyRef = useRef(false);
  const shiftAxisRef = useRef<ManualEditMovementAxis | null>(null);
  const shiftListenersRef = useRef<{
    keydown: (event: KeyboardEvent) => void;
    keyup: (event: KeyboardEvent) => void;
  } | null>(null);
  const lastAltReportedRef = useRef<boolean | null>(null);
  const altListenersRef = useRef<{ down: (event: KeyboardEvent) => void; up: (event: KeyboardEvent) => void } | null>(null);
  const lastCtrlReportedRef = useRef<boolean | null>(null);
  const ctrlListenersRef = useRef<{ down: (event: KeyboardEvent) => void; up: (event: KeyboardEvent) => void } | null>(null);

  const stopShiftTracking = () => {
    const listeners = shiftListenersRef.current;
    if (!listeners) return;
    window.removeEventListener('keydown', listeners.keydown, true);
    window.removeEventListener('keyup', listeners.keyup, true);
    shiftListenersRef.current = null;
  };

  const reportAlt = (altKey: boolean) => {
    if (altKey === lastAltReportedRef.current) return;
    lastAltReportedRef.current = altKey;
    onAltChange?.(altKey);
  };

  const detachAltListeners = () => {
    const listeners = altListenersRef.current;
    if (!listeners) return;
    window.removeEventListener('keydown', listeners.down, true);
    window.removeEventListener('keyup', listeners.up, true);
    altListenersRef.current = null;
  };

  const reportCtrl = (ctrlKey: boolean) => {
    if (ctrlKey === lastCtrlReportedRef.current) return;
    lastCtrlReportedRef.current = ctrlKey;
    onCtrlChange?.(ctrlKey);
  };

  const detachCtrlListeners = () => {
    const listeners = ctrlListenersRef.current;
    if (!listeners) return;
    window.removeEventListener('keydown', listeners.down, true);
    window.removeEventListener('keyup', listeners.up, true);
    ctrlListenersRef.current = null;
  };

  useEffect(() => () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
    }
    stopShiftTracking();
    detachAltListeners();
    detachCtrlListeners();
    dragRef.current = null;
    pendingUpdateRef.current = null;
    flushScheduledRef.current = false;
  }, []);

  const flushPreview = () => {
    flushScheduledRef.current = false;
    rafRef.current = null;
    const drag = dragRef.current;
    const update = pendingUpdateRef.current;
    if (!drag || !update) return;
    onMovePreview(update);
  };

  const scheduleFlush = (update: ManualEditMoveUpdate) => {
    pendingUpdateRef.current = update;
    if (flushScheduledRef.current) return;
    flushScheduledRef.current = true;
    const id = requestAnimationFrame(flushPreview);
    // A sync rAF already ran flushPreview here; don't resurrect the id.
    if (flushScheduledRef.current) rafRef.current = id;
  };

  const flushPreviewImmediately = (update: ManualEditMoveUpdate) => {
    pendingUpdateRef.current = update;
    flushScheduledRef.current = false;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const drag = dragRef.current;
    if (!drag || !drag.dragging) return;
    onMovePreview(update);
  };

  // Apply any queued move frame synchronously so an Alt toggle re-resolves the
  // snap against the element's true current position, not a stale one.
  const flushPendingPreview = () => {
    if (!flushScheduledRef.current) return;
    const update = pendingUpdateRef.current;
    flushScheduledRef.current = false;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const drag = dragRef.current;
    if (drag && update) onMovePreview(update);
  };

  const startShiftTracking = () => {
    if (shiftListenersRef.current) return;
    const onShiftTransition = (event: KeyboardEvent) => {
      if (event.key !== 'Shift') return;
      const drag = dragRef.current;
      const delta = latestDeltaRef.current;
      if (!drag?.dragging || !delta || event.shiftKey === latestShiftKeyRef.current) return;
      latestShiftKeyRef.current = event.shiftKey;
      flushPreviewImmediately(movementUpdateFor({ ...delta }, event.shiftKey));
    };
    shiftListenersRef.current = { keydown: onShiftTransition, keyup: onShiftTransition };
    window.addEventListener('keydown', onShiftTransition, true);
    window.addEventListener('keyup', onShiftTransition, true);
  };

  // Alt toggles snapping mid-drag. These window listeners exist only while a real
  // drag is in flight; they preventDefault() the key so Alt cannot pull focus to
  // the Electron menu bar, and are stored by identity so endDrag() removes the
  // exact handlers it added even after parent re-renders.
  const attachAltListeners = () => {
    detachAltListeners();
    const onKey = (altKey: boolean) => (event: KeyboardEvent) => {
      if (event.key !== 'Alt' && event.key !== 'AltGraph') return;
      if (!dragRef.current?.dragging) return;
      event.preventDefault();
      flushPendingPreview();
      reportAlt(altKey);
    };
    const down = onKey(true);
    const up = onKey(false);
    altListenersRef.current = { down, up };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
  };

  const attachCtrlListeners = () => {
    detachCtrlListeners();
    const onKey = (ctrlKey: boolean) => (event: KeyboardEvent) => {
      if (event.key !== 'Control') return;
      if (!dragRef.current?.dragging) return;
      flushPendingPreview();
      reportCtrl(ctrlKey);
    };
    const down = onKey(true);
    const up = onKey(false);
    ctrlListenersRef.current = { down, up };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
  };

  const endDrag = () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    flushScheduledRef.current = false;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    stopShiftTracking();
    detachAltListeners();
    detachCtrlListeners();
    lastAltReportedRef.current = null;
    lastCtrlReportedRef.current = null;
    const target = drag.target;
    if (typeof target.releasePointerCapture === 'function') {
      try {
        target.releasePointerCapture(drag.pointerId);
      } catch {
        // jsdom / unsupported: pointer capture was never actually taken.
      }
    }
    return drag;
  };

  const movementUpdateFor = (delta: Delta, shiftKey: boolean): ManualEditMoveUpdate => {
    latestDeltaRef.current = delta;
    latestShiftKeyRef.current = shiftKey;
    if (!shiftKey) shiftAxisRef.current = null;
    else if (!shiftAxisRef.current) {
      shiftAxisRef.current = selectManualEditMovementAxis(delta);
    }
    return { delta, shiftKey, axis: shiftAxisRef.current };
  };

  const movementUpdate = (
    drag: DragState,
    clientX: number,
    clientY: number,
    shiftKey: boolean,
  ): ManualEditMoveUpdate => {
    return movementUpdateFor({
      x: (clientX - drag.startX) / scale,
      y: (clientY - drag.startY) / scale,
    }, shiftKey);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (dragRef.current) return;
    const target = event.currentTarget;
    const region = (target.getAttribute('data-region') as Region | null) ?? 'interior';
    if (typeof target.setPointerCapture === 'function') {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // jsdom / unsupported: fall back to plain listener-based dragging.
      }
    }
    // preventDefault() above suppresses implicit focus, so focus explicitly;
    // otherwise the Escape-cancels-drag onKeyDown never lands here.
    if (typeof target.focus === 'function') target.focus({ preventScroll: true });
    onPressStart();
    pendingUpdateRef.current = null;
    latestDeltaRef.current = null;
    latestShiftKeyRef.current = event.shiftKey;
    shiftAxisRef.current = null;
    // Reset Alt tracking; a drag reports its initial Alt state at the threshold,
    // and a below-threshold click carries Alt through onActivate instead.
    lastAltReportedRef.current = null;
    lastCtrlReportedRef.current = null;
    dragRef.current = {
      region,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      target,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      onHoverAt?.(event.clientX, event.clientY);
      return;
    }
    if (event.pointerId !== drag.pointerId) return;
    const dxClient = event.clientX - drag.startX;
    const dyClient = event.clientY - drag.startY;
    if (!drag.dragging) {
      if (Math.abs(dxClient) < DRAG_THRESHOLD && Math.abs(dyClient) < DRAG_THRESHOLD) return;
      drag.dragging = true;
      onMoveStart();
      startShiftTracking();
      attachAltListeners();
      attachCtrlListeners();
    }
    // Pointer events carry the modifier state even when keyboard focus lives in
    // the preview iframe, so this keeps Alt-gated snapping responsive during a
    // real drag; reportAlt() dedupes so an unchanged state is a no-op.
    reportAlt(event.altKey);
    reportCtrl(event.ctrlKey);
    scheduleFlush(movementUpdate(drag, event.clientX, event.clientY, event.shiftKey));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dragging = drag.dragging;
    const region = drag.region;
    if (dragging) {
      // Keyboard transitions can be missed while the pointer is captured; the
      // pointerup event is authoritative for the final modifier state.
      reportAlt(event.altKey);
      reportCtrl(event.ctrlKey);
    }
    const update = dragging
      ? movementUpdate(drag, event.clientX, event.clientY, event.shiftKey)
      : null;
    endDrag();
    pendingUpdateRef.current = null;
    latestDeltaRef.current = null;
    shiftAxisRef.current = null;
    if (dragging && update) {
      // The host reconciles this authoritative pointerup update before saving.
      onMoveCommit(update);
    } else {
      onActivate({ region, clientX: event.clientX, clientY: event.clientY, altKey: event.altKey });
    }
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dragging = drag.dragging;
    endDrag();
    pendingUpdateRef.current = null;
    latestDeltaRef.current = null;
    shiftAxisRef.current = null;
    if (dragging) onMoveCancel();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    if (dragRef.current) {
      const dragging = dragRef.current.dragging;
      event.preventDefault();
      event.stopPropagation();
      endDrag();
      pendingUpdateRef.current = null;
      latestDeltaRef.current = null;
      shiftAxisRef.current = null;
      if (dragging) onMoveCancel();
      return;
    }
    if (onBurstCancel()) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const handleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>, region: Region) => {
    event.preventDefault();
    event.stopPropagation();
    onSurfaceDoubleClick(region);
  };

  const handlePointerEnter = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) onHoverAt?.(event.clientX, event.clientY);
  };

  const surfaceProps = (region: Region) => ({
    'data-region': region,
    tabIndex: -1,
    onPointerEnter: handlePointerEnter,
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: handlePointerCancel,
    onDoubleClick: (event: ReactMouseEvent<HTMLDivElement>) => handleDoubleClick(event, region),
  });

  const ringSize = mode === 'editing' ? RING_EDITING : RING_SELECTED;

  return (
    <div
      className={`${styles.container} ${mode === 'editing' ? styles.editing : styles.selected}`}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      role="group"
      aria-label={label}
      data-readable-edit-selected-surface
      data-readable-edit-primary-surface
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <div className={`${styles.ring} ${styles.ringTop}`} style={{ height: ringSize }} {...surfaceProps('ring')} />
      <div className={`${styles.ring} ${styles.ringBottom}`} style={{ height: ringSize }} {...surfaceProps('ring')} />
      <div className={`${styles.ring} ${styles.ringLeft}`} style={{ width: ringSize }} {...surfaceProps('ring')} />
      <div className={`${styles.ring} ${styles.ringRight}`} style={{ width: ringSize }} {...surfaceProps('ring')} />
      {mode === 'selected' ? (
        <div
          className={styles.interior}
          style={{ inset: ringSize }}
          {...(selectBehindHint ? { title: selectBehindHint, 'aria-label': selectBehindHint } : {})}
          {...surfaceProps('interior')}
        />
      ) : null}
    </div>
  );
}
