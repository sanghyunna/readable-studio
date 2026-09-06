import { useLayoutEffect, useRef } from 'react';

/**
 * Gives a mounted overlay first claim on Escape.
 *
 * Capture phase is intentional: controls rendered inside an overlay may use
 * Escape for their own popovers and stop the bubbling event. A full-screen
 * dismissible overlay must not remain behind after the same key press has
 * visually dismissed only that descendant. Layout timing also installs the
 * contract before the overlay can be painted and receive keyboard input.
 */
export function useEscapeDismiss(onDismiss: () => void, enabled = true): void {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useLayoutEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onDismissRef.current();
    };

    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [enabled]);
}
