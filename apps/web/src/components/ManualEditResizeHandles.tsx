import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  RESIZE_HANDLE_DIRECTIONS,
  resizeDragSize,
  resizeHandlePositions,
  type ResizeHandleDirection,
} from '../edit-mode/resize-geometry';
import type { ManualEditResizeConstraint } from '../edit-mode/types';
import styles from './ManualEditResizeHandles.module.css';

type Rect = { left: number; top: number; width: number; height: number };
type Size = { width: number; height: number };

export type ManualEditResizeHandlesProps = {
  rect: Rect;
  startSize: Size;
  scale: number;
  disabled?: boolean;
  labels: Record<ResizeHandleDirection, string>;
  frameLabel: string;
  resizeConstraints?: readonly ManualEditResizeConstraint[];
  resizeFeedback?: string;
  bounds?: Size;
  // Sizes are rect-space (getBoundingClientRect px). The host owns the
  // conversion to CSS width/height (see resizeCssCommitStyles) because it
  // needs the target's computed styles and rectScale, which this component
  // deliberately knows nothing about.
  onResizePreview: (direction: ResizeHandleDirection, size: Size, startSize: Size) => void;
  onResizeCommit: (direction: ResizeHandleDirection, size: Size, startSize: Size) => void;
  onResizeCancel: () => void;
  // Returns true if a burst was in progress and got cancelled. The caller uses
  // this to decide whether to stop propagation of the Escape event.
  onBurstCancel: () => boolean;
  // Fired at pointerdown so the host can snapshot its drag baseline (computed
  // css size, base styles) BEFORE preview acks start mutating the live target.
  onResizeStart?: () => void;
  /** Clears a hover affordance before this control owns the pointer. */
  onHoverClear?: () => void;
};

type DragState = {
  direction: ResizeHandleDirection;
  pointerId: number;
  startX: number;
  startY: number;
  // Snapshot the baseline size at pointerdown: the live `startSize` prop can change
  // mid-drag when the iframe re-broadcasts target rects (window resize / ancestor
  // scroll), which would jump the delta baseline and snap the dragged size.
  startSize: Size;
  target: HTMLButtonElement;
};

