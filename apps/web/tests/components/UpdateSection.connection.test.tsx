// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { UpdateConnectionFailure, UpdateConnectionReport } from '@readable-studio/contracts';
import { UpdateLaunchBanner, UpdateSection } from '../../src/components/UpdateSection';
import { I18nProvider } from '../../src/i18n';
import { getKo } from '../../src/i18n/locales/ko';
import type { Dict } from '../../src/i18n/types';

vi.mock('../../src/components/databricks/DatabricksLoginButton', () => ({ DatabricksLoginButton: ({ host }: { host?: string }) => <button>login:{host}</button> }));
const ko = getKo();
const text = (key: string, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce((value, [name, replacement]) => value.split(`{${name}}`).join(String(replacement)), (ko as unknown as Record<string, string>)[key] ?? `<missing ${key}>`);
const serverUrl = 'https://updates-1.aws.databricksapps.com';
const workspace = 'https://adb-1.azuredatabricks.net';
const idle = { state: 'idle', received: 0, total: 0, version: null, error: null };
const steps: UpdateConnectionReport['steps'] = [
  { step: 'url', ok: true, detail: serverUrl, elapsedMs: 0 },
  { step: 'cli', ok: true, detail: 'C:\\app\\vendor\\databricks\\databricks.exe (bundled, v0.250.0)', elapsedMs: 140 },
  { step: 'health', ok: false, detail: 'GET /api/v1/health -> 503', elapsedMs: 380, httpStatus: 503 },
];
const success: UpdateConnectionReport = {
  ok: true, serverUrl, host: workspace, profile: 'DEFAULT', latest: '1.3.4', timeoutMs: 25_000, elapsedMs: 912,
  cli: { path: 'C:\\app\\vendor\\databricks\\databricks.exe', source: 'bundled', version: '0.250.0' },
  steps: [steps[0]!, steps[1]!, { step: 'health', ok: true, detail: 'GET /api/v1/health -> 200', elapsedMs: 300, httpStatus: 200 }],
};
const failed = (failure: UpdateConnectionFailure, extra: Partial<UpdateConnectionReport> = {}): UpdateConnectionReport =>
  ({ ok: false, serverUrl, failure, timeoutMs: 25_000, elapsedMs: 400, steps, ...extra });

function setup(connection: (init?: RequestInit) => Promise<Response>) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === '/api/update/connection') return connection(init);
    if (url === '/api/app-config') return Response.json(init?.method === 'PUT' ? { ok: true } : { config: { autoUpdate: { enabled: false, serverUrl: null } } });
    if (url === '/api/version') return Response.json({ version: { version: '1.3.3' } });
    return Response.json(idle);
  });
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
  return fetcher;
}
async function mount() {
  await act(async () => { render(<I18nProvider initial="ko"><UpdateSection currentVersion="1.3.3" /></I18nProvider>); });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: serverUrl } });
  return screen.getByRole('button', { name: ko['update.connect'] });
}
const panel = () => document.querySelector('[data-update-connection]') as HTMLElement | null;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('shows a disabled in-progress button and a visible indicator the instant it is pressed', async () => {
  let finish!: (response: Response) => void;
  setup(() => new Promise<Response>((resolve) => { finish = resolve; }));
  const button = await mount();
  fireEvent.click(button);
  const busy = screen.getByRole('button', { name: ko['update.connecting' as keyof Dict] });
  expect((busy as HTMLButtonElement).disabled).toBe(true);
  expect(busy.getAttribute('aria-busy')).toBe('true');
  expect(panel()?.getAttribute('data-update-connection')).toBe('checking');
  expect(panel()?.querySelector('progress')).toBeTruthy();
  expect(panel()?.textContent).toContain(text('update.connectingHint', { seconds: 25 }));
  await act(async () => finish(Response.json(success)));
  expect(screen.getByRole('button', { name: ko['update.connect'] })).toBeTruthy();
});

it.each([
  'invalid-url', 'not-https', 'dns', 'unreachable', 'cli-missing', 'not-logged-in', 'workspace-not-found',
  'forbidden', 'not-update-server', 'app-stopped', 'invalid-response',
] as const)('explains %s in Korean next to the button', async (failure) => {
  const fetcher = setup(async () => Response.json(failed(failure, failure === 'not-logged-in' ? { host: workspace } : {})));
  const button = await mount();
  await act(async () => fireEvent.click(button));
  const result = panel()!;
  expect(button.nextElementSibling).toBe(result);
  expect(result.getAttribute('data-update-connection')).toBe('failed');
  expect(result.querySelector('[role="alert"]')?.textContent).toContain(text(`update.connection.failure.${failure}`));
  expect(fetcher.mock.calls.some(([url, init]) => url === '/api/app-config' && init?.method === 'PUT')).toBe(false);
  if (failure === 'not-logged-in') expect(screen.getByRole('button', { name: `login:${workspace}` })).toBeTruthy();
});

