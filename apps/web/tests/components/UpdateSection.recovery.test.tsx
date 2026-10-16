// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UpdateLaunchBanner } from '../../src/components/UpdateSection';

vi.mock('../../src/i18n', () => ({ useI18n: () => ({ locale: 'en', t: (key: string, vars?: Record<string, string>) => `${key}${vars ? ':' + Object.values(vars).join('|') : ''}` }) }));
vi.mock('../../src/components/databricks/DatabricksLoginButton', () => ({ DatabricksLoginButton: () => null }));
const ready = { state: 'ready', version: '1.3.4', releaseUrl: 'https://updates.databricksapps.com', received: 10, total: 10, error: null };
const rollback = { state: 'idle', version: null, received: 0, total: 0, error: null, failedApply: { id: 'rollback', version: ready.version, releaseUrl: ready.releaseUrl, sha256: 'a'.repeat(64) } };
class Events {
  static current: Events;
  onmessage?: (event: { data: string }) => void;
  constructor() { Events.current = this; }
  close() {}
  send(status: object) { this.onmessage?.({ data: JSON.stringify(status) }); }
}
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}
function setup(status: object) {
  const fetcher = vi.fn(async (url: string): Promise<Response> => Response.json(
    url === '/api/version' ? { version: { version: '1.3.3' } }
      : url === '/api/update/status' ? status
      : { unavailable: 'disabled' }));
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('EventSource', Events);
  return fetcher;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it.each(['ready', 'rollback'])('shows %s with unknown running version and retries once on status events', async (kind) => {
  const status = kind === 'ready' ? ready : rollback;
  const fetcher = setup(status);
  const original = fetcher.getMockImplementation()!;
  const retry = deferred();
  let versionCalls = 0;
  fetcher.mockImplementation(url => url === '/api/version'
    ? ++versionCalls === 1 ? Promise.reject(new Error('offline')) : retry.promise
    : original(url));
  await act(async () => render(<UpdateLaunchBanner ready />));
  if (kind === 'ready') expect(screen.getByRole('button', { name: 'update.restart' })).toBeTruthy();
  else expect(screen.getByRole('button', { name: 'update.dismiss' })).toBeTruthy();
  act(() => Events.current.send(status));
  expect(versionCalls).toBe(2);
  act(() => Events.current.send(status));
  expect(versionCalls).toBe(2);
  await act(async () => retry.resolve(Response.json({ version: { version: '1.3.4' } })));
  expect(document.querySelector('aside')).toBeNull();
  act(() => Events.current.send(status));
  expect(versionCalls).toBe(2);
});

it('adopts current version from a later status after unreadable version JSON', async () => {
  const fetcher = setup(ready);
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(url => url === '/api/version' ? Promise.resolve(new Response('{')) : original(url));
  await act(async () => render(<UpdateLaunchBanner ready />));
  expect(screen.getByRole('button', { name: 'update.restart' })).toBeTruthy();
  await act(async () => Events.current.send(ready));
  await act(async () => Events.current.send(ready));
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/version')).toHaveLength(2);
  act(() => Events.current.send({ ...ready, current: '1.3.4' }));
  expect(document.querySelector('aside')).toBeNull();
});

it('adopts current version from a later shared check result', async () => {
  const fetcher = setup(ready);
  const original = fetcher.getMockImplementation()!;
  const version = deferred();
  fetcher.mockImplementation(url => url === '/api/version' ? version.promise : original(url));
  await act(async () => render(<UpdateLaunchBanner ready />));
  expect(screen.getByRole('button', { name: 'update.restart' })).toBeTruthy();
  // A remounted sibling performs a check and publishes its current version.
  fetcher.mockImplementation(url => url.startsWith('/api/update/check')
    ? Promise.resolve(Response.json({ current: '1.3.4', latest: '1.3.4', isNewer: false }))
    : url === '/api/version' ? version.promise : original(url));
  await act(async () => render(<UpdateLaunchBanner ready />));
  expect(document.querySelector('aside')).toBeNull();
  await act(async () => version.resolve(new Response('{')));
});

it('keeps an external apply observer finishing until a failure resets it', async () => {
  setup(ready);
  await act(async () => render(<UpdateLaunchBanner ready />));
  act(() => Events.current.send({ ...ready, extraction: { completed: 1, total: 10 } }));
  expect(document.querySelector('[data-applying]')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'update.later' })).toBeNull();
  act(() => Events.current.send(ready));
  expect(document.querySelector('[data-applying]')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'update.applyingAction' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('progressbar').parentElement?.getAttribute('data-phase')).toBe('finishing');
  act(() => Events.current.send({ ...ready, state: 'failed', error: 'helper-not-acknowledged' }));
  act(() => Events.current.send(ready));
  expect(document.querySelector('[data-applying]')).toBeNull();
  expect(screen.getByRole('button', { name: 'update.restart' }).hasAttribute('disabled')).toBe(false);
  expect(screen.getByRole('button', { name: 'update.later' })).toBeTruthy();
  expect(screen.queryByRole('progressbar')).toBeNull();
});

it('keeps a local pending apply active when extraction clears, then recovers on rejection', async () => {
  const fetcher = setup(ready);
  const original = fetcher.getMockImplementation()!;
  const apply = deferred();
  fetcher.mockImplementation(url => url === '/api/update/apply' ? apply.promise : original(url));
  await act(async () => render(<UpdateLaunchBanner ready />));
  fireEvent.click(screen.getByRole('button', { name: 'update.restart' }));
  act(() => Events.current.send({ ...ready, extraction: { completed: 10, total: 10 } }));
  act(() => Events.current.send(ready));
  expect(document.querySelector('[data-applying]')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'update.later' })).toBeNull();
  await act(async () => apply.resolve(Response.json({ error: 'helper-not-acknowledged' }, { status: 500 })));
  expect(screen.getByRole('button', { name: 'update.restart' }).hasAttribute('disabled')).toBe(false);
  expect(screen.getByRole('button', { name: 'update.later' })).toBeTruthy();
});
