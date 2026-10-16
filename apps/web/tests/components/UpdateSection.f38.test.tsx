// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UpdateLaunchBanner, UpdateSection } from '../../src/components/UpdateSection';
import { I18nProvider } from '../../src/i18n';
import { getKo } from '../../src/i18n/locales/ko';
import { readFileSync } from 'node:fs';

vi.mock('../../src/components/databricks/DatabricksLoginButton', () => ({ DatabricksLoginButton: () => null }));
const ko = getKo();
const offer = { current: '1.3.3', latest: '1.3.4', isNewer: true, sha256: 'a'.repeat(64), releaseUrl: 'https://updates.databricksapps.com', assetSize: 1000 };
const idle = { state: 'idle', received: 0, total: 0, version: null, error: null };
const ready = { ...idle, state: 'ready', version: offer.latest, releaseUrl: offer.releaseUrl, received: 1000, total: 1000 };
class Events {
  static current: Events;
  onmessage?: (event: { data: string }) => void;
  constructor() { Events.current = this; }
  close() {}
  send(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
function setup(status: object = ready) {
  const fetcher = vi.fn(async (url: string, _options?: RequestInit): Promise<Response> => Response.json(
    url === '/api/update/status' ? status : url === '/api/version' ? { version: { version: offer.current } }
      : url === '/api/app-config' ? { config: { autoUpdate: { enabled: false, serverUrl: offer.releaseUrl } } }
        : url.startsWith('/api/update/check') ? offer : {}));
  vi.stubGlobal('fetch', fetcher); vi.stubGlobal('EventSource', Events);
  return fetcher;
}
async function mount() {
  await act(async () => render(<I18nProvider initial="ko"><UpdateLaunchBanner ready /></I18nProvider>));
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it('Q12E-01 uses only byte percentage while a large file is still being extracted', async () => {
  setup(); await mount();
  for (const completedBytes of [108, 379]) {
    act(() => Events.current.send({ ...ready, extraction: { completed: 13, total: 24642, completedBytes, totalBytes: 1000 } }));
    const bar = screen.getByRole('progressbar');
    expect(bar.parentElement?.textContent).toContain(`${completedBytes / 10}%`);
    expect(bar.parentElement?.textContent).not.toContain('13 /');
    expect(bar.getAttribute('aria-label')).toBe(bar.parentElement?.textContent);
  }
});
it('Q12E-02 shows exactly one completed phase label', async () => {
  setup(); await mount();
  act(() => Events.current.send({ ...ready, extraction: { completed: 24642, total: 24642, completedBytes: 1000, totalBytes: 1000 } }));
  const block = screen.getByRole('progressbar').parentElement!;
  expect(block.querySelectorAll('span')).toHaveLength(1);
  expect(block.textContent).not.toContain('압축을 푸는 중');
  expect(block.textContent).toContain('24,642');
});
it('Q12E-03 marks finishing as busy with motion that honours reduced and low performance modes', async () => {
  setup(); await mount();
  act(() => Events.current.send({ ...ready, extraction: { completed: 10, total: 10 } }));
  const block = screen.getByRole('progressbar').parentElement!;
  expect(block.getAttribute('aria-busy')).toBe('true');
  expect(block.getAttribute('data-working')).toBe('true');
  const css = readFileSync('src/components/UpdateSection.module.css', 'utf8');
  expect(css).toMatch(/data-working/);
  expect(css).toMatch(/prefers-reduced-motion/);
  expect(css).toMatch(/data-performance-profile/);
});
it.each(['hub', 'settings'])('Q12E-05 shows indeterminate progress from click through zero bytes in %s', async (surface) => {
  const fetcher = setup(idle);
  const original = fetcher.getMockImplementation()!;
  let finish!: (response: Response) => void;
  fetcher.mockImplementation((url, options) => url === '/api/update/download' ? new Promise<Response>(resolve => { finish = resolve; }) : original(url, options));
  await act(async () => render(<I18nProvider initial="ko">{surface === 'hub' ? <UpdateLaunchBanner ready /> : <UpdateSection currentVersion={offer.current} />}</I18nProvider>));
  if (surface === 'settings') await act(async () => fireEvent.click(screen.getByRole('button', { name: ko['update.check'] })));
  fireEvent.click(screen.getByRole('button', { name: ko['update.download'] }));
  try {
    expect(screen.getByRole('progressbar').hasAttribute('value')).toBe(false);
  } finally {
    await act(async () => finish(Response.json({ ...ready, state: 'downloading', received: 0 })));
  }
  expect(screen.getByRole('progressbar').hasAttribute('value')).toBe(false);
  act(() => Events.current.send({ ...ready, state: 'downloading', received: 100 }));
  expect(screen.getByRole('progressbar').getAttribute('value')).toBe('100');
});
it('Q12E-07 gives one identical current result for empty and current servers after enabling', async () => {
  const fetcher = setup(idle);
  const original = fetcher.getMockImplementation()!;
  let empty = true;
  fetcher.mockImplementation((url, options) => url.startsWith('/api/update/check')
    ? Promise.resolve(Response.json(empty ? { unavailable: 'no-release' } : { ...offer, isNewer: false }))
    : original(url, options));
  await act(async () => render(<I18nProvider initial="ko"><UpdateSection currentVersion={offer.current} /></I18nProvider>));
  await act(async () => fireEvent.click(screen.getByRole('switch')));
  expect(screen.queryByText(ko['update.connected'])).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  const result = screen.getByRole('status').textContent;
  empty = false;
  await act(async () => fireEvent.click(screen.getByRole('button', { name: ko['update.check'] })));
  expect(screen.getByRole('status').textContent).toBe(result);
});
it('R9-01 clears passive finishing when authoritative ready status carries apply failure', async () => {
  setup(); await mount();
  act(() => Events.current.send({ ...ready, extraction: { completed: 10, total: 10 } }));
  act(() => Events.current.send({ ...ready, error: 'helper-not-acknowledged' }));
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.getByRole('button', { name: ko['update.restart'] }).hasAttribute('disabled')).toBe(false);
  expect(screen.getByRole('alert').textContent).toBe(ko['update.reason.helper-not-acknowledged']);
});

it('R11-01 retains authoritative failure and restart after checking the same release', async () => {
  const fetcher = setup({ ...ready, error: 'helper-not-acknowledged' });
  const original = fetcher.getMockImplementation()!;
  let finishCheck!: (response: Response) => void;
  fetcher.mockImplementation((url, options) => url.startsWith('/api/update/check')
    ? new Promise<Response>(resolve => { finishCheck = resolve; }) : original(url, options));
  await act(async () => render(<I18nProvider initial="ko"><UpdateSection currentVersion={offer.current} /></I18nProvider>));
  expect(screen.getByRole('button', { name: ko['update.restart'] }).hasAttribute('disabled')).toBe(false);
  expect(screen.getByRole('alert').textContent).toBe(ko['update.reason.helper-not-acknowledged']);
  fireEvent.click(screen.getByRole('button', { name: ko['update.check'] }));
  expect(screen.queryByRole('button', { name: ko['update.restart'] })).toBeNull();
  await act(async () => finishCheck(Response.json(offer)));
  expect(screen.getByRole('alert').textContent).toBe(ko['update.reason.helper-not-acknowledged']);
  expect(screen.getByRole('button', { name: ko['update.restart'] }).hasAttribute('disabled')).toBe(false);
  expect(screen.queryByRole('button', { name: ko['update.download'] })).toBeNull();
});

it.each([
  { ...offer, latest: '1.3.5' },
  { ...offer, releaseUrl: 'https://other.databricksapps.com' },
])('R11-01 does not inherit failure for a different version or source: %j', async (replacement) => {
  const fetcher = setup({ ...ready, error: 'helper-not-acknowledged' });
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, options) => url.startsWith('/api/update/check')
    ? Promise.resolve(Response.json(replacement)) : original(url, options));
  await act(async () => render(<I18nProvider initial="ko"><UpdateSection currentVersion={offer.current} /></I18nProvider>));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: ko['update.check'] })));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: ko['update.restart'] })).toBeNull();
  expect(screen.getByRole('button', { name: ko['update.download'] })).toBeTruthy();
});