// Handles always render from the `rect` prop — the element's measured box, fed
// per frame by the iframe's preview acks during a drag. The mouse-implied size
// is only a REQUEST streamed to the iframe; layout (flex, grid, min-content)
// may clamp or ignore it, and the handles must stick to the element, not the
// cursor. No optimistic local size state.
export function ManualEditResizeHandles({
  rect,
  startSize,
  scale,
  disabled = false,
  labels,
  frameLabel,
  resizeConstraints,
  resizeFeedback,
  bounds,
  onResizePreview,
  onResizeCommit,
  onResizeCancel,
  onBurstCancel,
  onResizeStart,
  onHoverClear,
}: ManualEditResizeHandlesProps) {
  const dragRef = useRef<DragState | null>(null);
  const lastDirectionRef = useRef<ResizeHandleDirection | null>(null);
  const calloutRef = useRef<HTMLDivElement | null>(null);
  const [calloutSize, setCalloutSize] = useState<Size>({ width: 0, height: 0 });
  const rafRef = useRef<number | null>(null);
  // Scheduling is tracked separately from the rAF id: a synchronously-executing
  // requestAnimationFrame (test stubs, polyfills) runs flushPreview BEFORE the
  // id is assigned to rafRef, so the id alone cannot answer "is a flush still
  // queued" — it would read as queued forever and starve every later frame.
  const flushScheduledRef = useRef(false);
  const pendingSizeRef = useRef<Size | null>(null);

  useEffect(() => () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    const callout = calloutRef.current;
    if (!callout) return;
    const { width, height } = callout.getBoundingClientRect();
    setCalloutSize((current) => (
      current.width === width && current.height === height ? current : { width, height }
    ));
  }, [bounds?.height, bounds?.width, resizeFeedback]);

  const flushPreview = () => {
    flushScheduledRef.current = false;
    rafRef.current = null;
    const drag = dragRef.current;
    const size = pendingSizeRef.current;
    if (!drag || !size) return;
    onResizePreview(drag.direction, size, drag.startSize);
  };

  const scheduleFlush = (size: Size) => {
    pendingSizeRef.current = size;
    if (flushScheduledRef.current) return;
    flushScheduledRef.current = true;
    const id = requestAnimationFrame(flushPreview);
    // A sync rAF already ran flushPreview here; don't resurrect the id.
    if (flushScheduledRef.current) rafRef.current = id;
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

  const handlePointerDown = (direction: ResizeHandleDirection) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    onHoverClear?.();
    const target = event.currentTarget;
    if (typeof target.setPointerCapture === 'function') {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // jsdom / unsupported: fall back to plain listener-based dragging.
      }
    }
    // preventDefault() above suppresses the implicit mousedown-focus, so focus the
    // handle explicitly; otherwise the Escape-cancels-drag onKeyDown never fires
    // because keydown routes to whatever was previously focused.
    if (typeof target.focus === 'function') target.focus({ preventScroll: true });
    onResizeStart?.();
    lastDirectionRef.current = direction;
    dragRef.current = {
      direction,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startSize,
      target,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const size = resizeDragSize({
      direction: drag.direction,
      startWidth: drag.startSize.width,
      startHeight: drag.startSize.height,
      deltaX: event.clientX - drag.startX,
      deltaY: event.clientY - drag.startY,
      scale,
      lockAspect: event.shiftKey,
    });
    scheduleFlush(size);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const size = pendingSizeRef.current;
    const finalFrameUnsent = flushScheduledRef.current;
    endDrag();
    pendingSizeRef.current = null;
    if (size && (size.width !== drag.startSize.width || size.height !== drag.startSize.height)) {
      // endDrag() cancelled any queued rAF flush; without this the last mouse
      // move dies in that queue — the element never renders the exact size
      // being committed and the iframe never acks its measurements.
      if (finalFrameUnsent) onResizePreview(drag.direction, size, drag.startSize);
      onResizeCommit(drag.direction, size, drag.startSize);
    } else {
      onResizeCancel();
    }
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    endDrag();
    pendingSizeRef.current = null;
    onResizeCancel();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement | HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    if (dragRef.current) {
      event.preventDefault();
      event.stopPropagation();
      endDrag();
      pendingSizeRef.current = null;
      onResizeCancel();
      return;
    }
    if (onBurstCancel()) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  // Positions in container-local space: the container itself is absolutely
  // positioned at rect.left/top by the inline style below.
  const positions = resizeHandlePositions({
    left: 0,
    top: 0,
    width: rect.width,
    height: rect.height,
  });
  const constrainedDirection = resizeConstraints?.length ? lastDirectionRef.current : null;
  const constrainedEdges: ResizeHandleDirection[] = [];
  if (constrainedDirection && resizeConstraints?.some(({ axis }) => axis === 'width')) {
    if (constrainedDirection.endsWith('e')) constrainedEdges.push('e');
    else if (constrainedDirection.endsWith('w')) constrainedEdges.push('w');
  }
  if (constrainedDirection && resizeConstraints?.some(({ axis }) => axis === 'height')) {
    if (constrainedDirection.startsWith('n')) constrainedEdges.push('n');
    else if (constrainedDirection.startsWith('s')) constrainedEdges.push('s');
  }
  let calloutStyle: CSSProperties | undefined;
  if (constrainedDirection && bounds) {
    const preferredLeft = constrainedDirection.endsWith('e')
      ? rect.width - 12 - calloutSize.width
      : constrainedDirection.endsWith('w')
        ? 12
        : (rect.width - calloutSize.width) / 2;
    const preferredTop = constrainedDirection.startsWith('n')
      ? 12
      : constrainedDirection.startsWith('s')
        ? rect.height - 12 - calloutSize.height
        : (rect.height - calloutSize.height) / 2;
    const left = Math.min(
      Math.max(rect.left + preferredLeft, 12),
      Math.max(12, bounds.width - 12 - calloutSize.width),
    ) - rect.left;
    const top = Math.min(
      Math.max(rect.top + preferredTop, 12),
      Math.max(12, bounds.height - 12 - calloutSize.height),
    ) - rect.top;
    calloutStyle = {
      left,
      top,
      right: 'auto',
      bottom: 'auto',
      transform: 'none',
      maxWidth: Math.max(0, Math.min(240, bounds.width - 24)),
      maxHeight: Math.max(0, bounds.height - 24),
    };
  }

  return (
    <div
      className={styles.container}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      role="group"
      aria-label={frameLabel}
      data-readable-edit-selected-surface
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      {constrainedEdges.map((direction) => (
        <span
          key={direction}
          aria-hidden="true"
          data-testid={`manual-edit-resize-edge-${direction}`}
          className={`${styles.constraintEdge} ${styles[`constraintEdge-${direction}`]}`}
        />
      ))}
      {RESIZE_HANDLE_DIRECTIONS.map((direction) => {
        const position = positions[direction];
        const constrained = direction === constrainedDirection;
        return (
          <button
            key={direction}
            type="button"
            disabled={disabled}
            tabIndex={-1}
            aria-label={labels[direction]}
            data-direction={direction}
            data-constrained={constrained || undefined}
            className={`${styles.handle} ${styles[`handle-${direction}`]} ${constrained ? styles.constrained : ''}`}
            style={{ left: position.left, top: position.top }}
            onPointerDown={handlePointerDown(direction)}
            onPointerEnter={() => onHoverClear?.()}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
          />
        );
      })}
      {constrainedDirection && resizeFeedback ? (
        <div
          ref={calloutRef}
          aria-hidden="true"
          data-testid="manual-edit-resize-callout"
          className={`${styles.callout} ${styles[`callout-${constrainedDirection}`]}`}
          style={calloutStyle}
        >
          {resizeFeedback}
        </div>
      ) : null}
    </div>
  );
}
