import type { Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import { closeHttpServer, parseDaemonCliStartupArgs } from '../src/daemon-startup.js';

it('lets slow active HTTP work drain after five seconds without delaying an early close', async () => {
  vi.useFakeTimers();
  try {
    let closed!: () => void;
    const closeAllConnections = vi.fn();
    const server = {
      listening: true,
      close: (done: () => void) => { closed = done; },
      closeIdleConnections: vi.fn(),
      closeAllConnections,
    } as unknown as Server;
    const pending = closeHttpServer(server);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(closeAllConnections).not.toHaveBeenCalled();
    closed();
    await pending;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closeAllConnections).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

describe('daemon startup CLI parsing', () => {
  it('parses the documented daemon startup flags', () => {
    expect(parseDaemonCliStartupArgs(['--host', '0.0.0.0', '--port', '8123', '--no-open'], {})).toEqual({
      ok: true,
      config: {
        host: '0.0.0.0',
        open: false,
        port: 8123,
      },
    });
  });

  it('uses environment defaults when startup flags are omitted', () => {
    expect(parseDaemonCliStartupArgs([], { READABLE_BIND_HOST: '127.0.0.2', READABLE_PORT: '7345' })).toEqual({
      ok: true,
      config: {
        host: '127.0.0.2',
        open: true,
        port: 7345,
      },
    });
  });

  it('rejects browser snapshot instead of treating it as daemon startup', () => {
    expect(parseDaemonCliStartupArgs(['browser', 'snapshot', '--url', 'https://example.test/'], {})).toEqual({
      ok: false,
      kind: 'error',
      message: 'unknown command: readable browser',
    });
  });

  it('rejects unknown daemon startup options', () => {
    expect(parseDaemonCliStartupArgs(['--url', 'https://example.test/'], {})).toEqual({
      ok: false,
      kind: 'error',
      message: 'unknown option: --url',
    });
  });

  it('rejects flag-shaped values for required daemon startup options', () => {
    expect(parseDaemonCliStartupArgs(['--host', '--no-open'], {})).toEqual({
      ok: false,
      kind: 'error',
      message: '--host requires an address',
    });
    expect(parseDaemonCliStartupArgs(['--port', '--no-open'], {})).toEqual({
      ok: false,
      kind: 'error',
      message: '--port requires a port',
    });
  });
});
