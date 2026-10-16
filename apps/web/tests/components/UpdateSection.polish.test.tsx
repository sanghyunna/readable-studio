// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UpdateLaunchBanner, UpdateSection } from '../../src/components/UpdateSection';

let locale = 'en';
vi.mock('../../src/i18n', () => ({ useI18n: () => ({ locale, t: (key: string, vars?: Record<string, string>) => `${key}${vars ? ':' + Object.values(vars).join('|') : ''}` }) }));
vi.mock('../../src/components/databricks/DatabricksLoginButton', () => ({ DatabricksLoginButton: () => null }));
const offer = { current: '1.3.3', latest: '1.3.4', isNewer: true, sha256: 'a'.repeat(64), releaseUrl: 'https://updates.databricksapps.com', assetSize: 10 };
const idle = { state: 'idle', received: 0, total: 0, version: null, error: null };
class Events {
  static current: Events;
  onmessage?: (event: { data: string }) => void;
  constructor() { Events.current = this; }
  close() {}
  send(status: object) { this.onmessage?.({ data: JSON.stringify(status) }); }
}
function setup(status: object = idle, current = offer.current) {
  const fetcher = vi.fn(async (url: string) => Response.json(url === '/api/version' ? { version: { version: current } }
    : url === '/api/update/status' ? status
    : url === '/api/app-config' ? { config: { autoUpdate: { enabled: true, serverUrl: offer.releaseUrl } } }
    : url.startsWith('/api/update/check') ? offer : {}));
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('EventSource', Events);
  return fetcher;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); locale = 'en'; });

it.each(['saved', 'empty', 'failed'])('R7-02 waits for successful configuration before missing URL guidance: %s', async (outcome) => {
  const fetcher = setup();
  const original = fetcher.getMockImplementation()!;
  let finish!: (response: Response) => void;
  fetcher.mockImplementation((url) => url === '/api/app-config'
    ? new Promise<Response>((resolve) => { finish = resolve; }) : original(url));
  await act(async () => render(<UpdateSection currentVersion={offer.current} />));
  expect.soft(screen.queryByText('update.serverHint')).toBeNull();
  await act(async () => finish(outcome === 'failed' ? Response.json({ error: 'unreachable' }, { status: 503 })
    : Response.json({ config: { autoUpdate: { enabled: false, serverUrl: outcome === 'saved' ? offer.releaseUrl : null } } })));
  if (outcome === 'empty') expect(screen.getByText('update.serverHint')).toBeTruthy();
  else expect(screen.queryByText('update.serverHint')).toBeNull();
  if (outcome === 'failed') expect(screen.getByRole('alert').textContent).toBe('update.reason.offline');
  if (outcome === 'saved') expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(offer.releaseUrl);
});

it('does not show missing URL guidance when checking a saved server after clearing the draft', async () => {
  const fetcher = setup();
  await act(async () => render(<UpdateSection currentVersion={offer.current} />));
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(offer.releaseUrl);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
  expect.soft(screen.queryByText('update.serverHint')).toBeNull();
  const check = screen.getByRole('button', { name: 'update.check' });
  expect(check.hasAttribute('disabled')).toBe(false);
  await act(async () => fireEvent.click(check));
  expect(fetcher).toHaveBeenCalledWith('/api/update/check', {});
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/app-config')).toHaveLength(1);
  expect(screen.queryByText('update.serverHint')).toBeNull();
});

it('removes missing URL guidance while first-enable health verification is pending', async () => {
  const fetcher = setup();
  const original = fetcher.getMockImplementation()!;
  let finish!: (response: Response) => void;
  fetcher.mockImplementation((url) => url === '/api/app-config'
    ? Promise.resolve(Response.json({ config: { autoUpdate: { enabled: false, serverUrl: null } } }))
    : url === '/api/update/health' ? new Promise<Response>((resolve) => { finish = resolve; }) : original(url));
  await act(async () => render(<UpdateSection currentVersion={offer.current} />));
  expect(screen.getByText('update.serverHint')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: offer.releaseUrl } });
  fireEvent.click(screen.getByRole('switch'));
  expect(document.querySelector('[data-update-automatic-status]')).toBeTruthy();
  try { expect(screen.queryByText('update.serverHint')).toBeNull(); }
  finally { await act(async () => finish(Response.json({}))); }
});

