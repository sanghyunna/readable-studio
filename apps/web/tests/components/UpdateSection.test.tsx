// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UpdateLaunchBanner, UpdateSection } from '../../src/components/UpdateSection';
import styles from '../../src/components/UpdateSection.module.css';

vi.mock('../../src/i18n', () => ({ useI18n: () => ({ locale: 'en', t: (key: string, vars?: Record<string, string>) => `${key}${vars ? ':' + Object.values(vars).join(',') : ''}` }) }));
vi.mock('../../src/components/databricks/DatabricksLoginButton', () => ({ DatabricksLoginButton: ({ host }: { host?: string }) => <button>{host ?? 'login'}</button> }));
const result = { current: '1.3.3', latest: '1.3.4', isNewer: true, assetName: 'Readable-Studio-win-x64-portable.zip', assetSize: 1234, sha256: 'a'.repeat(64), releaseUrl: 'https://updates.databricksapps.com', notes: '', checkedAt: '2026-10-15T00:00:00Z' };
const idle = { state: 'idle', received: 0, total: 0, version: null, error: null };
class Events {
  static current: Events;
  onmessage?: (event: { data: string }) => void;
  close = vi.fn();
  constructor() { Events.current = this; }
  send(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
function setup(configured = true) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/version') return Response.json({ version: { version: result.current } });
    if (url === '/api/app-config') return Response.json({ config: { autoUpdate: { enabled: false, serverUrl: configured ? result.releaseUrl : null } } });
    if (url === '/api/update/health') return Response.json({ ok: true });
    if (url === '/api/update/connection') return Response.json({ ok: true, serverUrl: result.releaseUrl, latest: result.latest, timeoutMs: 25000, elapsedMs: 1, steps: [] });
    if (url.startsWith('/api/update/check')) return Response.json(result);
    if (url === '/api/update/download') return Response.json({ ...idle, state: 'downloading', total: 1234 });
    if (url === '/api/update/apply') return Response.json({ status: 'applying', targetVersion: '1.3.4' });
    return Response.json(idle);
  });
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('EventSource', Events);
  return fetcher;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('hydrates persisted enabled update configuration on the first launch and a relaunch', async () => {
  const fetcher = setup();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, init) => url === '/api/app-config'
    ? Promise.resolve(Response.json({ config: { autoUpdate: { enabled: true, serverUrl: result.releaseUrl } } }))
    : original(url, init));
  for (let launch = 0; launch < 2; launch++) {
    const view = await act(async () => render(<UpdateSection currentVersion={result.latest} />));
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(result.releaseUrl);
    expect((screen.getByRole('button', { name: 'update.check' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('update.serverHint')).toBeNull();
    view.unmount();
  }
});

it('does not offer a withdrawn failed release in Settings after checking', async () => {
  const fetcher = setup();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, init) => url === '/api/update/status'
    ? Promise.resolve(Response.json({ ...idle, failedApply: { id: 'withdrawn-failure', version: result.latest, sha256: result.sha256, releaseUrl: result.releaseUrl },
      discardedDownload: { id: 'withdrawn-discard', version: result.latest } }))
    : url.startsWith('/api/update/check') ? Promise.resolve(Response.json({ unavailable: 'no-release' })) : original(url, init));
  await act(async () => { render(<UpdateSection currentVersion={result.current} />); });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.check' })));
  expect(screen.queryByRole('button', { name: 'update.download' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'update.retry' })).toBeNull();
  expect(screen.getAllByText(/^update\.discarded:/)).toHaveLength(1);
  expect(screen.queryByText(/^update\.rolledBack:/)).toBeNull();
});

