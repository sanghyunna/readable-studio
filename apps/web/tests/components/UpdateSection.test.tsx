// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UpdateLaunchBanner, UpdateSection } from '../../src/components/UpdateSection';

vi.mock('../../src/i18n', () => ({ useI18n: () => ({ t: (key: string, vars?: Record<string, string>) => `${key}${vars ? ':' + Object.values(vars).join(',') : ''}` }) }));
const result = { current: '1.2.1', latest: '1.3.0', isNewer: true, assetName: 'portable.zip', assetSize: 1234, sha256: 'a'.repeat(64), releaseUrl: 'https://github.com/sanghyunna/readable-studio/releases/tag/v1.3.0', notes: 'notes', checkedAt: '2026-10-01T00:00:00.000Z' };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([true, false])('launch banner only for newer=%s, after readiness and once per mount', async (isNewer) => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ ...result, isNewer })); vi.stubGlobal('fetch', fetcher);
  const view = render(<UpdateLaunchBanner ready={false} />);
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => view.rerender(<UpdateLaunchBanner ready />));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('status') !== null).toBe(isNewer);
  await act(async () => { view.rerender(<UpdateLaunchBanner ready={false} />); view.rerender(<UpdateLaunchBanner ready />); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toContain('/api/update/check?automatic=1');
});
it.each(['offline', 'disabled', 'rate-limited', 'malformed', 'timeout'])('launch failure %s is silent', async (unavailable) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ unavailable })));
  await act(async () => { render(<UpdateLaunchBanner ready />); });
  expect(screen.queryByRole('status')).toBeNull();
});
it.each([
  [{ ...result, isNewer: false }, 'update.upToDate'],
  [result, 'update.newVersion:1.3.0'],
  [{ unavailable: 'offline' }, 'update.failed:update.reason.offline'],
])('Settings renders result %# and disabled apply seam', async (data, expected) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(data)));
  const onApply = vi.fn();
  render(<UpdateSection currentVersion="1.2.1" onApply={onApply} />);
  expect(screen.getByText('1.2.1')).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.check' })));
  expect(screen.getByText(expected)).toBeTruthy();
  const button = screen.getByRole('button', { name: 'update.apply' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.title).toBeTruthy();
  expect(onApply).not.toHaveBeenCalled();
  if ('current' in data) expect(screen.getByRole('time').getAttribute('dateTime')).toBe(result.checkedAt);
  if ('isNewer' in data && data.isNewer) expect(screen.getByRole('link').getAttribute('href')).toBe(result.releaseUrl);
});
it('Settings reflects a launch check completing while it is open', async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
  render(<><UpdateSection currentVersion="1.2.1" /><UpdateLaunchBanner ready /></>);
  await act(async () => resolve(Response.json({ ...result, isNewer: false, checkedAt: '2026-10-01T01:00:00.000Z' })));
  expect(screen.getByText('update.upToDate')).toBeTruthy();
  expect(screen.getByRole('time').getAttribute('dateTime')).toBe('2026-10-01T01:00:00.000Z');
});
it('Settings converts transport failure into an inline typed result', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')));
  render(<UpdateSection currentVersion="1.2.1" />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'update.check' })));
  expect(screen.getByText('update.failed:update.reason.offline')).toBeTruthy();
});
