// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PetSpriteFace } from '../../src/components/pet/PetSpriteFace';
import type { ResolvedPet } from '../../src/components/pet/pets';
import { applyPerformanceProfileToDocument, PERFORMANCE_PROFILE_ATTRIBUTE } from '../../src/state/config';

const pet: ResolvedPet = {
  id: 'atlas', name: 'Atlas', glyph: 'P', accent: '#123456', greeting: 'Hi',
  animation: 'float', imageUrl: '/pet.png',
  atlas: {
    cols: 3, rows: 2,
    rowsDef: [
      { id: 'idle', index: 0, frames: 3, fps: 10 },
      { id: 'waving', index: 1, frames: 3, fps: 10 },
    ],
  },
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.documentElement.removeAttribute(PERFORMANCE_PROFILE_ATTRIBUTE);
});

describe('pet atlas profile', () => {
  it('keeps the selected row visible without timers when low', () => {
    // Given a low-profile document and an animated atlas.
    document.documentElement.setAttribute(PERFORMANCE_PROFILE_ATTRIBUTE, 'low');
    // When the selected row mounts.
    const { container } = render(<PetSpriteFace active={pet} rowId="waving" />);
    // Then the first frame of that row stays visible without JS work.
    expect(vi.getTimerCount()).toBe(0);
    expect(container.querySelector<HTMLElement>('.atlas')?.style.backgroundPosition).toBe('0% 100%');
    expect(container.querySelector<HTMLElement>('.atlas')?.style.backgroundImage).toContain('/pet.png');
  });

  it('advances atlas frames when full', () => {
    // Given a full-profile animated atlas.
    document.documentElement.setAttribute(PERFORMANCE_PROFILE_ATTRIBUTE, 'full');
    const { container } = render(<PetSpriteFace active={pet} />);
    expect(vi.getTimerCount()).toBe(1);
    // When one frame interval elapses.
    act(() => vi.advanceTimersByTime(100));
    // Then the next atlas frame is displayed.
    expect(container.querySelector<HTMLElement>('.atlas')?.style.backgroundPosition).toBe('50% 0%');
  });

  it('resets the frame and releases the old timer when the next row starts in low', () => {
    // Given an atlas already playing in full mode.
    const { container, rerender } = render(<PetSpriteFace active={pet} />);
    act(() => vi.advanceTimersByTime(100));
    document.documentElement.setAttribute(PERFORMANCE_PROFILE_ATTRIBUTE, 'low');
    // When the interaction selects another row.
    rerender(<PetSpriteFace active={pet} rowId="waving" />);
    // Then the row changes but frame production stops.
    expect(vi.getTimerCount()).toBe(0);
    expect(container.querySelector<HTMLElement>('.atlas')?.style.backgroundPosition).toBe('0% 100%');
  });

  it.each(['full', 'low'] as const)('honours both live toggles without changing the row when mounted in %s', async (initial) => {
    // Given the same mounted atlas and row throughout both transitions.
    applyPerformanceProfileToDocument(initial);
    const { container } = render(<PetSpriteFace active={pet} rowId="waving" />);
    const profiles = initial === 'full' ? ['low', 'full'] as const : ['full', 'low'] as const;
    for (const profile of profiles) {
      // When the owner changes only the effective profile.
      await act(async () => { applyPerformanceProfileToDocument(profile); });
      // Then frame production stops or resumes without a parent rerender.
      expect(vi.getTimerCount()).toBe(profile === 'low' ? 0 : 1);
      act(() => vi.advanceTimersByTime(100));
      expect(container.querySelector<HTMLElement>('.atlas')?.style.backgroundPosition)
        .toBe(profile === 'low' ? '0% 100%' : '50% 100%');
    }
  });

  it('releases the frame timer when unmounted in full', () => {
    // Given a playing atlas.
    const { unmount } = render(<PetSpriteFace active={pet} />);
    // When its surface closes.
    unmount();
    // Then no frame producer survives.
    expect(vi.getTimerCount()).toBe(0);
  });
});
