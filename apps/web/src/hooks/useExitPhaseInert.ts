import { useCallback, useRef } from 'react';

/**
 * The EXIT half of the "invisible but interactive" contract.
 *
 * The entrance half is solved twice over: `pointer-events` is declared inside
 * the `@keyframes` next to `opacity` (a discrete animatable property, so the
 * two flip on the same timeline), and `useTransparentPhaseInert` gates focus,
 * which is not animatable. Neither reaches a dismissal.
 *
 * An exit is a **transition**, not a keyframe animation:
 *
 * - No `@keyframes` rule applies, so the keyframe technique covers exactly none
 *   of it. Motion drives `exit` variants as Web Animations on `opacity`; a CSS
 *   `transition` produces the same shape. Either way there is no step list in
 *   which `pointer-events` could ride along with `opacity`.
 * - Setting `pointer-events: none` on the fading ancestor does NOT help, and
 *   this was proven in a browser rather than reasoned: with `none` forced onto
 *   the modal root, `elementFromPoint` at a button centre still returned the
 *   button. A descendant declaring `pointer-events: auto` re-enables itself
 *   over an ancestor's `none` — that is correct CSS, and it means no
 *   ancestor-side pointer rule can close this window.
 * - `visibility`/`display` would close it but destroy the motion the user
 *   explicitly asked to keep: the surface must still be painted while it fades.
 *
 * `inert` is the only property that removes a subtree from hit testing,
 * sequential focus navigation and the accessibility tree at once, it is
 * inherited by descendants and — unlike `pointer-events` — cannot be overridden
 * from inside the subtree. It is therefore the only mechanism that covers both
 * halves (pointer AND keyboard) of an exit.
 *
 * Timing comes from the exit itself, never from a duplicated duration:
 *
 * - The attribute is applied SYNCHRONOUSLY the moment the exit starts, before
 *   the browser can paint a transparent-but-live frame or route a Tab into it.
 *   An exit is strictly more dangerous than an entrance: nothing brings the
 *   element back, so there is no later frame in which a mistake self-corrects,
 *   and gating early can never strand a control the user still needs.
 * - Release is driven by the live animation set (`getAnimations()`, which
 *   reports CSS transitions as well as animations) plus `transitionend` /
 *   `transitioncancel` / `animationend` / `animationcancel`. This matters only
 *   for the interrupted case: an exit reversed mid-flight (re-open while
 *   closing) must land back on the interactive side.
 * - `prefers-reduced-motion` stays coherent: that path collapses the exit to a
 *   ~0ms duration, so the element is removed on the next frame and the
 *   attribute leaves with it. There is no duration constant here to fall out of
 *   sync with the stylesheet.
 *
 * Usage: attach `ref` to the same element that carries the exit variant (the
 * animated root), and wire `onExitStart` to Motion's `onAnimationStart` with
 * the exit variant name. `inert` applies to the whole subtree, so one gate on
 * the root covers every control inside it with no per-control bookkeeping.
 */
export interface ExitPhaseInertGate {
  /** Attach to the element that carries the exit animation. */
  readonly ref: (element: HTMLElement | null) => void;
  /**
   * Call when the exit begins. Safe to call with any definition name; only the
   * exit definition gates. Passing no name gates unconditionally, which is what
   * a raw CSS transition needs.
   */
  readonly onExitStart: (definition?: unknown) => void;
}

/** Motion's exit variant is always registered under this name in this app. */
const EXIT_VARIANT = 'exit';

export function useExitPhaseInert(enabled = true): ExitPhaseInertGate {
  const elementRef = useRef<HTMLElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const ref = useCallback((element: HTMLElement | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    elementRef.current = element;
  }, []);

  const onExitStart = useCallback(
    (definition?: unknown) => {
      if (!enabled) return;
      if (typeof definition === 'string' && definition !== EXIT_VARIANT) return;
      const element = elementRef.current;
      if (!element) return;

      cleanupRef.current?.();

      // Applied before the first transparent frame can be painted or focused.
      // An exit never restores, so gating early is always the safe direction.
      element.setAttribute('inert', '');

      const release = () => {
        // Only release once the element is genuinely no longer leaving: an
        // exit reversed mid-flight has to become interactive again, but a
        // single `transitionend` for one of several properties must not lift
        // the gate while the opacity fade is still running.
        const animations =
          typeof element.getAnimations === 'function' ? element.getAnimations() : [];
        const stillRunning = animations.some((animation) => animation.playState === 'running');
        if (stillRunning) return;
        cleanupRef.current?.();
      };

      const events = [
        'transitionend',
        'transitioncancel',
        'animationend',
        'animationcancel',
      ] as const;
      for (const event of events) element.addEventListener(event, release);

      cleanupRef.current = () => {
        for (const event of events) element.removeEventListener(event, release);
        element.removeAttribute('inert');
        cleanupRef.current = null;
      };
    },
    [enabled],
  );

  return { ref, onExitStart };
}
