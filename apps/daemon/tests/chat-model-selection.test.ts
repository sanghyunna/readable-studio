import { ok } from 'node:assert/strict';
import { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeHttpServer } from '../src/daemon-startup.js';
import { rememberLiveModels } from '../src/runtimes/models.js';
import { startServer } from '../src/server.js';
import { withFakeAgent } from './helpers/fake-agent.js';

describe('/api/chat explicit model admission before discovery', () => {
  let started: { readonly url: string; readonly server: Server };

  beforeAll(async () => {
    const result = await startServer({ port: 0, returnServer: true });
    // startServer currently exposes an unknown return type.
    ok(typeof result === 'object' && result !== null);
    ok('url' in result && typeof result.url === 'string');
    ok('server' in result && result.server instanceof Server);
    started = { url: result.url, server: result.server };
  });

  afterAll(async () => {
    await closeHttpServer(started.server);
  });

  it.each(['openai/gpt-5', 'custom/new-model'])('forwards %s when discovery remembers no models', async (model) => {
    // Given: the real CLI adapter echoes its model argument through SSE.
    await withFakeAgent('opencode', `
const args = process.argv.slice(2);
console.log(JSON.stringify({ type: 'text', part: { text: 'selected-model=' + args[args.indexOf('-m') + 1] } }));
`, async () => {
      rememberLiveModels('opencode', []);
      // When
      const response = await fetch(`${started.url}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'opencode', model, message: 'hello' }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.text();
      // Then
      expect(body).toContain(`selected-model=${model}`);
      expect(body).toContain('"status":"succeeded"');
    });
  });

  it('emits the existing typed error when discovery is empty and selection is absent', async () => {
    // Given
    await withFakeAgent('opencode', 'process.exit(0);', async () => {
      rememberLiveModels('opencode', []);
      // When
      const response = await fetch(`${started.url}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'opencode', message: 'hello' }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.text();
      // Then
      expect(body).toContain('"code":"MODEL_SELECTION_REQUIRED"');
      expect(body).toContain('"status":"failed"');
    });
  });
});
