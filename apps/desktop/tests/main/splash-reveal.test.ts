import { describe, expect, test } from 'vitest';

import {
  remainingSplashHoldMs,
  shouldFinishSplashPolling,
} from '../../src/main/splash-reveal.js';

describe('shouldFinishSplashPolling', () => {
  test('waits when the app mounts before the splash finishes', () => {
    expect(
      shouldFinishSplashPolling({
        appMounted: true,
        deadlineReached: false,
        splashFinished: false,
      }),
    ).toBe(false);
  });

  test('waits when the splash finishes before the app mounts', () => {
    expect(
      shouldFinishSplashPolling({
        appMounted: false,
        deadlineReached: false,
        splashFinished: true,
      }),
    ).toBe(false);
  });

  test('finishes after both app and splash are ready', () => {
    expect(
      shouldFinishSplashPolling({
        appMounted: true,
        deadlineReached: false,
        splashFinished: true,
      }),
    ).toBe(true);
  });

  test('finishes at the hard deadline when neither signal arrives', () => {
    expect(
      shouldFinishSplashPolling({
        appMounted: false,
        deadlineReached: true,
        splashFinished: false,
      }),
    ).toBe(true);
  });
});

describe('remainingSplashHoldMs', () => {
  test('retains the minimum floor after media failure', () => {
    expect(remainingSplashHoldMs(1_000, 6_000, 6_800)).toBe(1_800);
  });

  test('does not add delay after the minimum floor', () => {
    expect(remainingSplashHoldMs(1_000, 8_000, 6_800)).toBe(0);
  });
});
