// @vitest-environment jsdom
//
// Telemetry-removal regression test. Client-side telemetry network egress is
// hard-removed in this fork: `getAnalyticsClient` is a permanent no-op that
// returns null without loading an analytics SDK or fetching daemon config.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('client analytics: telemetry egress removed', () => {
  const originalFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchSpy = vi.fn(async () => new Response('not found', { status: 404 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('never fetches the analytics config and returns null', async () => {
    const { getAnalyticsClient } = await import('../src/analytics/client');
    const client = await getAnalyticsClient({
      anonymousId: 'anon-1',
      sessionId: 'sess-1',
      clientType: 'web',
      locale: 'en',
      appVersion: '1.2.3',
    });

    expect(client).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
