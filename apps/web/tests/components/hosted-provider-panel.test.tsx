// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostedProviderPanel } from '../../src/components/HostedProviderPanel';

const session = {
  publicOrigin: 'http://localhost:3000',
  csrfToken: 'csrf',
  csrfExpiresAt: Date.now() + 60_000,
  providers: [
    { id: 'anthropic', model: 'claude-sonnet-4-20250514' },
    { id: 'vercel-ai-gateway', model: 'anthropic/claude-sonnet-4' },
  ],
} as const;

function client() {
  return {
    getSession: vi.fn().mockResolvedValue(session),
    status: vi.fn().mockResolvedValue({ provider: null, configured: false }),
    set: vi.fn().mockResolvedValue({ result: 'set', provider: 'anthropic', configured: true }),
    test: vi.fn().mockResolvedValue({
      result: 'passed',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    }),
    clear: vi.fn().mockResolvedValue({ result: 'cleared', provider: null, configured: false }),
  };
}

describe('HostedProviderPanel', () => {
  afterEach(cleanup);

  it('discovers the fixed Pi provider catalogue from hosted session bootstrap', async () => {
    render(<HostedProviderPanel client={client()} />);

    expect(await screen.findByRole('heading', { name: 'Connect a model provider' })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Anthropic.*claude-sonnet-4-20250514/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Vercel AI Gateway.*anthropic\/claude-sonnet-4/ })).toBeTruthy();
    expect(screen.getByText('Pi')).toBeTruthy();
  });

  it('keeps the provider draft in component memory and clears it after set', async () => {
    const api = client();
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    render(<HostedProviderPanel client={api} />);
    const key = await screen.findByLabelText('API key');

    fireEvent.change(key, { target: { value: 'sentinel-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));

    await waitFor(() => expect(api.set).toHaveBeenCalledWith({
      provider: 'anthropic',
      key: 'sentinel-secret',
    }));
    await waitFor(() => expect((key as HTMLInputElement).value).toBe(''));
    expect(storageWrite).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('sentinel-secret');
    storageWrite.mockRestore();
  });

  it('refreshes provider status after a failed test clears the server credential slot', async () => {
    const api = client();
    api.status
      .mockResolvedValueOnce({ provider: 'anthropic', configured: true })
      .mockResolvedValueOnce({ provider: null, configured: false });
    api.test.mockRejectedValueOnce(new Error('provider failed'));
    render(<HostedProviderPanel client={api} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('No key configured')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).not.toContain('provider failed');
  });
});
