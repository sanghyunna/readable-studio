// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UpdateLaunchBanner, UpdateSection } from '../../src/components/UpdateSection';
import { readFileSync } from 'node:fs';

vi.mock('../../src/i18n', () => ({ useI18n: () => ({ locale: 'ko', t: (key: string, vars?: Record<string, string>) => `${key}${vars ? ':' + Object.values(vars).join(',') : ''}` }) }));
vi.mock('../../src/components/databricks/DatabricksLoginButton', () => ({ DatabricksLoginButton: () => null }));
const idle = { state: 'idle', received: 0, total: 0, version: null, error: null };
const partial = { ...idle, version: '1.3.4', releaseUrl: 'https://updates.databricksapps.com', received: 5, total: 10 };
class Events {
  static instances: Events[] = [];
  onmessage?: (event: { data: string }) => void;
  closed = false;
  close() { this.closed = true; }
  constructor() { Events.instances.push(this); }
  static send(value: unknown) {
    for (const instance of [...Events.instances]) if (!instance.closed) instance.onmessage?.({ data: JSON.stringify(value) });
  }
}
function setup(status: object) {
  Events.instances = [];
  const fetcher = vi.fn(async (url: string) => Response.json(url === '/api/update/status' ? status
    : url === '/api/version' ? { version: { version: '1.3.3' } }
    : url === '/api/app-config' ? { config: { autoUpdate: { enabled: true, serverUrl: partial.releaseUrl } } }
    : { unavailable: 'no-release' }));
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('EventSource', Events);
  return fetcher;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it.each(['update-in-progress', 'unreachable'])('R9 residual keeps another card finishing after request rejection %s', async (reason) => {
  const ready = { ...partial, state: 'ready', received: 10 };
  const fetcher = setup(ready);
  const original = fetcher.getMockImplementation()!;
  let rejectRequest!: (value: Response) => void;
  fetcher.mockImplementation(url => url === '/api/update/apply'
    ? new Promise<Response>(resolve => { rejectRequest = resolve; }) : original(url));
  await act(async () => render(<><UpdateLaunchBanner ready /><UpdateSection currentVersion="1.3.3" /></>));
  fireEvent.click(screen.getAllByRole('button', { name: 'update.restart' })[1]!);
  act(() => Events.send({ ...ready, extraction: { completed: 10, total: 10, completedBytes: 100, totalBytes: 100 } }));
  act(() => Events.send(ready));
  await act(async () => rejectRequest(Response.json({ error: reason }, { status: reason === 'update-in-progress' ? 409 : 503 })));
  const observer = document.querySelector('aside')!;
  expect(observer.querySelector('[data-applying]')).not.toBeNull();
  expect(observer.querySelector('[data-phase="finishing"]')).not.toBeNull();
  expect(observer.querySelector('button')?.disabled).toBe(true);
  expect(observer.querySelector('[role="alert"]')).toBeNull();
  if (reason === 'update-in-progress') {
    expect(screen.getAllByRole('button', { name: 'update.applyingAction' })).toHaveLength(2);
  }
});

it.each(['hub', 'settings', 'cli'])('R8-02 keeps both observers finishing after apply from %s and resets on failure', async (origin) => {
  const ready = { ...partial, state: 'ready', received: 10 };
  const fetcher = setup(ready);
  await act(async () => { render(<><UpdateLaunchBanner ready /><UpdateSection currentVersion="1.3.3" /></>); });
  expect(screen.getAllByRole('button', { name: 'update.restart' })).toHaveLength(2);
  if (origin !== 'cli') {
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: 'update.restart' })[origin === 'hub' ? 0 : 1]!));
  }
  act(() => Events.send({ ...ready, extraction: { completed: 2, total: 10, completedBytes: 20, totalBytes: 100 } }));
  expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  act(() => Events.send({ ...ready, extraction: { completed: 10, total: 10, completedBytes: 100, totalBytes: 100 } }));
  act(() => Events.send(ready));
  expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  for (const bar of screen.getAllByRole('progressbar')) {
    expect(bar.getAttribute('value')).toBe('100');
    expect(bar.parentElement?.getAttribute('data-phase')).toBe('finishing');
    expect(bar.parentElement?.textContent).toContain('update.extractedFiles:10');
  }
  for (const button of screen.getAllByRole('button', { name: 'update.applyingAction' })) expect(button.hasAttribute('disabled')).toBe(true);
  expect(screen.queryByRole('button', { name: 'update.restart' })).toBeNull();
  act(() => Events.send({ ...ready, state: 'failed', error: 'disk-extract-failed' }));
  expect(document.querySelector('[data-applying]')).toBeNull();
  act(() => Events.send(ready));
  expect(screen.getAllByRole('button', { name: 'update.restart' })).toHaveLength(2);
  expect(screen.queryByRole('progressbar')).toBeNull();
  act(() => Events.send({ ...ready, extraction: { completed: 0, total: 10, completedBytes: 0, totalBytes: 100 } }));
  for (const bar of screen.getAllByRole('progressbar')) {
    expect(bar.getAttribute('value')).toBe('0');
    expect(bar.parentElement?.getAttribute('data-phase')).toBe('extracting');
  }
  act(() => Events.send(idle));
  expect(document.querySelector('[data-applying]')).toBeNull();
  act(() => Events.send(ready));
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.getAllByRole('button', { name: 'update.restart' })).toHaveLength(2);
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/update/apply')).toHaveLength(origin === 'cli' ? 0 : 1);
});