it.each([25_000, 0])('explains a daemon-side timeout without inventing a %i ms discovery deadline', async (timeoutMs) => {
  setup(async () => Response.json(failed('timeout', { timeoutMs })));
  const button = await mount();
  await act(async () => fireEvent.click(button));
  expect(panel()!.querySelector('[role="alert"]')?.textContent).toContain(timeoutMs
    ? text('update.connection.failure.timeout', { seconds: timeoutMs / 1000 }) : ko['update.reason.timeout']);
});

it.each([31_000, 60_000])('waits for a successful discovery after %i ms without an arbitrary cutoff', async (delay) => {
  let signal: AbortSignal | undefined;
  const fetcher = setup((init) => new Promise<Response>((resolve, reject) => {
    signal = init?.signal ?? undefined;
    const timer = setTimeout(() => resolve(Response.json({ ...success, timeoutMs: 0, elapsedMs: delay })), delay);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    });
  }));
  const button = await mount();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fireEvent.click(button);
  await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
  expect(signal?.aborted).toBe(false);
  expect(panel()?.getAttribute('data-update-connection')).toBe('checking');
  expect(panel()?.querySelector('progress')?.getAttribute('aria-label')).toBe(ko['update.connecting']);
  expect(screen.getByRole('textbox').hasAttribute('disabled')).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(panel()?.getAttribute('data-update-connection')).toBe('ok');
  expect(screen.getByRole('button', { name: ko['update.connect'] })).toBeTruthy();
  expect(fetcher).toHaveBeenCalledWith('/api/app-config', expect.objectContaining({ method: 'PUT' }));
});

it('aborts the pending connection when Settings unmounts', async () => {
  let signal: AbortSignal | undefined;
  setup((init) => new Promise<Response>((_resolve, reject) => {
    signal = init?.signal ?? undefined;
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  const button = await mount();
  fireEvent.click(button);
  await act(async () => cleanup());
  expect(signal?.aborted).toBe(true);
});

it('aborts an edited URL request and ignores its late result', async () => {
  let signal: AbortSignal | undefined;
  let finish!: (response: Response) => void;
  const fetcher = setup((init) => new Promise<Response>((resolve) => {
    signal = init?.signal ?? undefined;
    finish = resolve;
  }));
  const button = await mount();
  fireEvent.click(button);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: `${serverUrl}/changed` } });
  expect(signal?.aborted).toBe(true);
  await act(async () => finish(Response.json(success)));
  expect(panel()).toBeNull();
  expect(screen.getByRole('button', { name: ko['update.connect'] }).hasAttribute('disabled')).toBe(false);
  expect(fetcher.mock.calls.some(([url, init]) => url === '/api/app-config' && init?.method === 'PUT')).toBe(false);
});

it.each(['close', 'edit'] as const)('cancels pending enable health on %s and never saves its late response', async (action) => {
  let signal: AbortSignal | undefined;
  let finish!: (response: Response) => void;
  const fetcher = setup(async () => Response.json(success));
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, init) => url === '/api/update/health'
    ? new Promise<Response>((resolve) => { signal = init?.signal ?? undefined; finish = resolve; }) : original(url, init));
  await mount();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fireEvent.click(screen.getByRole('switch'));
  await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  if (action === 'close') await act(async () => cleanup());
  else fireEvent.change(screen.getByRole('textbox'), { target: { value: `${serverUrl}/changed` } });
  expect(signal?.aborted).toBe(true);
  await act(async () => finish(Response.json({ ok: true })));
  expect(fetcher.mock.calls.some(([url, init]) => url === '/api/app-config' && init?.method === 'PUT')).toBe(false);
  if (action === 'edit') expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
});

it('aborts a pending manual check on close without publishing its late result', async () => {
  let signal: AbortSignal | undefined;
  let finish!: (response: Response) => void;
  const fetcher = setup(async () => Response.json(success));
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, init) => url === '/api/update/check'
    ? new Promise<Response>((resolve) => { signal = init?.signal ?? undefined; finish = resolve; })
    : url === '/api/app-config' && !init?.method
      ? Promise.resolve(Response.json({ config: { autoUpdate: { enabled: false, serverUrl } } })) : original(url, init));
  await mount();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fireEvent.click(screen.getByRole('button', { name: ko['update.check'] }));
  await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
  await act(async () => cleanup());
  expect(signal?.aborted).toBe(true);
  await act(async () => finish(Response.json({ current: '1.3.5', latest: '99.0.0', isNewer: true, releaseUrl: serverUrl, sha256: 'a'.repeat(64), assetSize: 10 })));
  await mount();
  expect(screen.queryByRole('button', { name: ko['update.download'] })).toBeNull();
});

