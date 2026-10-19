// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { UpdateConnectionFailure, UpdateConnectionReport } from '@readable-studio/contracts';
import { UpdateSection } from '../../src/components/UpdateSection';
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

it('explains a daemon-side timeout with the limit in seconds', async () => {
  setup(async () => Response.json(failed('timeout', { timeoutMs: 25_000 })));
  const button = await mount();
  await act(async () => fireEvent.click(button));
  expect(panel()!.querySelector('[role="alert"]')?.textContent).toContain(text('update.connection.failure.timeout', { seconds: 25 }));
});

it('ends on its own when the daemon never answers', async () => {
  setup((init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  const button = await mount();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fireEvent.click(button);
  expect(panel()?.getAttribute('data-update-connection')).toBe('checking');
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(panel()?.getAttribute('data-update-connection')).toBe('failed');
  expect(panel()!.querySelector('[role="alert"]')?.textContent).toContain(text('update.connection.failure.timeout', { seconds: 25 }));
  expect(screen.getByRole('button', { name: ko['update.connect'] })).toBeTruthy();
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
