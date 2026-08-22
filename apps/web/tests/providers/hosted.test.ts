import { describe, expect, it, vi } from 'vitest';
import { HostedProviderClient, HostedProviderRequestError } from '../../src/providers/hosted';

const session = {
  publicOrigin: 'https://hosted.readable-studio.test',
  csrfToken: 'csrf-one',
  csrfExpiresAt: Date.now() + 60_000,
  providers: [{ id: 'anthropic', model: 'claude-sonnet-4-20250514' }],
} as const;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HostedProviderClient', () => {
  it('does not rebind the browser fetch receiver', async () => {
    const responses = [json(session), json({ provider: null, configured: false })];
    const fetcher = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(responses.shift()!);
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      await expect(new HostedProviderClient().status()).resolves.toEqual({
        provider: null,
        configured: false,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('bootstraps a memory-only session before reading provider status', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json({ provider: null, configured: false }));

    const result = await new HostedProviderClient(fetcher).status();

    expect(result).toEqual({ provider: null, configured: false });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/api/hosted/session',
      '/api/hosted/provider',
    ]);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include' });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ credentials: 'include' });
  });

  it('refreshes once after 419 and retries the exact serialized mutation body', async () => {
    const refreshed = { ...session, csrfToken: 'csrf-two' };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json({ code: 'CSRF_EXPIRED' }, 419))
      .mockResolvedValueOnce(json(refreshed))
      .mockResolvedValueOnce(json({ result: 'set', provider: 'anthropic', configured: true }));
    const client = new HostedProviderClient(fetcher);

    await client.set({ provider: 'anthropic', key: 'sentinel-secret' });

    const first = fetcher.mock.calls[1]?.[1];
    const retry = fetcher.mock.calls[3]?.[1];
    expect(first?.body).toBe('{"provider":"anthropic","key":"sentinel-secret"}');
    expect(retry?.body).toBe(first?.body);
    expect(first?.headers).toMatchObject({
      Origin: session.publicOrigin,
      'X-Readable-Studio-CSRF': 'csrf-one',
    });
    expect(retry?.headers).toMatchObject({
      Origin: session.publicOrigin,
      'X-Readable-Studio-CSRF': 'csrf-two',
    });
  });

  it('retries hosted run admission with the same client request id and body', async () => {
    const refreshed = { ...session, csrfToken: 'csrf-two' };
    const intent = {
      projectId: 'project-a',
      conversationId: 'conversation-a',
      assistantMessageId: 'assistant-a',
      agentId: 'pi',
      message: 'Build it',
      clientRequestId: 'request-a',
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json({ code: 'CSRF_EXPIRED' }, 419))
      .mockResolvedValueOnce(json(refreshed))
      .mockResolvedValueOnce(json({
        runId: 'run-a',
        conversationId: 'conversation-a',
        assistantMessageId: 'assistant-a',
      }, 202));

    await expect(new HostedProviderClient(fetcher).createRun(intent)).resolves.toMatchObject({
      runId: 'run-a',
    });

    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(intent));
    expect(fetcher.mock.calls[3]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
  });

  it('does not copy a rejected secret or response body into errors', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json({ message: 'rejected sentinel-secret' }, 400));

    const error = await new HostedProviderClient(fetcher)
      .set({ provider: 'anthropic', key: 'sentinel-secret' })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(HostedProviderRequestError);
    expect(String(error)).toBe('HostedProviderRequestError: Hosted provider request failed (400)');
    expect(String(error)).not.toContain('sentinel-secret');
  });

  it('redacts malformed successful response bodies', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(new Response('sentinel-secret', { status: 200 }));

    const error = await new HostedProviderClient(fetcher).status().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(HostedProviderRequestError);
    expect(String(error)).not.toContain('sentinel-secret');
  });
});
