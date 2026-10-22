import { expect, it, vi } from 'vitest';
const capture = vi.hoisted(() => ({ options: vi.fn(), destroy: vi.fn(), fetch: vi.fn(async () => new Response('ok')) }));
vi.mock('undici', () => ({ EnvHttpProxyAgent: class {
  constructor(options: unknown) { capture.options(options); }
  destroy = capture.destroy;
}, fetch: capture.fetch }));
import { createUpdateHttpClient } from '../src/update-http.js';

it('sets generous transport deadlines for direct and proxy routes without changing TLS trust', async () => {
  const client = createUpdateHttpClient({ HTTPS_PROXY: 'http://proxy.example:8080' });
  try {
    expect(capture.options).toHaveBeenCalledWith(expect.objectContaining({
      httpsProxy: 'http://proxy.example:8080', connectTimeout: 120_000, headersTimeout: 600_000, bodyTimeout: 600_000,
    }));
    expect(capture.options.mock.calls[0]?.[0]).not.toHaveProperty('requestTls');
    expect(capture.options.mock.calls[0]?.[0]).not.toHaveProperty('proxyTls');
    await client.fetch('https://updates.example/health', { signal: new AbortController().signal });
    expect(capture.fetch).toHaveBeenCalledWith('https://updates.example/health', expect.objectContaining({ dispatcher: expect.anything() }));
  } finally { await client.destroy(); }
});