it.each(['failed', 'discarded'])('offers a replacement digest ahead of the old %s Hub notice', async (kind) => {
  localStorage.removeItem('update.dismissedDiscard');
  const fetcher = setup();
  const original = fetcher.getMockImplementation()!;
  const notice = kind === 'failed'
    ? { failedApply: { id: 'old-failure', version: result.latest, sha256: 'b'.repeat(64), releaseUrl: result.releaseUrl } }
    : { discardedDownload: { id: 'old-discard', version: result.latest } };
  fetcher.mockImplementation((url, init) => url === '/api/update/status'
    ? Promise.resolve(Response.json({ ...idle, state: 'available', version: result.latest, releaseUrl: result.releaseUrl, ...notice }))
    : original(url, init));
  await act(async () => { render(<UpdateLaunchBanner ready />); });
  expect(screen.getByRole('button', { name: 'update.download' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'update.dismiss' })).toBeNull();
});

it.each(['settings', 'hub'])('renders daemon extraction counts on %s', async (surface) => {
  const fetcher = setup();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, init) => url === '/api/update/status'
    ? Promise.resolve(Response.json({ ...idle, state: 'ready', version: result.latest, releaseUrl: result.releaseUrl }))
    : original(url, init));
  await act(async () => { render(surface === 'hub' ? <UpdateLaunchBanner ready /> : <UpdateSection currentVersion={result.current} />); });
  act(() => Events.current.send({ ...idle, state: 'ready', version: result.latest, releaseUrl: result.releaseUrl,
    extraction: { completed: 50, total: 100 } }));
  expect(screen.getByRole('progressbar').getAttribute('value')).toBe('50');
  expect(screen.getByRole('progressbar').getAttribute('max')).toBe('100');
  expect(screen.getByRole('button', { name: 'update.applyingAction' }).hasAttribute('disabled')).toBe(true);
});

it.each(['before-check', 'after-check', 'hub'])('never offers an obsolete failed release after successful installation: %s', async (surface) => {
  const fetcher = setup();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, init) => url === '/api/update/status'
    ? Promise.resolve(Response.json({ ...idle, state: 'failed', error: 'apply-rolled-back',
      failedApply: { id: 'installed-failure', version: result.latest, sha256: result.sha256, releaseUrl: result.releaseUrl } }))
    : url.startsWith('/api/update/check') ? Promise.resolve(Response.json({ ...result, current: result.latest, isNewer: false }))
    : original(url, init));
  await act(async () => { render(surface === 'hub' ? <UpdateLaunchBanner ready /> : <UpdateSection currentVersion={result.latest} />); });
  if (surface === 'after-check') await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.check' })));
  expect(screen.queryByRole('button', { name: 'update.download' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'update.retry' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'update.restart' })).toBeNull();
  expect(screen.queryByText(/^update\.rolledBack:/)).toBeNull();
  if (surface === 'hub') expect(document.querySelector('aside')).toBeNull();
});

it.each(['release-withdrawn', 'invalid-package', 'version-mismatch', 'disk-extract-failed'])('removes restart on both surfaces after apply discards the package: %s', async (reason) => {
  const fetcher = setup();
  const original = fetcher.getMockImplementation()!;
  let staged = true;
  fetcher.mockImplementation((url, init) => {
    if (url === '/api/update/status') return Promise.resolve(Response.json(staged
      ? { ...idle, state: 'ready', version: '1.3.4', releaseUrl: result.releaseUrl } : idle));
    if (url === '/api/update/apply') {
      staged = false;
      return Promise.resolve(Response.json({ error: reason }, { status: 409 }));
    }
    return original(url, init);
  });
  await act(async () => { render(<><UpdateLaunchBanner ready /><UpdateSection currentVersion="1.3.3" /></>); });
  expect(screen.getAllByRole('button', { name: 'update.restart' })).toHaveLength(2);
  await act(async () => fireEvent.click(screen.getAllByRole('button', { name: 'update.restart' })[0]!));
  expect(screen.queryByRole('button', { name: 'update.restart' })).toBeNull();
});