it.each(['hub', 'settings'])('keeps a neutral disabled apply action across phases in %s', async (surface) => {
  const ready = { ...idle, state: 'ready', version: offer.latest, releaseUrl: offer.releaseUrl };
  setup(ready);
  await act(async () => render(surface === 'hub' ? <UpdateLaunchBanner ready /> : <UpdateSection currentVersion={offer.current} />));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.restart' })));
  for (const extraction of [undefined, { completed: 1, total: 10 }, { completed: 10, total: 10 }]) {
    if (extraction) act(() => Events.current.send({ ...ready, extraction }));
    const button = screen.getByRole('button', { name: 'update.applyingAction' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  }
});

it.each(['hub', 'settings'])('retains completed extraction at 100 percent during finishing in %s', async (surface) => {
  const ready = { ...idle, state: 'ready', version: offer.latest, releaseUrl: offer.releaseUrl };
  setup(ready);
  await act(async () => render(surface === 'hub' ? <UpdateLaunchBanner ready /> : <UpdateSection currentVersion={offer.current} />));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.restart' })));
  for (const extraction of [{ completed: 10, total: 10 }, undefined]) {
    act(() => Events.current.send({ ...ready, extraction }));
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('value')).toBe('10');
    expect(bar.getAttribute('max')).toBe('10');
    expect(bar.parentElement?.getAttribute('data-phase')).toBe('finishing');
  }
});

it.each(['1.3.4', '1.3.5'])('never flashes an installed SSE offer while the first check is pending at %s', async (current) => {
  const fetcher = setup(idle, current);
  const original = fetcher.getMockImplementation()!;
  let finish!: (response: Response) => void;
  fetcher.mockImplementation((url) => url.startsWith('/api/update/check') ? new Promise<Response>((resolve) => { finish = resolve; }) : original(url));
  await act(async () => render(<UpdateLaunchBanner ready />));
  act(() => Events.current.send({ ...idle, version: offer.latest, releaseUrl: offer.releaseUrl }));
  expect(screen.queryByRole('button', { name: 'update.download' })).toBeNull();
  expect(document.querySelector('aside')).toBeNull();
  await act(async () => finish(Response.json({ ...offer, current, isNewer: false })));
});

it.each(['failed', 'withdrawn'])('does not flash the old %s notice while the initial check is pending', async (kind) => {
  const notice = kind === 'failed' ? { failedApply: { id: 'failed', version: offer.latest, sha256: 'b'.repeat(64), releaseUrl: offer.releaseUrl } }
    : { discardedDownload: { id: 'withdrawn', version: offer.latest } };
  const fetcher = setup({ ...idle, ...notice });
  const original = fetcher.getMockImplementation()!;
  let finish!: (response: Response) => void;
  const currentOffer = { ...idle, state: 'available', version: offer.latest, releaseUrl: offer.releaseUrl, ...notice };
  fetcher.mockImplementation((url) => url.startsWith('/api/update/check') ? new Promise<Response>((resolve) => { finish = resolve; })
    : url === '/api/update/status' ? Promise.resolve(Response.json(currentOffer)) : original(url));
  await act(async () => render(<UpdateLaunchBanner ready />));
  act(() => Events.current.send({ ...idle, state: 'available', version: offer.latest, releaseUrl: offer.releaseUrl, ...notice }));
  expect(screen.queryByRole('button', { name: 'update.dismiss' })).toBeNull();
  expect(screen.queryByText(/^update\.(discarded|rolledBack):/)).toBeNull();
  await act(async () => finish(Response.json(offer)));
  expect(screen.getByRole('button', { name: 'update.download' })).toBeTruthy();
});

it.each(['click', 'extraction'])('uses applying headline and removes dismissal during %s', async (trigger) => {
  setup({ ...idle, state: 'ready', version: offer.latest, releaseUrl: offer.releaseUrl });
  await act(async () => render(<UpdateLaunchBanner ready />));
  if (trigger === 'click') await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.restart' })));
  else act(() => Events.current.send({ ...idle, state: 'ready', version: offer.latest, releaseUrl: offer.releaseUrl, extraction: { completed: 1, total: 10 } }));
  expect(screen.queryByText(/^update.ready:/)).toBeNull();
  expect(screen.getByText('update.applyingVersion:1.3.4').getAttribute('data-applying')).toBe('true');
  expect(screen.queryByRole('button', { name: 'update.later' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'update.dismiss' })).toBeNull();
});

it.each(['en', 'ko'])('formats extraction counters using %s locale', async (selected) => {
  locale = selected;
  setup({ ...idle, state: 'ready', version: offer.latest, releaseUrl: offer.releaseUrl, extraction: { completed: 1233, total: 24642 } });
  await act(async () => render(<UpdateLaunchBanner ready />));
  expect(screen.getByText('update.extractingFiles:1,233|24,642')).toBeTruthy();
});

it('removes the old rollback notice when a new attempt reaches ready', async () => {
  const failedApply = { id: 'old', version: offer.latest, sha256: offer.sha256, releaseUrl: offer.releaseUrl };
  setup({ ...idle, state: 'failed', failedApply });
  await act(async () => render(<UpdateSection currentVersion={offer.current} />));
  expect(screen.getByText('update.rolledBack:1.3.4')).toBeTruthy();
  act(() => Events.current.send({ ...idle, state: 'ready', version: offer.latest, releaseUrl: offer.releaseUrl, failedApply }));
  expect(screen.getByRole('button', { name: 'update.restart' })).toBeTruthy();
  expect(screen.queryByText('update.rolledBack:1.3.4')).toBeNull();
});

it('Q11-04 names the preparation bar with its visible phase', async () => {
  setup({ ...idle, state: 'ready', version: offer.latest, releaseUrl: offer.releaseUrl });
  await act(async () => render(<UpdateLaunchBanner ready />));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.restart' })));
  const bar = screen.getByRole('progressbar');
  expect(bar.getAttribute('aria-label')).toBe(bar.parentElement?.querySelector('span')?.textContent);
});

it('Q11-03 keeps the final file count in the single completed finishing label', async () => {
  const ready = { ...idle, state: 'ready', version: offer.latest, releaseUrl: offer.releaseUrl };
  setup(ready);
  await act(async () => render(<UpdateLaunchBanner ready />));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.restart' })));
  for (const extraction of [{ completed: 24642, total: 24642 }, undefined]) {
    act(() => Events.current.send({ ...ready, extraction }));
    expect(screen.getByText('update.finishing update.extractedFiles:24,642')).toBeTruthy();
    expect(screen.queryByText(/^update.extractingFiles:/)).toBeNull();
  }
});

it('Q11-06 checks once after enabling and shows only the check result', async () => {
  const fetcher = setup();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url) => url === '/api/app-config'
    ? Promise.resolve(Response.json({ config: { autoUpdate: { enabled: false, serverUrl: null } } }))
    : original(url));
  await act(async () => render(<UpdateSection currentVersion={offer.current} />));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: offer.releaseUrl } });
  await act(async () => fireEvent.click(screen.getByRole('switch')));
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/update/check')).toHaveLength(1);
  expect(document.querySelector('[data-update-automatic-status]')).toBeNull();
  expect(document.querySelector('time')?.getAttribute('dateTime')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'update.download' })).toBeTruthy();
});
