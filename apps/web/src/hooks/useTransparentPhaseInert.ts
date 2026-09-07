import { useCallback, useRef } from 'react';

/**
 * Closes the keyboard half of the "invisible but interactive" contract.
 *
 * The CSS half lives in the keyframes: entrance animations declare
 * `pointer-events` alongside `opacity` (a discrete animatable property, so the
 * two flip together and cannot desynchronise), which makes a transparent
 * surface unclickable for exactly as long as it is transparent.
 *
 * Focus is NOT an animatable property, so that technique cannot reach it. A
 * control inside a subtree animating up from `opacity: 0` stays TAB-REACHABLE
 * while it is invisible: a keyboard user can focus and activate something they
 * cannot see, and with `animation-fill-mode: both` the transparent frame is
 * held backwards through the animation-delay as well. `inert` is the only
 * property that removes an element from sequential focus navigation, hit
 * testing and the accessibility tree at once, and it is not animatable either —
 * so it has to be driven from the component.
 *
 * Timing is taken from the animation itself rather than from a duplicated
 * duration constant:
 *
 * - `animationstart` fires when the animation begins, i.e. AFTER any
 *   animation-delay has elapsed. Under `fill-mode: both` the transparent frame
 *   is already painted during that delay, so waiting for `animationstart` would
 *   leave the very window this exists to close. The attribute is therefore
 *   applied synchronously when the ref attaches — before the browser can paint
 *   the element or route a Tab to it — and released on `animationend`.
 * - `getAnimations()` is consulted at attach time so a surface that is NOT
 *   currently animating never becomes inert. This is what keeps
 *   `prefers-reduced-motion` coherent: that path collapses the animation
 *   (`animation: none`, or a 0.01ms duration), so either there is no animation
 *   to find and the element stays interactive from the first frame, or the one
 *   that exists ends almost immediately and releases the attribute. Reduced
 *   motion can never strand a control inert.
 * - `animationcancel` is handled for the same reason: an animation removed
 *   mid-flight (a class change, a media-query flip) must release the boundary
 *   rather than leave it stuck on the inert side.
 *
 * The returned callback ref is passed straight to the animating element, which
 * must be the same element carrying the entrance animation — `inert` applies to
 * the subtree, so gating the animated ancestor covers every control inside it
 * with one attribute and no per-control bookkeeping.
 *
 * @param enabled Opt out entirely (e.g. a surface that never animates).
 */
export function useTransparentPhaseInert(enabled = true): (element: HTMLElement | null) => void {
  const cleanupRef = useRef<(() => void) | null>(null);

  return useCallback(
    (element: HTMLElement | null) => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (!element || !enabled) return;

      // Read the live animation set rather than trusting a duplicated duration.
      // `getAnimations` is unavailable in some test environments; treating that
      // as "not animating" fails open (interactive), never closed (inert).
      const animations =
        typeof element.getAnimations === 'function' ? element.getAnimations() : [];
      const hasEntranceAnimation = animations.some((animation) => {
        const effect = animation.effect;
        if (!effect) return false;
        const { delay = 0, activeDuration = 0 } = effect.getComputedTiming();
        // A reduced-motion collapse leaves a ~0.01ms animation that is over
        // before it could gate anything; only a real one is worth gating.
        return Number(delay) + Number(activeDuration) > 1;
      });
      if (!hasEntranceAnimation) {
        // Defensive: a previous mount of this element may have left the
        // attribute behind if it was torn down mid-animation.
        element.removeAttribute('inert');
        return;
      }

      // Applied synchronously so the transparent frame — including the one
      // painted backwards through animation-delay under `fill-mode: both` —
      // is never focusable.
      element.setAttribute('inert', '');

      const release = () => {
        element.removeAttribute('inert');
        cleanupRef.current?.();
        cleanupRef.current = null;
      };

      element.addEventListener('animationend', release);
      element.addEventListener('animationcancel', release);
      cleanupRef.current = () => {
        element.removeEventListener('animationend', release);
        element.removeEventListener('animationcancel', release);
        element.removeAttribute('inert');
      };
    },
    [enabled],
  );
}