it.each(['no-release', 'changed'])('synchronizes Hub and Settings after a check discards staged bytes: %s', async (outcome) => {
  const fetcher = setup();
  const original = fetcher.getMockImplementation()!;
  let staged = true;
  fetcher.mockImplementation((url, init) => {
    if (url === '/api/update/status') return Promise.resolve(Response.json(staged
      ? { ...idle, state: 'ready', version: '1.3.4', releaseUrl: result.releaseUrl } : idle));
    if (url === '/api/update/check') {
      staged = false;
      return Promise.resolve(Response.json(outcome === 'no-release' ? { unavailable: 'no-release' } : { ...result, latest: '1.3.5' }));
    }
    return original(url, init);
  });
  await act(async () => { render(<><UpdateLaunchBanner ready /><UpdateSection currentVersion="1.3.3" /></>); });
  expect(screen.getAllByRole('button', { name: 'update.restart' })).toHaveLength(2);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.check' })));
  expect(screen.queryByRole('button', { name: 'update.restart' })).toBeNull();
  if (outcome === 'no-release') expect(document.querySelector('aside')).toBeNull();
  else expect(screen.getAllByText('update.newVersion:1.3.5')).toHaveLength(2);
});

it('keeps Hub actions together and progress separate across streamed states', async () => {
  setup();
  await act(async () => { render(<UpdateLaunchBanner ready />); });
  const later = screen.getByRole('button', { name: 'update.later' });
  const actions = screen.getByRole('button', { name: 'update.download' }).parentElement;
  expect(later.parentElement).toBe(actions);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.download' })));
  act(() => Events.current.send({ ...idle, state: 'downloading', version: '1.3.4', received: 617, total: 1234 }));
  expect(screen.getByRole('button', { name: 'update.cancel' }).parentElement).toBe(actions);
  expect(screen.getByRole('button', { name: 'update.hide' }).parentElement).toBe(actions);
  expect(actions?.contains(screen.getByRole('progressbar'))).toBe(false);
  act(() => Events.current.send({ ...idle, state: 'ready', version: '1.3.4', received: 1234, total: 1234 }));
  expect(screen.getByRole('button', { name: 'update.restart' }).parentElement).toBe(actions);
  expect(screen.getByRole('button', { name: 'update.later' }).parentElement).toBe(actions);
});

it('shows indeterminate Hub progress before bytes arrive', async () => {
  setup();
  await act(async () => { render(<UpdateLaunchBanner ready />); });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.download' })));
  act(() => Events.current.send({ ...idle, state: 'downloading', version: '1.3.4', received: 0, total: 1234 }));
  expect(screen.getByRole('progressbar').hasAttribute('value')).toBe(false);
  expect(screen.getByRole('button', { name: 'update.cancel' })).toBeTruthy();
});

it('routes Hub authentication failures to update settings through a compact toast', async () => {
  const fetcher = setup();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, init) => url.startsWith('/api/update/check')
    ? Promise.resolve(Response.json({ unavailable: 'not-logged-in' })) : original(url, init));
  const openSettings = vi.fn();
  await act(async () => { render(<UpdateLaunchBanner ready setupVisible onOpenUpdateSettings={openSettings} />); });
  expect(screen.queryByRole('button', { name: 'login' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'update.enableAutomatic' }));
  expect(openSettings).toHaveBeenCalledOnce();
});

it('Settings loads a switch, persists normalized URL and checks health before enabling', async () => {
  const fetcher = setup(false);
  await act(async () => { render(<UpdateSection currentVersion="1.3.3" />); });
  expect((screen.getByRole('button', { name: 'update.check' }) as HTMLButtonElement).disabled).toBe(true);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: `${result.releaseUrl}/` } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.connect' })));
  expect(fetcher).toHaveBeenCalledWith('/api/update/connection', expect.objectContaining({ body: JSON.stringify({ serverUrl: result.releaseUrl }) }));
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  await act(async () => fireEvent.click(screen.getByRole('switch')));
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  expect(fetcher).toHaveBeenCalledWith('/api/app-config', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ autoUpdate: { enabled: true, serverUrl: result.releaseUrl } }) }));
});

