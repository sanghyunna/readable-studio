import type http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import * as platform from '@readable-studio/platform';
import { startServer } from '../src/server.js';
import { AIHUBMIX_APP_CODE } from '../src/aihubmix.js';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

describe('API proxy routes', () => {
  const realFetch = globalThis.fetch;
  const originalMediaConfigDir = process.env.READABLE_MEDIA_CONFIG_DIR;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(async () => {
    if (originalMediaConfigDir == null) delete process.env.READABLE_MEDIA_CONFIG_DIR;
    else process.env.READABLE_MEDIA_CONFIG_DIR = originalMediaConfigDir;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('converts OpenAI-compatible CRLF SSE chunks into proxy delta/end events', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(sseResponse([
        'data: {"choices":[{"delta":',
        'data: {"content":"hi"}}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\r\n')));
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/api/proxy/openai/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    await expect(res.text()).resolves.toContain('event: delta\ndata: {"delta":"hi"}');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }),
        redirect: 'error',
      }),
    );
  });

  it.each([
    {
      provider: 'anthropic',
      path: '/api/proxy/anthropic/stream',
      body: {
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant',
        model: 'claude-test',
        messages: [{ role: 'user', content: 'hello' }],
      },
      response: sseResponse('event: message_stop\ndata: {}\n\n'),
    },
    {
      provider: 'openai',
      path: '/api/proxy/openai/stream',
      body: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-openai',
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }],
      },
      response: sseResponse('data: [DONE]\n\n'),
    },
    {
      provider: 'azure',
      path: '/api/proxy/azure/stream',
      body: {
        baseUrl: 'https://resource.openai.azure.com',
        apiKey: 'azure-key',
        model: 'deployment-one',
        apiVersion: '2024-10-21',
        messages: [{ role: 'user', content: 'hello' }],
      },
      response: sseResponse('data: [DONE]\n\n'),
    },
    {
      provider: 'google',
      path: '/api/proxy/google/stream',
      body: {
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'google-key',
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'hello' }],
      },
      response: sseResponse('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n'),
    },
    {
      provider: 'ollama',
      path: '/api/proxy/ollama/stream',
      body: {
        baseUrl: 'https://ollama.example.com',
        apiKey: 'ollama-key',
        model: 'llama3',
        messages: [{ role: 'user', content: 'hello' }],
      },
      response: new Response(new TextEncoder().encode('{"done":true}\n'), {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      }),
    },
    {
      provider: 'senseaudio',
      path: '/api/proxy/senseaudio/stream',
      body: {
        baseUrl: 'https://api.senseaudio.cn',
        apiKey: 'sa-key',
        model: 'senseaudio-s2',
        projectId: 'test-project',
        messages: [{ role: 'user', content: 'hello' }],
      },
      response: sseResponse('data: [DONE]\n\n'),
    },
  ])('uses the live proxy dispatcher for $provider proxy requests', async ({ path, body, response }) => {
    const proxySpy = vi.spyOn(platform, 'resolveSystemProxyEnv').mockReturnValue({
      HTTPS_PROXY: 'http://system-proxy.internal:8443',
      NODE_USE_ENV_PROXY: '1',
    });
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      expect(init?.dispatcher).toBeDefined();
      return Promise.resolve(response.clone());
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const res = await realFetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(200);
      await res.text();
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) => !String(input).startsWith(baseUrl) && init?.dispatcher,
        ),
      ).toBe(true);
    } finally {
      proxySpy.mockRestore();
    }
  });

  it('uses the live proxy dispatcher for Tavily research search', async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), 'readable-tavily-proxy-route-'));
    process.env.READABLE_MEDIA_CONFIG_DIR = configDir;
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, 'media-config.json'), JSON.stringify({
      providers: {
        tavily: {
          apiKey: 'tavily-test-key',
          baseUrl: 'https://tavily-gateway.example.test',
        },
      },
    }), 'utf8');

    const proxySpy = vi.spyOn(platform, 'resolveSystemProxyEnv').mockReturnValue({
      HTTPS_PROXY: 'http://system-proxy.internal:8443',
      NODE_USE_ENV_PROXY: '1',
    });
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      expect(url).toBe('https://tavily-gateway.example.test/search');
      expect(init?.dispatcher).toBeDefined();
      return Promise.resolve(Response.json({
        answer: 'Proxy-safe summary',
        results: [
          {
            title: 'Proxy-safe source',
            url: 'https://example.test/source',
            content: 'Snippet',
          },
        ],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const res = await realFetch(`${baseUrl}/api/research/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: 'proxy-aware research',
          providers: ['tavily'],
        }),
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual(expect.objectContaining({
        query: 'proxy-aware research',
        provider: 'tavily',
        summary: 'Proxy-safe summary',
        sources: [
          expect.objectContaining({
            title: 'Proxy-safe source',
            url: 'https://example.test/source',
          }),
        ],
      }));
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) => input === 'https://tavily-gateway.example.test/search' && init?.dispatcher,
        ),
      ).toBe(true);
    } finally {
      proxySpy.mockRestore();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('reports malformed proxy env before sending the start event on Anthropic streams', async () => {
    const originalHttpProxy = process.env.HTTP_PROXY;
    const originalHttpsProxy = process.env.HTTPS_PROXY;
    const originalAllProxy = process.env.ALL_PROXY;
    process.env.HTTP_PROXY = 'not a valid proxy url';
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;

    try {
      const res = await realFetch(`${baseUrl}/api/proxy/anthropic/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'sk-ant',
          model: 'claude-test',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('event: error');
      expect(text).toContain('INTERNAL_ERROR');
      expect(text).not.toContain('event: start');
    } finally {
      if (originalHttpProxy === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = originalHttpProxy;
      if (originalHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = originalHttpsProxy;
      if (originalAllProxy === undefined) delete process.env.ALL_PROXY;
      else process.env.ALL_PROXY = originalAllProxy;
    }
  });

  // Regression: appendVersionedApiPath needs to thread three shapes:
  //   * bare host                  → inject /v1 (api.openai.com)
  //   * sub-path containing /vN    → no inject (api.deepinfra.com/v1/openai)
  //   * sub-path without /vN       → inject /v1 (api.deepseek.com/anthropic)
  // The earlier end-of-path check broke the second case; a "non-empty
  // path → respect verbatim" intermediate fix broke the third. Pin all
  // three so neither regression returns.
  it.each([
    [
      'https://api.deepinfra.com/v1/openai',
      'https://api.deepinfra.com/v1/openai/chat/completions',
    ],
    [
      'https://api.deepinfra.com/v1/openai/',
      'https://api.deepinfra.com/v1/openai/chat/completions',
    ],
    [
      'https://openrouter.ai/api/v1',
      'https://openrouter.ai/api/v1/chat/completions',
    ],
    [
      'https://api.openai.com',
      'https://api.openai.com/v1/chat/completions',
    ],
    [
      'https://api.openai.com/',
      'https://api.openai.com/v1/chat/completions',
    ],
  ])('routes OpenAI baseUrl %s to %s', async (input, expected) => {
    const fetchMock = vi.fn((req: FetchInput, init?: FetchInit) => {
      const url = String(req);
      if (url.startsWith(baseUrl)) return realFetch(req, init);
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    });
    vi.stubGlobal('fetch', fetchMock);

    await realFetch(`${baseUrl}/api/proxy/openai/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: input,
        apiKey: 'sk-test',
        model: 'm',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(String(fetchMock.mock.calls[0]![0])).toBe(expected);
  });

  // The Anthropic proxy goes through the same `appendVersionedApiPath`
  // helper, but its preset table includes Anthropic-compatible gateways
  // mounted at non-versioned sub-paths (DeepSeek `/anthropic`, MiniMax
  // `/anthropic`, MiMo `/anthropic`). Those still need the `/v1`
  // injection, otherwise upstream returns 404 on `.../anthropic/messages`.
  it.each([
    [
      'https://api.anthropic.com',
      'https://api.anthropic.com/v1/messages',
    ],
    [
      'https://api.deepseek.com/anthropic',
      'https://api.deepseek.com/anthropic/v1/messages',
    ],
    [
      'https://api.minimaxi.com/anthropic',
      'https://api.minimaxi.com/anthropic/v1/messages',
    ],
    [
      'https://token-plan-cn.xiaomimimo.com/anthropic',
      'https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages',
    ],
  ])('routes Anthropic baseUrl %s to %s', async (input, expected) => {
    const fetchMock = vi.fn((req: FetchInput, init?: FetchInit) => {
      const url = String(req);
      if (url.startsWith(baseUrl)) return realFetch(req, init);
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    });
    vi.stubGlobal('fetch', fetchMock);

    await realFetch(`${baseUrl}/api/proxy/anthropic/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: input,
        apiKey: 'sk-test',
        model: 'm',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(String(fetchMock.mock.calls[0]![0])).toBe(expected);
  });

  it('allows loopback API base URLs for local OpenAI-compatible providers', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/api/proxy/openai/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'http://localhost:11434/v1',
        apiKey: 'sk-local',
        model: 'llama-local',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain('event: end');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-local' }),
        redirect: 'error',
      }),
    );
  });

  it('allows IPv4-mapped loopback API base URLs for local OpenAI-compatible providers', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/api/proxy/openai/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'http://[::ffff:127.0.0.1]:11434/v1',
        apiKey: 'sk-local',
        model: 'llama-local',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain('event: end');
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://[::ffff:7f00:1]:11434/v1/chat/completions',
    );
  });

  it('blocks private network API base URLs before proxying', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/api/proxy/openai/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'http://192.168.1.50:11434/v1',
        apiKey: 'sk-private',
        model: 'private-model',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(res.status).toBe(403);
    await expect(res.text()).resolves.toContain('Internal IPs blocked');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'http://0.0.0.0:11434/v1',
    'http://100.64.0.1:11434/v1',
    'http://169.254.169.254/latest/meta-data',
    'http://224.0.0.1:11434/v1',
    'http://[::]/v1',
    'http://[::ffff:192.168.1.50]:11434/v1',
    'http://[fd00::1]:11434/v1',
    'http://[fe80::1]:11434/v1',
  ])('blocks local and private API base URL form %s before proxying', async (privateBaseUrl) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/api/proxy/openai/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: privateBaseUrl,
        apiKey: 'sk-private',
        model: 'private-model',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(res.status).toBe(403);
    await expect(res.text()).resolves.toContain('Internal IPs blocked');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces OpenAI-compatible in-stream error frames', async () => {
    vi.stubGlobal('fetch', vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(sseResponse('data: {"error":{"message":"bad model"}}\n\n'));
    }));

    const res = await realFetch(`${baseUrl}/api/proxy/openai/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        model: 'bad-model',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    await expect(res.text()).resolves.toContain('Provider error: bad model');
  });

  it('uses Azure deployment URLs and api-key auth', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    });
    vi.stubGlobal('fetch', fetchMock);

    await realFetch(`${baseUrl}/api/proxy/azure/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://resource.openai.azure.com',
        apiKey: 'azure-key',
        model: 'deployment-one',
        apiVersion: '2024-10-21',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const [upstreamUrl, upstreamInit] = fetchMock.mock.calls[0]!;
    expect(String(upstreamUrl)).toBe(
      'https://resource.openai.azure.com/openai/deployments/deployment-one/chat/completions?api-version=2024-10-21',
    );
    expect(upstreamInit?.headers).toMatchObject({ 'api-key': 'azure-key' });
    expect(upstreamInit?.redirect).toBe('error');
  });

  it('retries Azure OpenAI-compatible v1 alias requests with max_completion_tokens when max_tokens is rejected', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if ('max_tokens' in body) {
        return Promise.resolve(new Response(
          JSON.stringify({
            error: {
              message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
              type: 'invalid_request_error',
              param: 'max_tokens',
              code: 'unsupported_parameter',
            },
          }),
          {
            status: 400,
            headers: { 'content-type': 'application/json' },
          },
        ));
      }
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    });
    vi.stubGlobal('fetch', fetchMock);

    await realFetch(`${baseUrl}/api/proxy/azure/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://resource.services.ai.azure.com/api/projects/project/openai/v1',
        apiKey: 'azure-key',
        model: 'prod',
        apiVersion: '',
        maxTokens: 1234,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const upstreamCalls = fetchMock.mock.calls.filter(
      ([input]) => !String(input).startsWith(baseUrl),
    );
    expect(upstreamCalls).toHaveLength(2);
    const firstBody = JSON.parse(String(upstreamCalls[0]![1]?.body));
    const secondBody = JSON.parse(String(upstreamCalls[1]![1]?.body));
    expect(firstBody).toMatchObject({
      model: 'prod',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 1234,
      stream: true,
    });
    expect(firstBody).not.toHaveProperty('max_completion_tokens');
    expect(secondBody).toMatchObject({
      model: 'prod',
      messages: [{ role: 'user', content: 'hello' }],
      max_completion_tokens: 1234,
      stream: true,
    });
    expect(secondBody).not.toHaveProperty('max_tokens');
  });

  it('retries Azure deployment-mode requests with max_completion_tokens when max_tokens is rejected', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if ('max_tokens' in body) {
        return Promise.resolve(new Response(
          JSON.stringify({
            error: {
              message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
              type: 'invalid_request_error',
              param: 'max_tokens',
              code: 'unsupported_parameter',
            },
          }),
          {
            status: 400,
            headers: { 'content-type': 'application/json' },
          },
        ));
      }
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/api/proxy/azure/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://resource.openai.azure.com',
        apiKey: 'azure-key',
        model: 'prod',
        apiVersion: '',
        maxTokens: 1234,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    await expect(res.text()).resolves.toContain('event: end');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body));
    expect(firstBody).toMatchObject({ max_tokens: 1234, stream: true });
    expect(firstBody).not.toHaveProperty('max_completion_tokens');
    expect(secondBody).toMatchObject({ max_completion_tokens: 1234, stream: true });
    expect(secondBody).not.toHaveProperty('max_tokens');
  });

  it('keeps max_tokens for legacy OpenAI-compatible chat-completions payloads', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    });
    vi.stubGlobal('fetch', fetchMock);

    await realFetch(`${baseUrl}/api/proxy/openai/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        maxTokens: 4321,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const [, upstreamInit] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(upstreamInit?.body))).toMatchObject({
      model: 'gpt-4o',
      max_tokens: 4321,
      stream: true,
    });
    expect(JSON.parse(String(upstreamInit?.body))).not.toHaveProperty(
      'max_completion_tokens',
    );
  });

  it('keeps max_tokens for DeepSeek-style OpenAI-compatible hosts', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    });
    vi.stubGlobal('fetch', fetchMock);

    await realFetch(`${baseUrl}/api/proxy/openai/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-test',
        model: 'deepseek-chat',
        maxTokens: 2222,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const [upstreamUrl, upstreamInit] = fetchMock.mock.calls[0]!;
    expect(String(upstreamUrl)).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(JSON.parse(String(upstreamInit?.body))).toMatchObject({
      model: 'deepseek-chat',
      max_tokens: 2222,
      stream: true,
    });
    expect(JSON.parse(String(upstreamInit?.body))).not.toHaveProperty(
      'max_completion_tokens',
    );
  });

  it('keeps max_tokens for Azure gpt-4o deployment chat-completions payloads', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    });
    vi.stubGlobal('fetch', fetchMock);

    await realFetch(`${baseUrl}/api/proxy/azure/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://resource.openai.azure.com',
        apiKey: 'azure-key',
        model: 'gpt-4o',
        apiVersion: '',
        maxTokens: 3333,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const [, upstreamInit] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(upstreamInit?.body))).toMatchObject({
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 3333,
      stream: true,
    });
    expect(JSON.parse(String(upstreamInit?.body))).not.toHaveProperty(
      'max_completion_tokens',
    );
  });

  it.each([
    ['anthropic', 'https://api.anthropic.com/v1/messages'],
    ['openai', 'https://api.openai.com/v1/chat/completions'],
    [
      'azure',
      'https://resource.openai.azure.com/openai/deployments/model-one/chat/completions?api-version=2024-10-21',
    ],
    [
      'google',
      'https://generativelanguage.googleapis.com/v1beta/models/model-one:streamGenerateContent?alt=sse',
    ],
  ])('disables upstream redirects for %s proxy requests', async (provider, expectedUrl) => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      if (url === expectedUrl && init?.redirect === 'error') {
        return Promise.reject(new TypeError('fetch failed: redirect blocked'));
      }
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const requestBody: Record<string, unknown> = {
      baseUrl:
        provider === 'azure'
          ? 'https://resource.openai.azure.com'
          : provider === 'google'
            ? 'https://generativelanguage.googleapis.com'
            : provider === 'anthropic'
              ? 'https://api.anthropic.com'
              : 'https://api.openai.com',
      apiKey: `${provider}-key`,
      model: 'model-one',
      messages: [{ role: 'user', content: 'hello' }],
    };
    if (provider === 'azure') requestBody.apiVersion = '2024-10-21';

    const res = await realFetch(`${baseUrl}/api/proxy/${provider}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    const text = await res.text();
    expect(text).toContain('event: error');
    const [upstreamUrl, upstreamInit] = fetchMock.mock.calls[0]!;
    expect(String(upstreamUrl)).toBe(expectedUrl);
    expect(upstreamInit?.redirect).toBe('error');
  });

  it('keeps the default Azure api-version for deployment URLs when the field is blank', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    });
    vi.stubGlobal('fetch', fetchMock);

    await realFetch(`${baseUrl}/api/proxy/azure/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://resource.openai.azure.com',
        apiKey: 'azure-key',
        model: 'deployment-one',
        apiVersion: '',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const [upstreamUrl] = fetchMock.mock.calls[0]!;
    expect(String(upstreamUrl)).toBe(
      'https://resource.openai.azure.com/openai/deployments/deployment-one/chat/completions?api-version=2024-10-21',
    );
  });

  it('omits Azure api-version for OpenAI-compatible v1 paths when the field is blank', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    });
    vi.stubGlobal('fetch', fetchMock);

    await realFetch(`${baseUrl}/api/proxy/azure/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://resource.services.ai.azure.com/api/projects/project/openai/v1',
        apiKey: 'azure-key',
        model: 'deployment-one',
        apiVersion: '',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const [upstreamUrl, upstreamInit] = fetchMock.mock.calls[0]!;
    expect(String(upstreamUrl)).toBe(
      'https://resource.services.ai.azure.com/api/projects/project/openai/v1/chat/completions',
    );
    expect(JSON.parse(String(upstreamInit?.body))).toMatchObject({
      model: 'deployment-one',
    });
  });

  it('removes copied Azure api-version query params for OpenAI-compatible v1 paths when the field is blank', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    });
    vi.stubGlobal('fetch', fetchMock);

    await realFetch(`${baseUrl}/api/proxy/azure/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl:
          'https://resource.services.ai.azure.com/api/projects/project/openai/v1?api-version=2024-10-21',
        apiKey: 'azure-key',
        model: 'deployment-one',
        apiVersion: '',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const [upstreamUrl] = fetchMock.mock.calls[0]!;
    expect(String(upstreamUrl)).toBe(
      'https://resource.services.ai.azure.com/api/projects/project/openai/v1/chat/completions',
    );
  });

  it('surfaces Gemini safety blocks as proxy errors', async () => {
    vi.stubGlobal('fetch', vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(sseResponse('data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n'));
    }));

    const res = await realFetch(`${baseUrl}/api/proxy/google/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'google-key',
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    await expect(res.text()).resolves.toContain('Gemini blocked the prompt (SAFETY).');
  });

  it('forwards maxTokens to Gemini generation config', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(sseResponse('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n'));
    });
    vi.stubGlobal('fetch', fetchMock);

    await realFetch(`${baseUrl}/api/proxy/google/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'google-key',
        model: 'gemini-2.0-flash',
        maxTokens: 1234,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const [, upstreamInit] = fetchMock.mock.calls[0]!;
    expect(upstreamInit?.redirect).toBe('error');
    expect(JSON.parse(String(upstreamInit?.body))).toMatchObject({
      generationConfig: { maxOutputTokens: 1234 },
    });
  });

  it('normalizes Gemini model ids and base URLs in the streaming proxy', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(sseResponse('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n'));
    });
    vi.stubGlobal('fetch', fetchMock);

    await realFetch(`${baseUrl}/api/proxy/google/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'google-key',
        model: 'models/gemini-2.0-flash',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const [upstreamUrl, upstreamInit] = fetchMock.mock.calls[0]!;
    expect(String(upstreamUrl)).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse',
    );
    expect(upstreamInit?.redirect).toBe('error');
  });

  // Regression for PR #1176: the Ollama proxy fetch must also set
  // `redirect: 'error'`. Without it, a validated public host could
  // 3xx the daemon to a private/internal URL and slip past the
  // resolved-IP SSRF check that runs *before* the fetch.
  it('forwards redirect:error on the Ollama proxy upstream fetch', async () => {
    const ndjsonResponse = new Response(
      new TextEncoder().encode('{"done":true}\n'),
      {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      },
    );
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(ndjsonResponse);
    });
    vi.stubGlobal('fetch', fetchMock);

    await realFetch(`${baseUrl}/api/proxy/ollama/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://ollama.example.com',
        apiKey: 'ollama-key',
        model: 'llama3',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const [upstreamUrl, upstreamInit] = fetchMock.mock.calls[0]!;
    expect(String(upstreamUrl)).toBe('https://ollama.example.com/api/chat');
    expect(upstreamInit?.redirect).toBe('error');
  });

  it('streams delta + end for SenseAudio chat completions', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(sseResponse([
        'data: {"choices":[{"delta":{"content":"sense"}}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')));
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await realFetch(`${baseUrl}/api/proxy/senseaudio/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://api.senseaudio.cn',
        apiKey: 'sa-test',
        projectId: 'test-project',
        model: 'senseaudio-s2',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    await expect(res.text()).resolves.toContain('event: delta\ndata: {"delta":"sense"}');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.senseaudio.cn/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sa-test' }),
        redirect: 'error',
      }),
    );
  });

  it('defaults SenseAudio base URL to api.senseaudio.cn when caller omits it', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    });
    vi.stubGlobal('fetch', fetchMock);

    await realFetch(`${baseUrl}/api/proxy/senseaudio/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: 'sa-test',
        projectId: 'test-project',
        model: 'senseaudio-s2',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://api.senseaudio.cn/v1/chat/completions',
    );
  });

  it('rejects SenseAudio requests that omit apiKey or model', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const missingKey = await realFetch(`${baseUrl}/api/proxy/senseaudio/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'senseaudio-s2',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(missingKey.status).toBe(400);

    const missingModel = await realFetch(`${baseUrl}/api/proxy/senseaudio/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: 'sa-test',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(missingModel.status).toBe(400);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('disables upstream redirects for senseaudio proxy requests', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    });
    vi.stubGlobal('fetch', fetchMock);

    await realFetch(`${baseUrl}/api/proxy/senseaudio/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://api.senseaudio.cn',
        apiKey: 'sa-test',
        projectId: 'test-project',
        model: 'model-one',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const upstreamCall = fetchMock.mock.calls.find(([input]) =>
      !String(input).startsWith(baseUrl),
    );
    expect(upstreamCall).toBeDefined();
    const upstreamInit = upstreamCall![1] as FetchInit;
    expect(upstreamInit?.redirect).toBe('error');
  });

  it('routes AIHubMix to /v1/chat/completions with APP-Code header', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(sseResponse([
        'data: {"choices":[{"delta":{"content":"ok"}}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')));
    });
    vi.stubGlobal('fetch', fetchMock);

    await realFetch(`${baseUrl}/api/proxy/aihubmix/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://aihubmix.com/v1',
        apiKey: 'ah-test',
        projectId: 'test-project',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const upstreamCall = fetchMock.mock.calls.find(([input]) =>
      !String(input).startsWith(baseUrl),
    );
    expect(upstreamCall).toBeDefined();
    expect(String(upstreamCall![0])).toBe('https://aihubmix.com/v1/chat/completions');
    const init = upstreamCall![1] as FetchInit;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization ?? headers.authorization).toBe('Bearer ah-test');
    // APP-Code is injected only when the fixed code is configured; the test
    // stays green either way so an unfilled integrator constant doesn't fail CI.
    if (AIHUBMIX_APP_CODE) {
      expect(headers['APP-Code']).toBe(AIHUBMIX_APP_CODE);
    }
  });

  it('routes AIHubMix claude* models to the Anthropic /v1/messages wire', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(sseResponse([
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n')));
    });
    vi.stubGlobal('fetch', fetchMock);

    await realFetch(`${baseUrl}/api/proxy/aihubmix/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://aihubmix.com/v1',
        apiKey: 'ah-test',
        projectId: 'test-project',
        model: 'claude-opus-4-8',
        systemPrompt: 'be brief',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const upstreamCall = fetchMock.mock.calls.find(([input]) =>
      !String(input).startsWith(baseUrl),
    );
    expect(upstreamCall).toBeDefined();
    // Anthropic native endpoint on the AIHubMix origin, not /v1/chat/completions.
    expect(String(upstreamCall![0])).toBe('https://aihubmix.com/v1/messages');
    const init = upstreamCall![1] as FetchInit;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['x-api-key']).toBe('ah-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String(init?.body));
    expect(body.system).toBe('be brief'); // Anthropic-shaped (not OpenAI messages[system])
    if (AIHUBMIX_APP_CODE) {
      expect(headers['APP-Code']).toBe(AIHUBMIX_APP_CODE);
    }
  });

  it('routes AIHubMix gemini* models to the Gemini streamGenerateContent wire', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);
      return Promise.resolve(sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}',
        '',
      ].join('\n')));
    });
    vi.stubGlobal('fetch', fetchMock);

    await realFetch(`${baseUrl}/api/proxy/aihubmix/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://aihubmix.com/v1',
        apiKey: 'ah-test',
        projectId: 'test-project',
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const upstreamCall = fetchMock.mock.calls.find(([input]) =>
      !String(input).startsWith(baseUrl),
    );
    expect(upstreamCall).toBeDefined();
    // Gemini native endpoint under the /gemini sub-path of the AIHubMix origin.
    expect(String(upstreamCall![0])).toBe(
      'https://aihubmix.com/gemini/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse',
    );
    const init = upstreamCall![1] as FetchInit;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('ah-test');
    const body = JSON.parse(String(init?.body));
    expect(Array.isArray(body.contents)).toBe(true); // Gemini-shaped
    if (AIHUBMIX_APP_CODE) {
      expect(headers['APP-Code']).toBe(AIHUBMIX_APP_CODE);
    }
  });

  // Plan §3.A4 / spec §11.8 (e2e-7): the API-fallback proxy paths must
  // never carry plugin context. The web sidecar's fallback mode bypasses
  // the daemon snapshot bus, so any pluginId / appliedPluginSnapshotId in
  // the body short-circuits with 409 PLUGIN_REQUIRES_DAEMON. This is the
  // behavioral anchor for e2e-7 and is exercised against every proxy entry.
  describe('API fallback rejects plugin runs', () => {
    const proxies = [
      '/api/proxy/anthropic/stream',
      '/api/proxy/openai/stream',
      '/api/proxy/azure/stream',
      '/api/proxy/google/stream',
      '/api/proxy/senseaudio/stream',
    ];

    for (const path of proxies) {
      it(`rejects pluginId on ${path} with 409 PLUGIN_REQUIRES_DAEMON`, async () => {
        const res = await realFetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'sk-test',
            model: 'gpt-test',
            messages: [{ role: 'user', content: 'hello' }],
            pluginId: 'sample-plugin',
          }),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body?.error?.code).toBe('PLUGIN_REQUIRES_DAEMON');
      });

      it(`rejects appliedPluginSnapshotId on ${path}`, async () => {
        const res = await realFetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'sk-test',
            model: 'gpt-test',
            messages: [{ role: 'user', content: 'hello' }],
            appliedPluginSnapshotId: '00000000-0000-0000-0000-000000000000',
          }),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body?.error?.code).toBe('PLUGIN_REQUIRES_DAEMON');
      });
    }
  });
});

function sseResponse(text: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}
