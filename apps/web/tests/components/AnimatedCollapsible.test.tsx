// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AnimatedCollapsible } from '../../src/components/AnimatedCollapsible';

function isInSequentialFocusOrder(element: HTMLElement): boolean {
  return element.tabIndex >= 0 && element.closest('[inert]') === null;
}

afterEach(cleanup);

describe('AnimatedCollapsible shared interaction contract', () => {
  it('removes closed descendants from tab and role access, then restores both when open', () => {
    const { rerender } = render(
      <AnimatedCollapsible open={false} className="accordion-collapsible">
        <button type="button">Shared action</button>
      </AnimatedCollapsible>,
    );

    const mountedButton = screen.getByRole('button', {
      name: 'Shared action',
      hidden: true,
    });
    expect(mountedButton.closest('[inert]')).not.toBeNull();
    expect(isInSequentialFocusOrder(mountedButton)).toBe(false);
    expect(screen.queryByRole('button', { name: 'Shared action' })).toBeNull();

    rerender(
      <AnimatedCollapsible open className="accordion-collapsible">
        <button type="button">Shared action</button>
      </AnimatedCollapsible>,
    );

    const exposedButton = screen.getByRole('button', { name: 'Shared action' });
    expect(exposedButton.closest('[inert]')).toBeNull();
    expect(isInSequentialFocusOrder(exposedButton)).toBe(true);
  });
});