it('Hub waits for readiness then offers download, progress and restart using the staged file', async () => {
  const fetcher = setup();
  const view = render(<UpdateLaunchBanner ready={false} />);
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => view.rerender(<UpdateLaunchBanner ready />));
  expect(screen.getByText('update.newVersion:1.3.4')).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.download' })));
  act(() => Events.current.send({ ...idle, state: 'downloading', received: 617, total: 1234, version: '1.3.4' }));
  expect(screen.getByRole('progressbar').getAttribute('value')).toBe('617');
  expect(screen.getByText(/50%/)).toBeTruthy();
  act(() => Events.current.send({ ...idle, state: 'ready', received: 1234, total: 1234, version: '1.3.4' }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.restart' })));
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/update/download')).toHaveLength(1);
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/update/apply')).toHaveLength(1);
});

it('Later hides the Hub card until a new launch mount', async () => {
  setup();
  const view = render(<UpdateLaunchBanner ready />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'update.later' }));
  expect(screen.queryByRole('status')).toBeNull();
  view.unmount();
  await act(async () => { render(<UpdateLaunchBanner ready />); });
  expect(screen.getByText('update.newVersion:1.3.4')).toBeTruthy();
});

it('disabled automatic checks render nothing and happen once per launch', async () => {
  const fetcher = vi.fn(async (_url: string) => Response.json({ unavailable: 'disabled' }));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<UpdateLaunchBanner ready />);
  await act(async () => {});
  await act(async () => view.rerender(<UpdateLaunchBanner ready />));
  expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith('/api/update/check'))).toHaveLength(1);
  expect(screen.queryByRole('status')).toBeNull();
});

it('does not replace streamed progress with an older download-start response', async () => {
  const fetcher = setup();
  const original = fetcher.getMockImplementation()!;
  let resolveDownload!: (response: Response) => void;
  fetcher.mockImplementation((url, init) => url === '/api/update/download' ? new Promise<Response>((resolve) => { resolveDownload = resolve; }) : original(url, init));
  await act(async () => { render(<UpdateLaunchBanner ready />); });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.download' })));
  act(() => Events.current.send({ ...idle, state: 'downloading', received: 617, total: 1234, version: '1.3.4' }));
  await act(async () => resolveDownload(Response.json({ ...idle, state: 'downloading', received: 0, total: 1234, version: '1.3.4' })));
  expect(screen.getByRole('progressbar').getAttribute('value')).toBe('617');
});

it('keeps watching when the initial event describes a previously staged version', async () => {
  setup();
  await act(async () => { render(<UpdateLaunchBanner ready />); });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.download' })));
  act(() => Events.current.send({ ...idle, state: 'ready', received: 1234, total: 1234, version: '1.3.3' }));
  expect(Events.current.close).not.toHaveBeenCalled();
  act(() => Events.current.send({ ...idle, state: 'downloading', received: 617, total: 1234, version: '1.3.4' }));
  expect(screen.getByRole('progressbar').getAttribute('value')).toBe('617');
});

it.each(['settings', 'hub'])('recovers a ready update without a successful check in %s', async (surface) => {
  const fetcher = setup();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, init) => url === '/api/update/status'
    ? Promise.resolve(Response.json({ ...idle, state: 'ready', version: '1.3.4', releaseUrl: result.releaseUrl }))
    : url.startsWith('/api/update/check') ? Promise.resolve(Response.json({ unavailable: 'unreachable' })) : original(url, init));
  if (surface === 'settings') {
    await act(async () => { render(<UpdateLaunchBanner ready />); });
    cleanup();
  }
  await act(async () => { render(surface === 'hub' ? <UpdateLaunchBanner ready /> : <UpdateSection currentVersion="1.3.3" />); });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.restart' })));
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/update/apply')).toHaveLength(1);
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/update/download')).toHaveLength(0);
});

