import { afterEach, expect, it, vi } from 'vitest';
import { runDatabricksCli } from '../src/databricks-cli.js';
import { ids, scan, status } from './databricks-surface-fixtures.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function fakeDeadlines() {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
    return controller.signal;
  });
}
function delayed(response: Response, ms: number, signal?: AbortSignal | null): Promise<Response> {
  return new Promise((resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    setTimeout(() => resolve(response), ms);
  });
}

it('accepts a slow daemon profile response instead of declaring the daemon unavailable', async () => {
  fakeDeadlines();
  const result = runDatabricksCli(['status', '--json'], { resolveDaemonUrl: async () => 'http://127.0.0.1:1234',
    stdout() {}, stderr() {}, fetch: async (_url, init) => delayed(Response.json(status), 31_000, init?.signal) });
  await vi.advanceTimersByTimeAsync(31_001);
  expect(await result).toEqual({ exitCode: 0 });
});

it('keeps following a scan that takes more than ten minutes', async () => {
  fakeDeadlines();
  const result = runDatabricksCli(['scan', '--profile', ids.profile, '--json'], { resolveDaemonUrl: async () => 'http://127.0.0.1:1234',
    stdout() {}, stderr() {}, fetch: async (url, init) => String(url).endsWith('/events')
      ? delayed(new Response(`data: ${JSON.stringify({ type: 'done', revision: 2, scan: scan() })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }), 11 * 60_000, init?.signal)
      : Response.json(scan('running', 1)) });
  await vi.advanceTimersByTimeAsync(11 * 60_000 + 1);
  expect(await result).toEqual({ exitCode: 0 });
});
