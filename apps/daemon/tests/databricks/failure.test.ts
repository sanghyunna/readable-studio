import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { databricksFailure } from '../../src/databricks-routes.js';
import { createDatabricksRelay } from '../../src/databricks/relay.js';
import { createDatabricksPiRuntime, startDatabricksPiSession } from '../../src/runtimes/pi-databricks.js';
import { withDeadline } from '../../src/databricks/client.js';
import { runtimeFixture, runtimeServiceFixture } from './runtime-fixture.js';

test('missing portable Pi engine is a local runtime failure, not an upstream outage', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'databricks-missing-engine-'));
  const runtime = runtimeFixture();
  const { service } = runtimeServiceFixture(runtime);
  let calls = 0;
  try {
    const packageRoot = path.join(root, 'absent-pi-package');
    await mkdir(path.join(root, 'project'));
    const failure = await createDatabricksPiRuntime({ dataRoot: root, cwd: path.join(root, 'project'),
      sessionKey: 'missing-engine', model: runtime.appModelId, service, packageRoot,
      fetch: async () => { calls++; return new Response('{}'); },
    }).then(() => { throw new Error('Unexpected launch'); }, databricksFailure);
    expect(calls).toBe(0);
    expect(failure.error).toMatchObject({ reason: 'runtime-unavailable', upstreamStatus: null, retryable: false });
    expect(failure.error.message).toContain('[runtime-unavailable; no upstream response]');
    expect(JSON.stringify(failure)).not.toContain(packageRoot);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const api of ['anthropic-messages', 'openai-completions'] as const) {
  for (const stream of [false, true]) {
    test(`real Pi ${api} surfaces ${stream ? 'SSE' : 'HTTP'} failure reason/status in UI events and saved session`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'databricks-error-turn-'));
      const runtime = runtimeFixture(api);
      const { service } = runtimeServiceFixture(runtime);
      const events: Array<{ channel: string; payload: Record<string, unknown> }> = [];
      let calls = 0;
      try {
        const payload = { type: 'error', error: { type: 'rate_limit_error', message: `${runtime.apiKey} ${runtime.model} ${runtime.baseUrl}` } };
        const turn = await startDatabricksPiSession({ dataRoot: root, cwd: root, sessionKey: 'error-turn',
          model: runtime.appModelId, service, prompt: 'Reply only OK.',
          send: (channel, value) => events.push({ channel, payload: value }),
          fetch: async (_url, init) => {
            calls++;
            expect(JSON.parse(String(init?.body)).model).toBe(runtime.model);
            return stream ? new Response(`event: error\ndata: ${JSON.stringify(payload)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
              : new Response(JSON.stringify(payload), { status: 429 });
          },
        });
        try {
          await withDeadline(() => turn.completed, 25_000);
          expect(calls).toBe(1);
          expect(turn.session.hasFatalError()).toBe(true);
          const errorEvents = events.filter((event) => event.channel === 'error' || event.payload.type === 'error');
          expect(errorEvents.length).toBeGreaterThan(0);
          expect(JSON.stringify(errorEvents)).toContain(`[rate-limit; HTTP ${stream ? 200 : 429}]`);
          const savedPath = turn.session.getLastSessionPath();
          expect(savedPath).toBeTruthy();
          const saved = await readFile(savedPath!, 'utf8');
          expect(saved).toContain(`[rate-limit; HTTP ${stream ? 200 : 429}]`);
          for (const value of [runtime.apiKey, runtime.model, new URL(runtime.baseUrl).hostname]) expect(JSON.stringify(events) + saved).not.toContain(value);
        } finally {
          if (turn.child.exitCode === null && turn.child.signalCode === null) turn.child.kill('SIGKILL');
          await withDeadline(() => Promise.allSettled([turn.completed]), 5_000);
        }
      } finally { await rm(root, { recursive: true, force: true }); }
    }, 35_000);
  }
}

for (const [status, reason] of [[401, 'auth'], [403, 'permission-denied'], [404, 'model-not-found'], [400, 'bad-request'], [422, 'bad-request'], [429, 'rate-limit'], [503, 'upstream-server']] as const) {
  test(`relay surfaces ${reason} and HTTP ${status} without upstream identity`, async () => {
    const runtime = runtimeFixture();
    const relay = await createDatabricksRelay({ runtime, fetch: async () => new Response(JSON.stringify({
      message: `Bearer ${runtime.apiKey} ${new URL(runtime.baseUrl).hostname} ${encodeURIComponent(runtime.model)}`,
      details: [{ token: runtime.apiKey, host: runtime.baseUrl, model_service: runtime.model }],
    }), { status }) });
    try {
      const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias }) });
      const text = await response.text();
      expect(response.status).toBe(status);
      expect(JSON.parse(text).error).toMatchObject({ reason, upstreamStatus: status });
      expect(JSON.parse(text).error.message).toContain(`[${reason}; HTTP ${status}]`);
      for (const secret of [runtime.apiKey, runtime.model, encodeURIComponent(runtime.model), new URL(runtime.baseUrl).hostname, runtime.baseUrl]) expect(text).not.toContain(secret);
    } finally { await relay.close(); }
  });
}
