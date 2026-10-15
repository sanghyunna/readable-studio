import { expect, it, vi } from 'vitest';
import { installOfflineCdnHooks } from '../src/main/offline-cdn.js';

it('installs once on default and design sessions and redirects without changing documents', async () => {
  const hooks = [vi.fn(), vi.fn()];
  const sessions = hooks.map(onBeforeRequest => ({ webRequest: { onBeforeRequest } }));
  const electronSessions = { defaultSession: sessions[0], fromPartition: vi.fn(() => sessions[1]) };
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ lib: 'fontawesome', major: 6, path: 'css/all.min.css' })));
  const dispose = installOfflineCdnHooks(electronSessions, 'persist:design', async () => ({ webOrigin: 'http://127.0.0.1:17573', apiOrigin: 'http://127.0.0.1:17456' }), fetchImpl);
  expect(electronSessions.fromPartition).toHaveBeenCalledWith('persist:design');
  for (const hook of hooks) {
    expect(hook).toHaveBeenCalledTimes(1);
    const callback = vi.fn();
    await hook.mock.calls[0][1]({ url: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css' }, callback);
    expect(callback).toHaveBeenCalledWith({ redirectURL: 'http://127.0.0.1:17573/offline-cdn/fontawesome/6/css/all.min.css' });
  }
  dispose();
  expect(hooks.every(hook => hook.mock.calls[1][1] === null)).toBe(true);
});
it('leaves unsupported URLs and unavailable infrastructure alone, logging failures', async () => {
  const onBeforeRequest = vi.fn();
  const target = { webRequest: { onBeforeRequest } };
  const fetchImpl = vi.fn(async () => new Response('null'));
  const dispose = installOfflineCdnHooks({ defaultSession: target, fromPartition: () => target }, 'design', async () => ({ webOrigin: 'readable-studio://app/', apiOrigin: 'http://127.0.0.1:1234' }), fetchImpl);
  expect(onBeforeRequest).toHaveBeenCalledTimes(1);
  const callback = vi.fn();
  await onBeforeRequest.mock.calls[0][1]({ url: 'https://unpkg.com/tailwindcss' }, callback);
  expect(callback).toHaveBeenCalledWith({});
  fetchImpl.mockRejectedValueOnce(new Error('offline'));
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await onBeforeRequest.mock.calls[0][1]({ url: 'https://unpkg.com/chart.js' }, callback);
  expect(log).toHaveBeenCalled(); expect(callback).toHaveBeenLastCalledWith({});
  log.mockRestore(); dispose();
});

it('restricts thumbnail traffic to daemon and resolved offline resources without changing the main session', async () => {
  const onBeforeRequest = vi.fn();
  const target = { webRequest: { onBeforeRequest } };
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ lib: 'chartjs', major: 4, path: 'chart.js' })));
  const dispose = installOfflineCdnHooks(
    { defaultSession: target, fromPartition: () => target }, 'thumbnail',
    async () => ({ webOrigin: 'http://127.0.0.1:17573', apiOrigin: 'http://127.0.0.1:17456' }),
    fetchImpl, { restrictToOrigins: true },
  );
  const callback = vi.fn();
  const handler = onBeforeRequest.mock.calls[0][1];
  await handler({ url: 'https://example.com/tracker' }, callback);
  expect(callback).toHaveBeenLastCalledWith({ cancel: true });
  await handler({ url: 'http://127.0.0.1:17456/pages/cover.html' }, callback);
  expect(callback).toHaveBeenLastCalledWith({});
  await handler({ url: 'https://unpkg.com/chart.js' }, callback);
  expect(callback).toHaveBeenLastCalledWith({ redirectURL: 'http://127.0.0.1:17573/offline-cdn/chartjs/4/chart.js' });
  await handler({ url: 'http://127.0.0.1:17573/offline-cdn/chartjs/4/chart.js' }, callback);
  expect(callback).toHaveBeenLastCalledWith({});
  expect(fetchImpl).toHaveBeenCalledOnce();
  dispose();
});
