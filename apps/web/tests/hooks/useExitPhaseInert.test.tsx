// @vitest-environment jsdom

// The EXIT half of the "invisible but interactive" contract.
//
// The entrance half is covered twice: `pointer-events` inside the `@keyframes`
// (tests/styles/interactive-reachability-contracts) and `useTransparentPhaseInert`
// for focus. Neither reaches a dismissal, because a dismissal is a TRANSITION -
// there is no keyframe step in which `pointer-events` could ride along with
// `opacity`, and a browser run proved that forcing `pointer-events: none` onto
// the fading ancestor still leaves the descendant button returned by
// `elementFromPoint` (a descendant's `auto` overrides an ancestor's `none`).
//
// jsdom implements neither the Web Animations API nor `inert`'s focus
// semantics, so the animation surface is stubbed and the assertions are on the
// attribute contract - which is exactly what the browser acts on. The browser
// round owns the paint-level proof.

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useExitPhaseInert } from '../../src/hooks/useExitPhaseInert';

function Harness({
  enabled = true,
  runningAfterEvent = false,
}: {
  enabled?: boolean;
  /** Models a second property still transitioning when the first one ends. */
  runningAfterEvent?: boolean;
}) {
  const gate = useExitPhaseInert(enabled);
  return (
    <div
      data-testid="surface"
      ref={(element) => {
        if (element) {
          element.getAnimations = () =>
            runningAfterEvent
              ? ([{ playState: 'running' }] as unknown as Animation[])
              : ([{ playState: 'finished' }] as unknown as Animation[]);
        }
        gate.ref(element);
      }}
    >
      <button
        type="button"
        data-testid="control"
        onClick={() => {
          throw new Error('a dismissing control must not be activatable');
        }}
      >
        Submit
      </button>
      <button type="button" data-testid="start" onClick={() => gate.onExitStart('exit')}>
        start exit
      </button>
    </div>
  );
}

const surfaceOf = (container: HTMLElement): HTMLElement => {
  const surface = container.querySelector('[data-testid="surface"]');
  if (!(surface instanceof HTMLElement)) throw new Error('harness surface was not rendered');
  return surface;
};

const startExit = (container: HTMLElement, definition: unknown = 'exit'): HTMLElement => {
  const surface = surfaceOf(container);
  // Drive the gate the way Motion does: `onAnimationStart(definition)`.
  const start = container.querySelector('[data-testid="start"]');
  if (!(start instanceof HTMLElement)) throw new Error('harness start button was not rendered');
  if (definition === 'exit') start.click();
  return surface;
};

describe('useExitPhaseInert', () => {
  afterEach(cleanup);

  it('gates the fading subtree synchronously when the exit begins', () => {
    // Exits are strictly more dangerous than entrances: nothing brings the
    // element back, so a transparent-but-live frame is never self-corrected by
    // a later frame. The attribute has to be present before the first painted
    // frame of the fade, not on `transitionstart`.
    const { container } = render(<Harness />);
    const surface = startExit(container);

    expect(
      surface.hasAttribute('inert'),
      'a fading surface must be neither clickable nor tab-reachable',
    ).toBe(true);
  });

  it('covers the whole subtree, so pointer AND focus are closed at once', () => {
    // `inert` is inherited and - unlike `pointer-events` - cannot be overridden
    // from inside the subtree. That is the property that makes it the only
    // viable mechanism here; the browser proof is that a descendant's
    // `pointer-events: auto` beats an ancestor's `none`.
    const { container } = render(<Harness />);
    const surface = startExit(container);
    const control = container.querySelector('[data-testid="control"]');

    expect(control).not.toBeNull();
    expect(control instanceof HTMLElement && surface.contains(control)).toBe(true);
    expect(surface.hasAttribute('inert')).toBe(true);
  });

  it('releases the gate when an exit is reversed mid-flight', () => {
    // Re-opening while closing must land on the interactive side. A gate that
    // never lifts turns an interrupted dismissal into a dead surface.
    const { container } = render(<Harness />);
    const surface = startExit(container);
    expect(surface.hasAttribute('inert')).toBe(true);

    surface.dispatchEvent(new Event('transitioncancel'));

    expect(surface.hasAttribute('inert')).toBe(false);
  });

  it('holds the gate while another property is still transitioning', () => {
    // A modal fades opacity AND transforms. `transitionend` fires per property;
    // the first one must not lift the gate while the opacity fade is still
    // painting a transparent frame.
    const { container } = render(<Harness runningAfterEvent />);
    const surface = startExit(container);

    surface.dispatchEvent(new Event('transitionend'));

    expect(
      surface.hasAttribute('inert'),
      'the gate must outlast the first finished property',
    ).toBe(true);
  });

  it('ignores non-exit definitions so entrances stay interactive', () => {
    // Motion calls `onAnimationStart` for every definition. Gating on `visible`
    // would leave a settled surface permanently unusable.
    function EntranceHarness() {
      const gate = useExitPhaseInert();
      return (
        <div
          data-testid="surface"
          ref={gate.ref}
          onClick={() => gate.onExitStart('visible')}
        />
      );
    }
    const { container } = render(<EntranceHarness />);
    const surface = surfaceOf(container);
    surface.click();

    expect(surface.hasAttribute('inert')).toBe(false);
  });

  it('does not gate when explicitly disabled', () => {
    const { container } = render(<Harness enabled={false} />);
    const surface = startExit(container);

    expect(surface.hasAttribute('inert')).toBe(false);
  });
});
