import { createServer } from 'node:http';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { runDatabricksCli } from '../src/databricks-cli.js';
import { registerDatabricksRoutes } from '../src/databricks-routes.js';
import { listenOnFetchCompatiblePort } from '../src/fetch-compatible-listener.js';
import { chatStream, json, namedFixture } from './databricks/named-fixture.js';

// Real CLI -> HTTP routes -> service -> store; only the external workspace is a wire fake.
describe('named CLI through daemon HTTP', () => {
  it.each(['argument', 'stdin', 'flag'] as const)('adds a batch with per-name JSON using %s input', async mode => {
    // Given
    const { service, profileId } = await namedFixture(async (url, init) => init.method !== 'POST' ? json({}, 403)
      : new URL(url).pathname.includes('typo') ? json({ error_code: 'RESOURCE_DOES_NOT_EXIST' }, 404) : chatStream());
    const app = express(); app.use(express.json());
    registerDatabricksRoutes(app, { service, setClient: async () => service.status(), http: { requireLocalDaemonRequest: (_req, _res, next) => next() } });
    const server = createServer(app); const { port } = await listenOnFetchCompatiblePort(server);
    let output = '';
    const names = 'hidden-model,typo';
    const input = mode === 'argument' ? [names] : mode === 'stdin' ? ['--prompt-file', '-'] : ['--names', names];
    try {
      // When
      const result = await runDatabricksCli(['add', ...input, '--profile', profileId, '--allow-inference', '--json'], {
        resolveDaemonUrl: async () => `http://127.0.0.1:${port}`, readStdin: async () => names,
        stdout: text => { output += text; }, stderr: () => {},
      });
      // Then
      expect(result.exitCode).toBe(3);
      const parsed = JSON.parse(output);
      expect(parsed).toMatchObject({ state: 'partial', inputResults: [
        { inputIndex: 0, displayName: 'hidden-model', state: 'chat-only', attempts: 1 },
        { inputIndex: 1, displayName: 'typo', state: 'failed', failure: { reason: 'name-not-found', action: 'correct-name', upstreamStatus: 404 } },
      ] });
      expect(parsed.endpoints[0].enabled).toBe(true);
      expect((await service.listModels()).models).toHaveLength(1);
      expect(output).not.toContain('test-token');
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it('rejects conflicting input before contacting the daemon', async () => {
    // Given
    let requests = 0;
    // When
    const result = await runDatabricksCli(['add', 'model', '--names', 'other', '--profile', 'p', '--allow-inference', '--json'], {
      resolveDaemonUrl: async () => { requests++; return 'http://127.0.0.1:1'; }, stdout: () => {}, stderr: () => {},
    });
    // Then
    expect(result.exitCode).toBe(2); expect(requests).toBe(0);
  });
});
