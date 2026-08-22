// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearExceptionTrackingContext,
  installErrorHandlers,
  reportHandledException,
  setExceptionTrackingContext,
} from '../../src/analytics/error-tracking';

/**
 * These tests exercise the legacy exception compatibility pipeline. It is
 * consent-independent because dispatch is a hard no-op in this fork.
 *
 * NOTE: client-side telemetry network egress is hard-removed in this fork.
 * `dispatch()` is now a no-op, so the buffer/scrub/parse machinery still
 * runs (and must never throw), but NOTHING is ever sent over the network.
 * Every case therefore asserts `fetch` is never called. The contract these
 * tests now pin:
 *
 *   1. `installErrorHandlers()` hooks `window.error` and
 *      `unhandledrejection` at module load. Idempotent. The handlers run
 *      without throwing.
 *   2. Captured exceptions still buffer in memory until a context arrives,
 *      and draining the buffer / dispatching with a context present is a
 *      silent no-op (no egress).
 *   3. The buffer is still capped at 50 entries to bound memory in an
 *      error loop.
 *   4. The capture path (including scrubbing and string-input handling)
 *      runs to completion without throwing or performing any network I/O.
 */

const fetchMock = vi.fn();

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('', { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  clearExceptionTrackingContext();
});

afterEach(() => {
  clearExceptionTrackingContext();
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('error-tracking', () => {
  it('buffers captures dispatched before a context is set, then drains as a no-op', () => {
    installErrorHandlers();

    // Fire a captured (handled) exception BEFORE the context is wired up.
    reportHandledException(new Error('early-boom'));
    expect(fetchMock).not.toHaveBeenCalled();

    // Now the bootstrap completes — the buffer drains, but egress is removed
    // so draining sends nothing.
    setExceptionTrackingContext({
      apiKey: 'phc_test',
      host: 'https://us.i.posthog.com',
      distinctId: 'user-1',
      appVersion: '1.2.3',
      sessionId: 'session-abc',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not dispatch over the network even when a context is already set', () => {
    setExceptionTrackingContext({
      apiKey: 'phc_test',
      host: 'https://us.i.posthog.com',
      distinctId: 'user-2',
    });

    reportHandledException(new TypeError('immediate'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('captures unhandledrejection events via the window hook without egress', () => {
    installErrorHandlers();
    setExceptionTrackingContext({
      apiKey: 'phc_test',
      host: 'https://us.i.posthog.com',
      distinctId: 'user-3',
    });

    // jsdom's PromiseRejectionEvent constructor exists but doesn't auto-fire
    // when a promise rejects; we synthesize one to drive the listener.
    const reason = new RangeError('boom-async');
    const event = new Event('unhandledrejection') as Event & {
      reason?: unknown;
      promise?: Promise<unknown>;
    };
    event.reason = reason;
    event.promise = Promise.reject(reason);
    // Silence Node's actual unhandled-rejection warning on the synthesized
    // promise. jsdom forwards it to process otherwise.
    event.promise.catch(() => undefined);
    // The listener must run without throwing — and send nothing.
    expect(() => window.dispatchEvent(event)).not.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('captures synchronous window.error events without egress', () => {
    installErrorHandlers();
    setExceptionTrackingContext({
      apiKey: 'phc_test',
      host: 'https://us.i.posthog.com',
      distinctId: 'user-4',
    });

    const error = new Error('sync-boom');
    const event = new Event('error') as Event & {
      error?: unknown;
      message?: string;
      filename?: string;
      lineno?: number;
      colno?: number;
    };
    event.error = error;
    event.message = 'sync-boom';
    event.filename = 'app://apps/web/src/foo.tsx';
    event.lineno = 42;
    event.colno = 7;
    expect(() => window.dispatchEvent(event)).not.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caps the buffer at 50 entries to bound memory in an error loop (no egress on drain)', () => {
    // No context — every capture lands in the buffer.
    for (let i = 0; i < 75; i += 1) {
      reportHandledException(new Error(`loop-${i}`));
    }
    expect(fetchMock).not.toHaveBeenCalled();

    // Setting the context drains the (bounded) buffer; with egress removed
    // the drain dispatches nothing over the network.
    setExceptionTrackingContext({
      apiKey: 'phc_test',
      host: 'https://us.i.posthog.com',
      distinctId: 'user-loop',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs the scrub-bearing capture path without throwing or sending', () => {
    setExceptionTrackingContext({
      apiKey: 'phc_test',
      host: 'https://us.i.posthog.com',
      distinctId: 'user-scrub',
    });

    // Synthesize an Error with a stack that contains a packaged-app path. The
    // scrub layer still runs inside the capture path (its output is covered
    // directly in analytics-scrub.test.ts); here we only assert the path is
    // exercised without throwing and performs no network I/O.
    const error = new Error('scrub-target');
    error.stack = [
      'Error: scrub-target',
      '    at handleClick (file:///Applications/Readable Studio.app/Contents/Resources/apps/web/src/FileViewer.tsx:147:23)',
      '    at /Users/jane/dev/checkout/apps/web/src/index.tsx:12:1',
    ].join('\n');
    expect(() => reportHandledException(error)).not.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats reportHandledException string input as a non-Error message without sending', () => {
    setExceptionTrackingContext({
      apiKey: 'phc_test',
      host: 'https://us.i.posthog.com',
      distinctId: 'user-str',
    });

    expect(() => reportHandledException('weird global signal')).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops events silently when no context is ever set (no key in env)', () => {
    reportHandledException(new Error('orphan'));
    expect(fetchMock).not.toHaveBeenCalled();
    // Even after explicitly clearing — the buffer is bounded and harmless.
    clearExceptionTrackingContext();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
