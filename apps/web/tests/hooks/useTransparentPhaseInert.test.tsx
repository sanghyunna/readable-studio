// @vitest-environment jsdom

// The keyboard half of the "invisible but interactive" contract.
//
// The CSS half is asserted in tests/styles/interactive-reachability-contracts:
// entrance keyframes declare `pointer-events` alongside `opacity`, so a
// transparent surface is unclickable for exactly as long as it is transparent.
// Focus is not an animatable property, so that technique cannot reach it - a
// control inside a subtree animating up from `opacity: 0` stays TAB-REACHABLE
// while invisible, and a keyboard user can focus and activate something they
// cannot see. `inert` is the only property that removes an element from
// sequential focus navigation, hit testing and the a11y tree at once, and it is
// driven from the component. These tests pin that behaviour.
//
// jsdom implements neither the Web Animations API nor `inert`'s focus
// semantics, so the animation surface is stubbed explicitly and the assertions
// are on the attribute contract - which is precisely what the browser acts on.
// The browser round owns the paint-level proof; see the evidence file.

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useTransparentPhaseInert } from '../../src/hooks/useTransparentPhaseInert';

type TimingStub = { delay: number; activeDuration: number };

/**
 * Installs a Web Animations stub on the element the hook will attach to.
 * `null` timings mean "this element is not animating", which is the shape the
 * reduced-motion path produces (`animation: none`).
 */
function stubAnimations(element: HTMLElement, timings: readonly TimingStub[]): void {
  element.getAnimations = () =>
    timings.map(
      (timing) =>
        ({
          effect: { getComputedTiming: () => timing },
        }) as unknown as Animation,
    );
}

function Harness({
  timings,
  enabled = true,
}: {
  timings: readonly TimingStub[] | null;
  enabled?: boolean;
}) {
  const setInertRef = useTransparentPhaseInert(enabled);
  return (
    <div
      data-testid="surface"
      ref={(element) => {
        if (element && timings) stubAnimations(element, timings);
        setInertRef(element);
      }}
    >
      <button type="button" data-testid="control">
        Submit
      </button>
    </div>
  );
}

const surfaceOf = (container: HTMLElement): HTMLElement => {
  const surface = container.querySelector('[data-testid="surface"]');
  if (!(surface instanceof HTMLElement)) throw new Error('harness surface was not rendered');
  return surface;
};

describe('useTransparentPhaseInert', () => {
  afterEach(cleanup);

  it('makes an entering subtree inert before it can be painted or focused', () => {
    // A 100ms delay + 350ms fade under `both` fill is the shipped Hub composer
    // shape: opacity 0 is painted backwards through the delay. The attribute
    // must be present as soon as the ref attaches - waiting for `animationstart`
    // would leave the delay window, which is the largest part of the gap.
    const { container } = render(<Harness timings={[{ delay: 100, activeDuration: 350 }]} />);
    const surface = surfaceOf(container);

    expect(
      surface.hasAttribute('inert'),
      'the transparent phase must not be reachable by Tab',
    ).toBe(true);
  });

  it('releases the subtree when the entrance ends', () => {
    // The guarantee is worthless - and actively harmful - if it never lifts:
    // an entrance that stays inert is a permanently unusable control.
    const { container } = render(<Harness timings={[{ delay: 100, activeDuration: 350 }]} />);
    const surface = surfaceOf(container);
    expect(surface.hasAttribute('inert')).toBe(true);

    surface.dispatchEvent(new Event('animationend'));

    expect(
      surface.hasAttribute('inert'),
      'the surface must be keyboard-reachable once it is visible',
    ).toBe(false);
  });

  it('releases the subtree when the entrance is cancelled mid-flight', () => {
    // A class change or media-query flip can remove a running animation. That
    // must land on the interactive side, never leave the boundary stuck inert.
    const { container } = render(<Harness timings={[{ delay: 100, activeDuration: 350 }]} />);
    const surface = surfaceOf(container);
    expect(surface.hasAttribute('inert')).toBe(true);

    surface.dispatchEvent(new Event('animationcancel'));

    expect(surface.hasAttribute('inert')).toBe(false);
  });

  it('never gates a surface that is not animating', () => {
    // `prefers-reduced-motion` coherence, case 1. WorkspaceTransition's reduced
    // -motion path is `animation: none`, so there is no animation to find. The
    // surface must be interactive from the very first frame - the reduced-motion
    // user must not be handed a control that is invisible to the keyboard.
    const { container } = render(<Harness timings={[]} />);

    expect(
      surfaceOf(container).hasAttribute('inert'),
      'reduced motion collapses the animation and must not leave a control inert',
    ).toBe(false);
  });

  it('never gates a surface whose animation is collapsed to a sub-millisecond flash', () => {
    // `prefers-reduced-motion` coherence, case 2. entrance.css collapses to
    // `animation-delay: 0ms` + `animation-duration: 0.01ms`. That animation
    // technically exists but is over before it could gate anything, and pairing
    // it with `inert` would risk stranding the surface if `animationend` were
    // missed. Below the 1ms threshold the hook declines to gate at all.
    const { container } = render(<Harness timings={[{ delay: 0, activeDuration: 0.01 }]} />);

    expect(surfaceOf(container).hasAttribute('inert')).toBe(false);
  });

  it('fails open when the Web Animations API is unavailable', () => {
    // An environment without `getAnimations` must yield an interactive surface,
    // never a permanently inert one: an unusable control is a worse failure
    // than a briefly focusable transparent one.
    const { container } = render(<Harness timings={null} />);

    expect(surfaceOf(container).hasAttribute('inert')).toBe(false);
  });

  it('does not gate when explicitly disabled', () => {
    const { container } = render(
      <Harness timings={[{ delay: 100, activeDuration: 350 }]} enabled={false} />,
    );

    expect(surfaceOf(container).hasAttribute('inert')).toBe(false);
  });

  it('gates the whole subtree, not just the animated element', () => {
    // `inert` applies to the subtree, which is why the hook attaches to the
    // animated ancestor: one attribute covers every control inside it with no
    // per-control bookkeeping. This pins the structural reason the composer's
    // prompt input and toolbar are covered by a ref on the card.
    const { container } = render(<Harness timings={[{ delay: 100, activeDuration: 350 }]} />);
    const surface = surfaceOf(container);
    const control = container.querySelector('[data-testid="control"]');

    expect(control).not.toBeNull();
    expect(
      control instanceof HTMLElement && surface.contains(control),
      'the gated boundary must be an ancestor of the controls it protects',
    ).toBe(true);
    expect(surface.hasAttribute('inert')).toBe(true);
  });
});