it('wraps Hub error messages without clipping or ellipsis', () => {
  const style = document.createElement('style');
  style.textContent = readFileSync('src/components/UpdateSection.module.css', 'utf8');
  document.head.append(style);
  const view = render(<aside className="banner"><div className="summary"><span data-update-message>error</span></div></aside>);
  try {
    const computed = getComputedStyle(screen.getByText('error'));
    expect(computed.whiteSpace).toBe('normal');
    expect(computed.textOverflow).not.toBe('ellipsis');
    expect(computed.overflow).not.toBe('hidden');
  } finally { style.remove(); view.unmount(); }
});

it.each(['version', 'digest'])('retains rollback history, dismisses Hub once, permits retry, and offers a new %s', async (replacement) => {
  const failedApply = { id: 'rollback-1', version: '1.3.4', sha256: 'a'.repeat(64), releaseUrl: partial.releaseUrl };
  const status = { ...idle, state: 'failed', error: 'apply-rolled-back', failedApply };
  const fetcher = setup(status);
  const original = fetcher.getMockImplementation()!;
  const offer = { current: '1.3.3', latest: failedApply.version, isNewer: true, sha256: failedApply.sha256, releaseUrl: partial.releaseUrl, assetSize: 10 };
  fetcher.mockImplementation(async (url) => url.startsWith('/api/update/check') ? Response.json(offer) : original(url));
  let view = render(<><UpdateLaunchBanner ready /><UpdateSection currentVersion="1.3.3" /></>);
  await act(async () => {});
  expect(screen.getAllByText('update.rolledBack:1.3.4')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'update.dismiss' }));
  expect(document.querySelector('aside')).toBeNull();
  view.unmount();
  await act(async () => { view = render(<><UpdateLaunchBanner ready /><UpdateSection currentVersion="1.3.3" /></>); });
  expect(document.querySelector('aside')).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.check' })));
  expect(document.querySelector('aside')).toBeNull();
  expect(screen.getByText('update.rolledBack:1.3.4')).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.retry' })));
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/update/download')).toHaveLength(1);
  if (replacement === 'version') offer.latest = '1.3.5';
  else offer.sha256 = 'b'.repeat(64);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.check' })));
  expect(document.querySelector('aside')).not.toBeNull();
  act(() => Events.send({ ...idle, failedApply, discardedDownload: { id: 'later-withdrawal', version: '1.3.5' } }));
  expect(document.querySelector('aside')?.textContent).toContain('update.discarded:1.3.5');
});

it.each(['hub', 'settings'])('formats small progress in KB and removes ready progress in %s', async (surface) => {
  setup({ ...partial, state: 'downloading', received: 512, total: 2048 });
  await act(async () => { render(surface === 'hub' ? <UpdateLaunchBanner ready /> : <UpdateSection currentVersion="1.3.3" />); });
  expect(screen.getByText('0.5 / 2.0 KB · 25%')).toBeTruthy();
  act(() => Events.send({ ...partial, state: 'ready', received: 2048, total: 2048 }));
  expect(screen.getByRole('button', { name: 'update.restart' })).toBeTruthy();
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByText(/KB ·/)).toBeNull();
});

it.each(['hub', 'settings'])('tracks externally resumed partial downloads through ready and later changes in %s', async (surface) => {
  const fetcher = setup(partial);
  await act(async () => { render(surface === 'hub' ? <UpdateLaunchBanner ready /> : <UpdateSection currentVersion="1.3.3" />); });
  expect(screen.getByRole('button', { name: 'update.resume' })).toBeTruthy();
  act(() => Events.send({ ...partial, state: 'downloading', received: 7 }));
  expect(screen.getByRole('button', { name: 'update.cancel' })).toBeTruthy();
  act(() => Events.send({ ...partial, state: 'ready', received: 10 }));
  expect(screen.queryByRole('button', { name: 'update.resume' })).toBeNull();
  const restart = screen.getByRole('button', { name: 'update.restart' });
  await act(async () => fireEvent.click(restart));
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/update/download')).toHaveLength(0);
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/update/apply')).toHaveLength(1);
  act(() => Events.send({ ...partial, state: 'downloading', received: 8 }));
  expect(screen.getByRole('button', { name: 'update.cancel' })).toBeTruthy();
});

it('shows the discarded version on both surfaces and remembers Hub dismissal across remounts and checks', async () => {
  const discardedDownload = { id: 'withdrawal-1', version: '1.3.4' };
  setup({ ...idle, discardedDownload });
  const view = render(<><UpdateLaunchBanner ready /><UpdateSection currentVersion="1.3.3" /></>);
  await act(async () => {});
  expect(screen.getAllByText('update.discarded:1.3.4')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'update.dismiss' }));
  expect(document.querySelector('aside')).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.check' })));
  expect(document.querySelector('aside')).toBeNull();
  expect(screen.getByText('update.discarded:1.3.4')).toBeTruthy();
  view.unmount();
  await act(async () => { render(<UpdateLaunchBanner ready />); });
  expect(document.querySelector('aside')).toBeNull();
  act(() => Events.send({ ...idle, discardedDownload: { ...discardedDownload, id: 'withdrawal-2' } }));
  expect(screen.getByText('update.discarded:1.3.4')).toBeTruthy();
});