it('keeps an already saved enable setting when its follow-up check is cancelled', async () => {
  let finish!: (response: Response) => void;
  const fetcher = setup(async () => Response.json(success));
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, init) => url === '/api/update/health' ? Promise.resolve(Response.json({ ok: true }))
    : url === '/api/update/check' ? new Promise<Response>((resolve) => { finish = resolve; }) : original(url, init));
  await mount();
  await act(async () => fireEvent.click(screen.getByRole('switch')));
  expect(fetcher).toHaveBeenCalledWith('/api/app-config', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ autoUpdate: { enabled: true, serverUrl } }) }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: `${serverUrl}/changed` } });
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  await act(async () => finish(Response.json({ unavailable: 'unreachable' })));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('keeps the global startup check independent when Settings closes', async () => {
  let startupSignal: AbortSignal | undefined;
  let connectSignal: AbortSignal | undefined;
  let finishStartup!: (response: Response) => void;
  const fetcher = setup((init) => new Promise<Response>((_resolve, reject) => {
    connectSignal = init?.signal ?? undefined;
    connectSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, init) => url === '/api/update/check?automatic=1'
    ? new Promise<Response>((resolve) => { startupSignal = init?.signal ?? undefined; finishStartup = resolve; }) : original(url, init));
  const launch = <UpdateLaunchBanner ready setupVisible onOpenUpdateSettings={vi.fn()} />;
  const view = await act(async () => render(<I18nProvider initial="ko">{launch}<UpdateSection currentVersion="1.3.5" /></I18nProvider>));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: serverUrl } });
  fireEvent.click(screen.getByRole('button', { name: ko['update.connect'] }));
  await act(async () => view.rerender(<I18nProvider initial="ko">{launch}</I18nProvider>));
  expect(connectSignal?.aborted).toBe(true);
  expect(startupSignal?.aborted ?? false).toBe(false);
  await act(async () => finishStartup(Response.json({ unavailable: 'unreachable' })));
  expect(screen.getByRole('button', { name: ko['update.enableAutomatic'] })).toBeTruthy();
});

it('aborts initial configuration loading when Settings closes after a long discovery', async () => {
  let signal: AbortSignal | undefined;
  let finish!: (response: Response) => void;
  const fetcher = setup(async () => Response.json(success));
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, init) => url === '/api/app-config' && !init?.method
    ? new Promise<Response>((resolve) => { signal = init?.signal ?? undefined; finish = resolve; }) : original(url, init));
  const view = await act(async () => render(<I18nProvider initial="ko"><UpdateSection currentVersion="1.3.5" /></I18nProvider>));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
  await act(async () => view.unmount());
  expect(signal?.aborted).toBe(true);
  await act(async () => finish(Response.json({ config: { autoUpdate: { enabled: true, serverUrl } } })));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(fetcher.mock.calls.some(([url, init]) => url === '/api/app-config' && init?.method === 'PUT')).toBe(false);
});

it('explains when the local service itself cannot be reached', async () => {
  setup(async () => { throw new TypeError('Failed to fetch'); });
  const button = await mount();
  await act(async () => fireEvent.click(button));
  expect(panel()!.querySelector('[role="alert"]')?.textContent).toContain(text('update.connection.failure.daemon-unreachable'));
});

it('summarises what success verified and saves the server', async () => {
  const fetcher = setup(async () => Response.json(success));
  const button = await mount();
  await act(async () => fireEvent.click(button));
  const result = panel()!;
  expect(result.getAttribute('data-update-connection')).toBe('ok');
  expect(result.getAttribute('role')).toBe('status');
  expect(result.textContent).toContain(text('update.connection.okServer'));
  expect(result.textContent).toContain(text('update.connection.okWorkspace', { host: workspace, profile: 'DEFAULT' }));
  expect(result.textContent).toContain(text('update.connection.okLatest', { version: '1.3.4' }));
  expect(fetcher).toHaveBeenCalledWith('/api/app-config', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ autoUpdate: { enabled: false, serverUrl } }) }));
});

it('says there is no release yet when the server has none', async () => {
  setup(async () => Response.json({ ...success, latest: null }));
  const button = await mount();
  await act(async () => fireEvent.click(button));
  expect(panel()!.textContent).toContain(text('update.connection.okNoRelease'));
});

it('keeps a collapsed step log that expands to each step, status and elapsed time', async () => {
  setup(async () => Response.json(failed('app-stopped')));
  const button = await mount();
  await act(async () => fireEvent.click(button));
  const details = panel()!.querySelector('details')!;
  expect(details.open).toBe(false);
  expect(details.querySelector('summary')?.textContent).toBe(text('update.connection.details'));
  fireEvent.click(details.querySelector('summary')!);
  expect(details.open).toBe(true);
  const items = [...details.querySelectorAll('li')].map((item) => item.textContent ?? '');
  expect(items).toHaveLength(3);
  expect(items[1]).toContain(text('update.connection.step.cli'));
  expect(items[1]).toContain('bundled');
  expect(items[2]).toContain(text('update.connection.step.health'));
  expect(items[2]).toContain('HTTP 503');
  expect(items[2]).toContain('380 ms');
  expect(items[2]).toContain(text('update.connection.stepFailed'));
});

it('clears an old result when the URL is edited', async () => {
  setup(async () => Response.json(failed('dns')));
  const button = await mount();
  await act(async () => fireEvent.click(button));
  expect(panel()).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: `${serverUrl}x` } });
  expect(panel()).toBeNull();
});