it('disables restart while apply is pending and maps a busy response', async () => {
  const fetcher = setup();
  const original = fetcher.getMockImplementation()!;
  let resolveApply!: (response: Response) => void;
  fetcher.mockImplementation((url, init) => url === '/api/update/apply'
    ? new Promise<Response>((resolve) => { resolveApply = resolve; }) : original(url, init));
  await act(async () => { render(<UpdateLaunchBanner ready />); });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.download' })));
  act(() => Events.current.send({ ...idle, state: 'ready', version: '1.3.4' }));
  fireEvent.click(screen.getByRole('button', { name: 'update.restart' }));
  expect(screen.getByRole('button', { name: 'update.applyingAction' }).hasAttribute('disabled')).toBe(true);
  await act(async () => resolveApply(Response.json({ error: 'update-in-progress' }, { status: 409 })));
  expect(screen.getByRole('alert').textContent).toBe('update.reason.update-in-progress');
});

it.each([['http://example.com', 'not-https'], ['garbage', 'invalid-url']])('rejects invalid server input locally: %s', async (url, kind) => {
  const fetcher = setup(false);
  await act(async () => { render(<UpdateSection currentVersion="1.3.3" />); });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: url } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.connect' })));
  expect(screen.getByRole('alert').textContent).toBe(`update.reason.${kind}`);
  expect(screen.getByText('update.connection.details')).toBeTruthy();
  expect(fetcher.mock.calls.some(([path]) => path === '/api/update/health' || path === '/api/update/connection')).toBe(false);
});

it('formats the checked timestamp with the selected UI locale', async () => {
  setup();
  const format = vi.spyOn(Date.prototype, 'toLocaleString');
  await act(async () => { render(<UpdateSection currentVersion="1.3.3" />); });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.check' })));
  expect(format).toHaveBeenLastCalledWith('en');
  format.mockRestore();
});

it.each(['check', 'edit'])('clears a previous restart error after a new %s', async (action) => {
  const fetcher = setup();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, init) => url === '/api/update/status'
    ? Promise.resolve(Response.json({ ...idle, state: 'ready', version: '1.3.4', releaseUrl: result.releaseUrl }))
    : url === '/api/update/apply' ? Promise.resolve(Response.json({ error: 'update-in-progress' }, { status: 409 }))
    : url.startsWith('/api/update/check') ? Promise.resolve(Response.json({ unavailable: 'not-logged-in' }))
    : original(url, init));
  await act(async () => { render(<UpdateSection currentVersion="1.3.3" />); });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.restart' })));
  expect(screen.getByText('update.reason.update-in-progress')).toBeTruthy();
  if (action === 'check') {
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.check' })));
    expect(screen.getByText('update.reason.not-logged-in')).toBeTruthy();
  } else {
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://new.databricksapps.com' } });
  }
  expect(screen.queryByText('update.reason.update-in-progress')).toBeNull();
});

it('associates local validation with the URL input and clears it on edit', async () => {
  setup(false);
  await act(async () => { render(<UpdateSection currentVersion="1.3.3" />); });
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'http://example.com' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.connect' })));
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByRole('alert').className.split(' ')).toContain(styles.fieldError);
  expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe('update.reason.not-https');
  expect(input.parentElement?.contains(screen.getByRole('alert'))).toBe(true);
  fireEvent.change(input, { target: { value: result.releaseUrl } });
  expect(screen.queryByText('update.reason.not-https')).toBeNull();
  expect(screen.queryByText('update.connection.details')).toBeNull();
});

it('preserves a URL typed before app config resolves', async () => {
  const fetcher = setup();
  const original = fetcher.getMockImplementation()!;
  let resolveConfig!: (response: Response) => void;
  fetcher.mockImplementation((url, init) => url === '/api/app-config'
    ? new Promise<Response>((resolve) => { resolveConfig = resolve; }) : original(url, init));
  render(<UpdateSection currentVersion="1.3.3" />);
  const input = screen.getByRole('textbox') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'https://typed.example' } });
  await act(async () => resolveConfig(Response.json({ config: { autoUpdate: { enabled: false, serverUrl: null } } })));
  expect(input.value).toBe('https://typed.example');
});

it('does not offer restart for an already running staged version', async () => {
  const fetcher = setup();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, init) => url === '/api/update/status'
    ? Promise.resolve(Response.json({ ...idle, state: 'ready', version: '1.3.4', releaseUrl: result.releaseUrl })) : original(url, init));
  await act(async () => { render(<UpdateSection currentVersion="1.3.4" />); });
  expect(screen.queryByRole('button', { name: 'update.restart' })).toBeNull();
});

