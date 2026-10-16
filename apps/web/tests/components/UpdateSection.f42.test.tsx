// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UpdateLaunchBanner, UpdateSection } from '../../src/components/UpdateSection';

vi.mock('../../src/i18n', () => ({ useI18n: () => ({ locale: 'en', t: (key: string) => key }) }));
vi.mock('../../src/components/databricks/DatabricksLoginButton', () => ({ DatabricksLoginButton: () => <button>login</button> }));
const partial = { state: 'failed', version: '1.3.4', releaseUrl: 'https://updates.databricksapps.com', received: 5, total: 100, error: 'unreachable' };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
it.each([
  ['hub', 0], ['hub', 5], ['settings', 0], ['settings', 5],
] as const)('Q16-02 presents a retryable failed download without an interrupted headline in %s at %s bytes', async (surface, received) => {
  const failed = { ...partial, received };
  const fetcher = vi.fn(async (url: string) => Response.json(
    url === '/api/update/status' ? failed : url === '/api/version' ? { version: { version: '1.3.3' } }
      : url === '/api/app-config' ? { config: { autoUpdate: { enabled: true, serverUrl: partial.releaseUrl } } }
        : url === '/api/update/download' ? { ...partial, state: 'downloading', error: null } : { unavailable: 'disabled' }));
  vi.stubGlobal('fetch', fetcher); vi.stubGlobal('EventSource', undefined);
  await act(async () => render(surface === 'hub' ? <UpdateLaunchBanner ready /> : <UpdateSection currentVersion="1.3.3" />));
  expect(screen.getByRole('alert').textContent).toBe('update.reason.offline');
  expect(screen.queryByText('update.interrupted')).toBeNull();
  expect(screen.queryByRole('button', { name: 'login' })).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: received ? 'update.resume' : 'update.retry' })));
  expect(fetcher).toHaveBeenCalledWith('/api/update/download', expect.objectContaining({ method: 'POST' }));
});
