import { describe, expect, it, vi } from 'vitest';
import { runProviderCli } from '../src/provider-cli.js';

describe('provider CLI', () => {
  const daemonUrl = 'https://hosted.example';

  function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }

  function harness(responses: Response[], files: Record<string, string> = {}) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      responses.shift() ?? json({ error: { code: 'UNEXPECTED' } }, 500));
    return {
      deps: {
        env: {},
        fetch,
        readFile: async (filePath: string) => Buffer.from(files[filePath] ?? ''),
        readStdin: async () => Buffer.from(files['-'] ?? ''),
        stdout: (text: string) => stdout.push(text),
        stderr: (text: string) => stderr.push(text),
      },
      fetch,
      stdout,
      stderr,
    };
  }

  const session = (csrfToken = 'csrf-1') => json({
    publicOrigin: daemonUrl,
    csrfToken,
    csrfExpiresAt: Date.now() + 60_000,
    providers: [
      { id: 'anthropic', model: 'claude-sonnet-4-20250514' },
      { id: 'vercel-ai-gateway', model: 'anthropic/claude-sonnet-4' },
    ],
  });

  it('gets status with a bearer token read from a file', async () => {
    const h = harness([
      session(),
      json({ provider: 'anthropic', configured: true }),
    ], { identity: 'identity-token\n' });

    const result = await runProviderCli([
      'status', '--daemon-url', daemonUrl, '--identity-token-file', 'identity', '--json',
    ], h.deps);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(h.stdout.join(''))).toEqual({ provider: 'anthropic', configured: true });
    expect(h.stderr).toEqual([]);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.fetch.mock.calls.map(([url]) => String(url))).toEqual([
      `${daemonUrl}/api/hosted/session`,
      `${daemonUrl}/api/hosted/provider`,
    ]);
    for (const [, init] of h.fetch.mock.calls) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer identity-token');
      expect(init?.redirect).toBe('manual');
    }
  });

  it('sets a provider with one terminal CRLF removed and retries once with an identical body', async () => {
    const h = harness([
      session('csrf-1'),
      json({ error: { code: 'CSRF_EXPIRED' } }, 419),
      session('csrf-2'),
      json({
        result: 'set', provider: 'anthropic', configured: true, key: 'must-not-be-forwarded',
      }),
    ], { identity: 'identity-token', key: ' key with spaces \r\n' });

    const result = await runProviderCli([
      'set', '--provider', 'anthropic', '--key-file', 'key', '--identity-token-file', 'identity',
      '--daemon-url', daemonUrl, '--json',
    ], h.deps);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(h.stdout.join(''))).toEqual({
      result: 'set', provider: 'anthropic', configured: true,
    });
    const mutations = h.fetch.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(mutations).toHaveLength(2);
    expect(mutations[0]?.[1]?.body).toBe(mutations[1]?.[1]?.body);
    expect(JSON.parse(String(mutations[0]?.[1]?.body))).toEqual({
      provider: 'anthropic',
      key: ' key with spaces ',
    });
    expect(new Headers(mutations[0]?.[1]?.headers).get('origin')).toBe(daemonUrl);
    expect(new Headers(mutations[0]?.[1]?.headers).get('X-Readable-Studio-CSRF')).toBe('csrf-1');
    expect(new Headers(mutations[1]?.[1]?.headers).get('X-Readable-Studio-CSRF')).toBe('csrf-2');
    expect(`${h.stdout.join('')} ${h.stderr.join('')}`).not.toContain('key with spaces');
    expect(h.stdout.join('')).not.toContain('must-not-be-forwarded');
  });

  it('tests and clears through the frozen provider routes', async () => {
    const testHarness = harness([
      session(),
      json({
        result: 'passed',
        provider: 'vercel-ai-gateway',
        model: 'anthropic/claude-sonnet-4',
      }),
    ], { identity: 'token' });
    const tested = await runProviderCli([
      'test', '--provider', 'vercel-ai-gateway', '--identity-token-file', 'identity',
      '--daemon-url', daemonUrl, '--json',
    ], testHarness.deps);
    expect(tested.exitCode).toBe(0);
    expect(testHarness.fetch.mock.calls[1]?.[0]).toBe(`${daemonUrl}/api/hosted/provider/test`);
    expect(testHarness.fetch.mock.calls[1]?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(testHarness.fetch.mock.calls[1]?.[1]?.body))).toEqual({
      provider: 'vercel-ai-gateway',
    });

    const clearHarness = harness([
      session(),
      json({ result: 'cleared', provider: null, configured: false }),
    ], { identity: 'token' });
    const cleared = await runProviderCli([
      'clear', '--identity-token-file', 'identity', '--daemon-url', daemonUrl, '--json',
    ], clearHarness.deps);
    expect(cleared.exitCode).toBe(0);
    expect(clearHarness.fetch.mock.calls[1]?.[0]).toBe(`${daemonUrl}/api/hosted/provider`);
    expect(clearHarness.fetch.mock.calls[1]?.[1]?.method).toBe('DELETE');
  });

  it('uses the identity-token environment file and stdin key without putting either secret in output', async () => {
    const h = harness([
      session(),
      json({ result: 'set', provider: 'anthropic', configured: true }),
    ], { identity: 'bearer-secret', '-': 'provider-secret\n' });
    h.deps.env = { READABLE_HOSTED_IDENTITY_TOKEN_FILE: 'identity' };

    const result = await runProviderCli([
      'set', '--provider', 'anthropic', '--key-file', '-', '--daemon-url', daemonUrl,
    ], h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.stdout.join('')).toBe('Provider anthropic configured.\n');
    expect(`${h.stdout.join('')} ${h.stderr.join('')}`).not.toMatch(/bearer-secret|provider-secret/);
  });

  it('accepts an exactly 16 KiB provider key followed by one CRLF', async () => {
    const key = 'k'.repeat(16 * 1024);
    const h = harness([
      session(),
      json({ result: 'set', provider: 'anthropic', configured: true }),
    ], { identity: 'token', key: `${key}\r\n` });

    const result = await runProviderCli([
      'set', '--provider', 'anthropic', '--key-file', 'key', '--identity-token-file', 'identity',
      '--daemon-url', daemonUrl, '--json',
    ], h.deps);

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(String(h.fetch.mock.calls[1]?.[1]?.body)) as { key: string };
    expect(Buffer.byteLength(body.key, 'utf8')).toBe(16 * 1024);
    expect(body.key.endsWith('\r') || body.key.endsWith('\n')).toBe(false);
  });

  it('rejects a provider key with an interior line break', async () => {
    const h = harness([], { identity: 'token', key: 'first\nsecond' });

    const result = await runProviderCli([
      'set', '--provider', 'anthropic', '--key-file', 'key', '--identity-token-file', 'identity',
      '--daemon-url', daemonUrl, '--json',
    ], h.deps);

    expect(result.exitCode).toBe(1);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(JSON.parse(h.stderr.join(''))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    });
    expect(h.stderr.join('')).not.toContain('first');
  });

  it('rejects a daemon URL containing a path before making a request', async () => {
    const h = harness([], { identity: 'token' });

    const result = await runProviderCli([
      'status', '--identity-token-file', 'identity', '--daemon-url', `${daemonUrl}/nested`, '--json',
    ], h.deps);

    expect(result.exitCode).toBe(1);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(JSON.parse(h.stderr.join(''))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    });
  });

  it.each([
    {
      name: 'plaintext secret argv',
      args: ['set', '--provider', 'anthropic', '--api-key', 'secret'],
      files: { identity: 'token' },
    },
    {
      name: 'two stdin consumers',
      args: [
        'set', '--provider', 'anthropic', '--key-file', '-', '--identity-token-file', '-',
      ],
      files: { '-': 'secret' },
    },
    {
      name: 'empty provider key',
      args: [
        'set', '--provider', 'anthropic', '--key-file', 'key', '--identity-token-file', 'identity',
      ],
      files: { identity: 'token', key: '\n' },
    },
    {
      name: 'NUL provider key',
      args: [
        'set', '--provider', 'anthropic', '--key-file', 'key', '--identity-token-file', 'identity',
      ],
      files: { identity: 'token', key: 'bad\0key' },
    },
    {
      name: 'oversized provider key',
      args: [
        'set', '--provider', 'anthropic', '--key-file', 'key', '--identity-token-file', 'identity',
      ],
      files: { identity: 'token', key: 'x'.repeat(16 * 1024 + 1) },
    },
    {
      name: 'unsupported provider',
      args: [
        'set', '--provider', 'custom', '--key-file', 'key', '--identity-token-file', 'identity',
      ],
      files: { identity: 'token', key: 'secret' },
    },
  ])('rejects $name before making a request', async ({ args, files }) => {
    const h = harness([], files);
    const result = await runProviderCli([...args, '--daemon-url', daemonUrl, '--json'], h.deps);
    expect(result.exitCode).toBe(1);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.stdout).toEqual([]);
    expect(JSON.parse(h.stderr.join(''))).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    if (files.key && files.key.trim().length > 0 && files.key.length < 128) {
      expect(h.stderr.join('')).not.toContain(files.key);
    }
  });

  it('rejects a session public origin that differs from the daemon origin', async () => {
    const h = harness([
      json({
        publicOrigin: 'https://attacker.example',
        csrfToken: 'csrf',
        csrfExpiresAt: Date.now() + 60_000,
        providers: [],
      }),
    ], { identity: 'token' });
    const result = await runProviderCli([
      'status', '--identity-token-file', 'identity', '--daemon-url', daemonUrl, '--json',
    ], h.deps);
    expect(result.exitCode).toBe(1);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.stderr.join('')).toContain('HOSTED_ORIGIN_MISMATCH');
  });

  it('rejects cross-origin redirects without following them', async () => {
    const h = harness([
      new Response(null, { status: 307, headers: { location: 'https://attacker.example/session' } }),
    ], { identity: 'token' });
    const result = await runProviderCli([
      'status', '--identity-token-file', 'identity', '--daemon-url', daemonUrl, '--json',
    ], h.deps);
    expect(result.exitCode).toBe(1);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.stderr.join('')).toContain('CROSS_ORIGIN_REDIRECT');
  });
});
