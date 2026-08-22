// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualEditSnapGuides } from '../../src/components/ManualEditSnapGuides';
import type { ManualEditSnapGuide } from '../../src/edit-mode/movement-session';

afterEach(cleanup);

const NONE = { vertical: null, horizontal: null };

describe('ManualEditSnapGuides', () => {
  it('renders nothing when there are no guides', () => {
    const { container } = render(<ManualEditSnapGuides guides={NONE} scale={1} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a vertical guide scaled and offset', () => {
    const vertical: ManualEditSnapGuide = { axis: 'x', x1: 100, x2: 100, y1: 20, y2: 80 };
    const { container } = render(
      <ManualEditSnapGuides guides={{ vertical, horizontal: null }} scale={2} offsetX={10} offsetY={5} />,
    );
    const guide = container.querySelector('[data-testid="manual-edit-snap-guide"]') as HTMLElement;
    expect(guide.getAttribute('data-axis')).toBe('x');
    expect(guide.style.left).toBe('210px'); // 10 + 100 * 2
    expect(guide.style.top).toBe('45px'); // 5 + 20 * 2
    expect(guide.style.height).toBe('120px'); // (80 - 20) * 2
    expect(guide.style.width).toBe('1px');
  });

  it('renders a horizontal guide scaled and offset', () => {
    const horizontal: ManualEditSnapGuide = { axis: 'y', x1: 10, x2: 90, y1: 50, y2: 50 };
    const { container } = render(
      <ManualEditSnapGuides guides={{ vertical: null, horizontal }} scale={1.5} offsetX={4} offsetY={6} />,
    );
    const guide = container.querySelector('[data-testid="manual-edit-snap-guide"]') as HTMLElement;
    expect(guide.getAttribute('data-axis')).toBe('y');
    expect(guide.style.top).toBe('81px'); // 6 + 50 * 1.5
    expect(guide.style.left).toBe('19px'); // 4 + 10 * 1.5
    expect(guide.style.width).toBe('120px'); // (90 - 10) * 1.5
    expect(guide.style.height).toBe('1px');
  });

  it('renders both guides at once', () => {
    const vertical: ManualEditSnapGuide = { axis: 'x', x1: 100, x2: 100, y1: 0, y2: 40 };
    const horizontal: ManualEditSnapGuide = { axis: 'y', x1: 0, x2: 40, y1: 60, y2: 60 };
    const { container } = render(<ManualEditSnapGuides guides={{ vertical, horizontal }} scale={1} />);
    const guides = container.querySelectorAll('[data-testid="manual-edit-snap-guide"]');
    expect(Array.from(guides).map((g) => g.getAttribute('data-axis'))).toEqual(['x', 'y']);
  });

  it('falls back to scale 1 for non-positive scales', () => {
    const vertical: ManualEditSnapGuide = { axis: 'x', x1: 10, x2: 10, y1: 0, y2: 10 };
    const { container } = render(<ManualEditSnapGuides guides={{ vertical, horizontal: null }} scale={-2} />);
    const guide = container.querySelector('[data-testid="manual-edit-snap-guide"]') as HTMLElement;
    expect(guide.style.left).toBe('10px');
  });
});
