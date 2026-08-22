// Compatibility identity helpers for the disabled analytics provider.
//
// The upstream implementation persisted analytics anonymous/session IDs in
// localStorage and sessionStorage. This fork keeps the exported functions for
// existing call sites but returns fixed disabled markers and writes nothing.

import type { AnalyticsClientType } from '@readable-studio/contracts/analytics';
import { detectReadableStudioHostClientType } from '@readable-studio/host';

export function getAnonymousId(): string {
  return 'telemetry-disabled';
}

export function getSessionId(): string {
  return 'telemetry-disabled';
}

export function detectClientType(): AnalyticsClientType {
  if (typeof window === 'undefined') return 'web';
  return detectReadableStudioHostClientType();
}

export function detectLaunchSource():
  | 'direct'
  | 'deeplink'
  | 'reload'
  | 'unknown' {
  if (typeof window === 'undefined') return 'unknown';
  try {
    const entries = performance.getEntriesByType?.(
      'navigation',
    ) as PerformanceNavigationTiming[] | undefined;
    const nav = entries?.[0];
    if (nav?.type === 'reload' || nav?.type === 'back_forward') return 'reload';
    if (window.location.pathname && window.location.pathname !== '/') {
      return 'deeplink';
    }
    return 'direct';
  } catch {
    return 'unknown';
  }
}
