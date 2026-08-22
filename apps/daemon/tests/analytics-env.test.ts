import { describe, expect, it } from 'vitest';

describe('analytics disabled environment', () => {
  it('reports analytics disabled in public config even when POSTHOG_KEY is set', async () => {
    const { readPublicConfigResponse } = await import('../src/analytics.js');

    expect(readPublicConfigResponse({
      POSTHOG_KEY: 'phc_test',
    })).toEqual({
      enabled: false,
      env: 'disabled',
      key: null,
      host: null,
    });
  });

  it('returns a no-op analytics service even when POSTHOG_KEY is set', async () => {
    const { createAnalyticsService } = await import('../src/analytics.js');
    const analytics = createAnalyticsService({
      dataDir: '/tmp/readable-studio-test',
      env: {
        POSTHOG_KEY: 'phc_test',
      },
    });

    expect(() =>
      analytics.capture({
        eventName: 'unit_event',
        appVersion: '1.2.3',
        context: {
          deviceId: 'device-1',
          sessionId: 'session-1',
          clientType: 'web',
          locale: 'en',
          requestId: null,
        },
        insertId: 'insert-1',
        properties: {},
      }),
    ).not.toThrow();
    await expect(analytics.captureSafety({
      eventName: 'unit_safety',
      appVersion: '1.2.3',
      properties: {},
    })).resolves.toBeUndefined();
    await expect(analytics.shutdown()).resolves.toBeUndefined();
  });
});
