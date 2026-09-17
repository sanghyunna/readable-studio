// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as config from '../../src/state/config';
import { useLowSpecProfile } from '../../src/state/useLowSpecProfile';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute(config.PERFORMANCE_PROFILE_ATTRIBUTE);
  localStorage.clear();
});

describe('effective profile reader', () => {
  it.each(['full', 'low'] as const)('reacts to live root changes when mounted in %s', async (initial) => {
    // Given subscribers reading the effective stamp, not persisted storage.
    config.applyPerformanceProfileToDocument(initial);
    const first = renderHook(() => useLowSpecProfile());
    const second = renderHook(() => useLowSpecProfile());
    expect(first.result.current).toBe(initial === 'low');
    // When the root changes without rerendering either subscriber.
    await act(async () => { config.applyPerformanceProfileToDocument(initial === 'low' ? 'full' : 'low'); });
    // Then both subscribers observe the same effective profile.
    expect(first.result.current).toBe(initial !== 'low');
    expect(second.result.current).toBe(first.result.current);
  });

  it('disconnects the root observer when its subscriber unmounts', () => {
    // Given a mounted profile subscriber.
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const { unmount } = renderHook(() => useLowSpecProfile());
    // When the subscriber leaves.
    unmount();
    // Then its observation resource is released.
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it.each([
    { stamp: 'low', expected: true },
    { stamp: 'full', expected: false },
    { stamp: 'LOW', expected: false },
    { stamp: '', expected: false },
  ])('returns $expected when the root stamp is $stamp', ({ stamp, expected }) => {
    // Given the existing effective profile stamp.
    document.documentElement.setAttribute(config.PERFORMANCE_PROFILE_ATTRIBUTE, stamp);
    // When a continuous producer reads the profile.
    const low = config.isLowSpecProfile();
    // Then only the low sentinel enables gating.
    expect(low).toBe(expected);
  });

  it('uses full when the stamp is absent even if persisted storage is stale low', () => {
    // Given the full-mode root and stale storage not yet reconciled by the app.
    localStorage.setItem('readable-studio:config', JSON.stringify({ performanceProfile: 'low' }));
    // When the effective profile is read.
    const low = config.isLowSpecProfile();
    // Then consumers obey the root, without duplicating persistence.
    expect(low).toBe(false);
  });
});