it('R11-02 keeps the native extraction range below completion until files are complete', async () => {
  setup(); await mount();
  act(() => Events.current.send({ ...ready, extraction: { completed: 9, total: 10, completedBytes: 10000, totalBytes: 10000 } }));
  const bar = screen.getByRole('progressbar') as HTMLProgressElement;
  expect(bar.value / bar.max).toBeLessThan(1);
  expect(bar.value / bar.max).toBeCloseTo(0.999);
  expect(bar.getAttribute('aria-label')).toBe(bar.parentElement?.textContent);
  expect(bar.parentElement?.getAttribute('data-phase')).toBe('extracting');
  act(() => Events.current.send({ ...ready, extraction: { completed: 10, total: 10, completedBytes: 10000, totalBytes: 10000 } }));
  expect(bar.value / bar.max).toBe(1);
  expect(bar.parentElement?.getAttribute('data-phase')).toBe('finishing');
});

it.each([9996, 10000])('R10-03 keeps incomplete extraction below 100 percent at %s bytes', async (completedBytes) => {
  setup(); await mount();
  act(() => Events.current.send({ ...ready, extraction: { completed: 9, total: 10, completedBytes, totalBytes: 10000 } }));
  const bar = screen.getByRole('progressbar');
  expect(bar.parentElement?.getAttribute('data-phase')).toBe('extracting');
  expect(bar.parentElement?.textContent).not.toContain('100%');
  expect(bar.parentElement?.textContent).toContain('99.9%');
  expect(bar.getAttribute('aria-label')).toBe(bar.parentElement?.textContent);
  expect(bar.getAttribute('value')).toBe(String(Math.min(completedBytes, 9990)));
});

it.each(['manual', 'enable'])('R10-04 uses checked running version without About metadata on %s', async (action) => {
  const fetcher = setup(idle);
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, options) => url.startsWith('/api/update/check')
    ? Promise.resolve(Response.json({ ...offer, current: '1.3.5', latest: '1.3.4', isNewer: false }))
    : original(url, options));
  await act(async () => render(<I18nProvider initial="ko"><UpdateSection currentVersion={null} /></I18nProvider>));
  await act(async () => fireEvent.click(action === 'enable' ? screen.getByRole('switch') : screen.getByRole('button', { name: ko['update.check'] })));
  expect(screen.getByRole('status').textContent).toBe(ko['update.upToDate'].replace('{version}', '1.3.5'));
});