it('hides an already installed recovered Hub offer after checking the running version', async () => {
  const fetcher = setup();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, init) => url === '/api/update/status'
    ? Promise.resolve(Response.json({ ...idle, state: 'ready', version: '1.3.4', releaseUrl: result.releaseUrl }))
    : url.startsWith('/api/update/check') ? Promise.resolve(Response.json({ ...result, current: '1.3.4', isNewer: false })) : original(url, init));
  await act(async () => { render(<UpdateLaunchBanner ready />); });
  expect(screen.queryByRole('button', { name: 'update.restart' })).toBeNull();
});

it.each(['settings', 'hub'])('recovers partial progress and supplied release notes without a manifest in %s', async (surface) => {
  const fetcher = setup();
  const original = fetcher.getMockImplementation()!;
  const notes = 'release notes fixture';
  fetcher.mockImplementation((url, init) => url === '/api/update/status'
    ? Promise.resolve(Response.json({ ...idle, received: 617, total: 1234, version: '1.3.4', releaseUrl: result.releaseUrl, notes }))
    : url.startsWith('/api/update/check') ? Promise.resolve(Response.json({ unavailable: 'unreachable' })) : original(url, init));
  await act(async () => { render(surface === 'hub' ? <UpdateLaunchBanner ready /> : <UpdateSection currentVersion="1.3.3" />); });
  expect(screen.getByRole('button', { name: 'update.resume' })).toBeTruthy();
  expect(screen.getByRole('progressbar').getAttribute('value')).toBe('617');
  expect(screen.getByText(notes).getAttribute('title')).toBe(notes);
});

it('shows immediate preparation feedback and preserves partial bytes on cancel', async () => {
  const fetcher = setup();
  const original = fetcher.getMockImplementation()!;
  let resolveDownload!: (response: Response) => void;
  fetcher.mockImplementation((url, init) => url === '/api/update/download'
    ? new Promise<Response>((resolve) => { resolveDownload = resolve; })
    : url === '/api/update/cancel' ? Promise.resolve(Response.json({ ...idle, received: 617, total: 1234, version: '1.3.4' })) : original(url, init));
  await act(async () => { render(<UpdateLaunchBanner ready />); });
  fireEvent.click(screen.getByRole('button', { name: 'update.download' }));
  expect(screen.getByRole('button', { name: 'update.preparing' }).hasAttribute('disabled')).toBe(true);
  await act(async () => resolveDownload(Response.json({ ...idle, state: 'downloading', version: '1.3.4', received: 617, total: 1234 })));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.cancel' })));
  expect(screen.getByRole('button', { name: 'update.resume' })).toBeTruthy();
  expect(screen.getByRole('progressbar').getAttribute('value')).toBe('617');
});

it('keeps the hidden download subscribed and returns the card when ready', async () => {
  setup();
  await act(async () => { render(<UpdateLaunchBanner ready />); });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.download' })));
  act(() => Events.current.send({ ...idle, state: 'downloading', version: '1.3.4', received: 617, total: 1234 }));
  fireEvent.click(screen.getByRole('button', { name: 'update.hide' }));
  expect(screen.queryByRole('button', { name: 'update.cancel' })).toBeNull();
  act(() => Events.current.send({ ...idle, state: 'ready', version: '1.3.4', received: 1234, total: 1234 }));
  expect(screen.getByRole('button', { name: 'update.restart' })).toBeTruthy();
});

it.each(['http://example.com', 'garbage'])('shows only field guidance after rejecting %s', async (url) => {
  setup(false);
  await act(async () => { render(<UpdateSection currentVersion="1.3.3" />); });
  expect(screen.getByText('update.serverHint')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: url } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.connect' })));
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(screen.queryByText('update.serverHint')).toBeNull();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://correct.example' } });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText('update.serverHint')).toBeNull();
});
