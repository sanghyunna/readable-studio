// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UpdateLaunchBanner, UpdateSection } from '../../src/components/UpdateSection';

vi.mock('../../src/i18n', () => ({ useI18n: () => ({ locale: 'ko', t: (key: string) => key }) }));
vi.mock('../../src/components/databricks/DatabricksLoginButton', () => ({ DatabricksLoginButton: () => null }));
const idle = { state: 'idle', received: 0, total: 0, version: null, error: null };
const current = { current: '1.3.4', latest: '1.3.4', isNewer: false };
function setup(result: object | Promise<Response>) {
  const fetcher = vi.fn(async (url: string) => {
    if (url.startsWith('/api/update/check')) return result instanceof Promise ? result : Response.json(result);
    if (url === '/api/version') return Response.json({ version: { version: '1.3.4' } });
    if (url === '/api/app-config') return Response.json({ config: { autoUpdate: { enabled: true, serverUrl: 'https://updates.example' } } });
    return Response.json(idle);
  });
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('EventSource', undefined);
  return fetcher;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(['unreachable', 'invalid-response', 'not-logged-in', 'app-not-accessible', 'forbidden', 'timeout'])('offers compact setup after a startup %s failure', async (unavailable) => {
  const fetcher = setup({ unavailable });
  const openSettings = vi.fn();
  await act(async () => render(<UpdateLaunchBanner ready setupVisible onOpenUpdateSettings={openSettings} />));
  const toast = screen.getByRole('status');
  expect(toast.classList.contains('readable-toast')).toBe(true);
  expect(screen.getByText('update.setupFailed')).toBeTruthy();
  expect(document.querySelector('aside')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'update.enableAutomatic' }));
  expect(openSettings).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('update.setupFailed')).toBeNull();
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/update/check?automatic=1')).toHaveLength(1);
  expect(fetcher.mock.calls.some(([url]) => url === '/api/app-config')).toBe(false);
});

it.each([{ unavailable: 'disabled' }, { unavailable: 'not-configured' }, { unavailable: 'no-release' }, current])('does not invite setup without a failed server check: %j', async (result) => {
  setup(result);
  await act(async () => render(<UpdateLaunchBanner ready setupVisible onOpenUpdateSettings={vi.fn()} />));
  expect(screen.queryByText('update.setupFailed')).toBeNull();
  expect(screen.queryByRole('button', { name: 'update.enableAutomatic' })).toBeNull();
});

it('waits for the startup check and keeps that check alive off the main screen', async () => {
  let finish!: (response: Response) => void;
  const fetcher = setup(new Promise<Response>((resolve) => { finish = resolve; }));
  const openSettings = vi.fn();
  const view = await act(async () => render(<UpdateLaunchBanner ready setupVisible={false} onOpenUpdateSettings={openSettings} />));
  expect(screen.queryByRole('status')).toBeNull();
  await act(async () => finish(Response.json({ unavailable: 'unreachable' })));
  expect(screen.queryByRole('status')).toBeNull();
  view.rerender(<UpdateLaunchBanner ready setupVisible onOpenUpdateSettings={openSettings} />);
  expect(screen.getByRole('button', { name: 'update.enableAutomatic' })).toBeTruthy();
  expect(fetcher.mock.calls.filter(([url]) => url.startsWith('/api/update/check'))).toHaveLength(1);
});

it('does not repeat a dismissed startup toast after route changes', async () => {
  vi.useFakeTimers();
  setup({ unavailable: 'unreachable' });
  const openSettings = vi.fn();
  const view = await act(async () => render(<UpdateLaunchBanner ready setupVisible onOpenUpdateSettings={openSettings} />));
  act(() => vi.advanceTimersByTime(10_000));
  expect(screen.queryByText('update.setupFailed')).toBeNull();
  view.rerender(<UpdateLaunchBanner ready setupVisible={false} onOpenUpdateSettings={openSettings} />);
  view.rerender(<UpdateLaunchBanner ready setupVisible onOpenUpdateSettings={openSettings} />);
  expect(screen.queryByText('update.setupFailed')).toBeNull();
});

it('clears a startup failure when the existing Settings check succeeds', async () => {
  const fetcher = setup({ unavailable: 'unreachable' });
  await act(async () => render(<><UpdateLaunchBanner ready setupVisible onOpenUpdateSettings={vi.fn()} /><UpdateSection currentVersion="1.3.4" /></>));
  expect(screen.getByText('update.setupFailed')).toBeTruthy();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url) => url === '/api/update/check' ? Promise.resolve(Response.json(current)) : original(url));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.check' })));
  expect(screen.queryByText('update.setupFailed')).toBeNull();
});

it('does not turn a later manual check failure into a startup setup toast', async () => {
  const fetcher = setup(current);
  await act(async () => render(<><UpdateLaunchBanner ready setupVisible onOpenUpdateSettings={vi.fn()} /><UpdateSection currentVersion="1.3.4" /></>));
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url) => url === '/api/update/check' ? Promise.resolve(Response.json({ unavailable: 'unreachable' })) : original(url));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.check' })));
  expect(screen.getByRole('alert').textContent).toBe('update.reason.offline');
  expect(screen.queryByText('update.setupFailed')).toBeNull();
});

it('does not let a delayed startup failure overwrite a newer successful check', async () => {
  let finishStartup!: (response: Response) => void;
  const startup = new Promise<Response>((resolve) => { finishStartup = resolve; });
  const fetcher = setup(current);
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url) => url === '/api/update/check?automatic=1' ? startup : original(url));
  await act(async () => render(<><UpdateLaunchBanner ready setupVisible onOpenUpdateSettings={vi.fn()} /><UpdateSection currentVersion="1.3.4" /></>));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.check' })));
  await act(async () => finishStartup(Response.json({ unavailable: 'unreachable' })));
  expect(screen.queryByText('update.setupFailed')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('does not mistake a newer manual failure for the delayed startup response', async () => {
  let finishStartup!: (response: Response) => void;
  const startup = new Promise<Response>((resolve) => { finishStartup = resolve; });
  const fetcher = setup({ unavailable: 'unreachable' });
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url) => url === '/api/update/check?automatic=1' ? startup : original(url));
  await act(async () => render(<><UpdateLaunchBanner ready setupVisible onOpenUpdateSettings={vi.fn()} /><UpdateSection currentVersion="1.3.4" /></>));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.check' })));
  await act(async () => finishStartup(Response.json(current)));
  expect(screen.getByRole('alert').textContent).toBe('update.reason.offline');
  expect(screen.queryByText('update.setupFailed')).toBeNull();
});

it('clears a startup failure after saving a successfully checked server connection', async () => {
  const fetcher = setup({ unavailable: 'unreachable' });
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url) => url === '/api/update/connection'
    ? Promise.resolve(Response.json({ ok: true, serverUrl: 'https://updates.example', timeoutMs: 25000, elapsedMs: 1, steps: [] })) : original(url));
  await act(async () => render(<><UpdateLaunchBanner ready setupVisible onOpenUpdateSettings={vi.fn()} /><UpdateSection currentVersion="1.3.4" /></>));
  expect(screen.getByText('update.setupFailed')).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.connect' })));
  expect(screen.getByText('update.connection.ok')).toBeTruthy();
  expect(screen.queryByText('update.setupFailed')).toBeNull();
});

it.each([true, false])('only focuses the update server field when requested (%s)', async (focusServerUrl) => {
  setup(current);
  await act(async () => render(<UpdateSection currentVersion="1.3.4" focusServerUrl={focusServerUrl} />));
  expect(document.activeElement === screen.getByRole('textbox')).toBe(focusServerUrl);
});
