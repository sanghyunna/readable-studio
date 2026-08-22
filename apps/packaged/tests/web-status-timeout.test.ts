/**
 * Regression coverage for the packaged launcher's web sidecar status
 * wait budget in apps/packaged/src/sidecars.ts.
 *
 * Background: the portable packaged app hung at the splash on cold first
 * launch. The web sidecar (apps/web/sidecar/server.ts) has its own
 * internal readiness budget (120s) for first-boot standalone Next.js
 * compiles, but the launcher waited for the web IPC status with the
 * default 35-second daemon budget and no exit watch. When the launcher's
 * web wait is shorter than the sidecar's internal readiness, the
 * launcher gives up first and the internal budget is useless. The web
 * wait now uses a strictly-longer default (180s) so the launcher never
 * abandons the sidecar before it is ready.
 *
 * @see apps/packaged/src/sidecars.ts
 * @see apps/web/sidecar/server.ts
 */
import { describe, expect, it } from 'vitest';

import { resolveWebStatusTimeoutMs } from '../src/sidecars.js';

describe('resolveWebStatusTimeoutMs', () => {
  it('uses the default 180-second budget when READABLE_WEB_STATUS_TIMEOUT_MS is unset', () => {
    expect(resolveWebStatusTimeoutMs({})).toBe(180_000);
  });

  it('is strictly longer than the web sidecar 120s internal readiness budget', () => {
    // The launcher must wait longer than the sidecar's own readiness
    // window, otherwise it abandons a still-compiling web child.
    expect(resolveWebStatusTimeoutMs({})).toBeGreaterThan(120_000);
  });

  it('honors a valid positive-integer READABLE_WEB_STATUS_TIMEOUT_MS override', () => {
    expect(
      resolveWebStatusTimeoutMs({ READABLE_WEB_STATUS_TIMEOUT_MS: '240000' }),
    ).toBe(240_000);
  });

  it('falls back to the default when READABLE_WEB_STATUS_TIMEOUT_MS is zero', () => {
    expect(
      resolveWebStatusTimeoutMs({ READABLE_WEB_STATUS_TIMEOUT_MS: '0' }),
    ).toBe(180_000);
  });

  it('falls back to the default when READABLE_WEB_STATUS_TIMEOUT_MS is non-numeric', () => {
    expect(
      resolveWebStatusTimeoutMs({ READABLE_WEB_STATUS_TIMEOUT_MS: 'abc' }),
    ).toBe(180_000);
  });

  it('treats an empty READABLE_WEB_STATUS_TIMEOUT_MS as unset', () => {
    expect(
      resolveWebStatusTimeoutMs({ READABLE_WEB_STATUS_TIMEOUT_MS: '' }),
    ).toBe(180_000);
  });

  it('falls back to process.env when called with no argument', () => {
    const original = process.env.READABLE_WEB_STATUS_TIMEOUT_MS;
    try {
      delete process.env.READABLE_WEB_STATUS_TIMEOUT_MS;
      expect(resolveWebStatusTimeoutMs()).toBe(180_000);
      process.env.READABLE_WEB_STATUS_TIMEOUT_MS = '300000';
      expect(resolveWebStatusTimeoutMs()).toBe(300_000);
    } finally {
      if (original == null) {
        delete process.env.READABLE_WEB_STATUS_TIMEOUT_MS;
      } else {
        process.env.READABLE_WEB_STATUS_TIMEOUT_MS = original;
      }
    }
  });
});
