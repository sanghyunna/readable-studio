import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { DatabricksFailureCapture } from '../../src/databricks/failure-capture.js';
import { createDatabricksRelay } from '../../src/databricks/relay.js';
import { startDatabricksPiSession } from '../../src/runtimes/pi-databricks.js';
import { withDeadline } from '../../src/databricks/client.js';
import { runtimeFixture, runtimeServiceFixture } from './runtime-fixture.js';

const reason = 'Context limit exceeded';
const code = 'context_length_exceeded';
const param = 'max_output_tokens';
const error = { message: reason, code, param };

for (const surface of ['response.failed', 'event:error', 'json', 'http', 'gateway-code', 'capture-fault'] as const) {
  test(`retains rejection diagnostics in failure, capture and daemon log when ${surface} rejects`, async () => {
    // Given: the gateway returns a structured rejection through each supported error surface.
    const captures: DatabricksFailureCapture[] = [];
    const runtime = { ...runtimeFixture('openai-completions'), captureFailure: async (capture: DatabricksFailureCapture) => {
      captures.push(capture);
      if (surface === 'capture-fault') throw new Error('private disk error');
    } };
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const relay = await createDatabricksRelay({ runtime, fetch: async () => {
      switch (surface) {
        case 'response.failed': return new Response(`data: ${JSON.stringify({ type: surface, response: { error } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        case 'event:error': return new Response(`event: error\ndata: ${JSON.stringify({ error })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        case 'json':
        case 'capture-fault': return Response.json({ error });
        case 'http': return Response.json({ error }, { status: 422 });
        case 'gateway-code': return Response.json({ message: reason, error_code: code, parameter: param }, { status: 422 });
      }
    } });
    try {
      // When: a tool-enabled request reaches the Responses route.
      const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST',
        headers: { authorization: `Bearer ${relay.capabilityKey}` },
        body: JSON.stringify({ model: relay.modelAlias, messages: [{ role: 'user', content: 'Hello' }],
          tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }] }),
      });
      const text = await response.text();
      // Then: the failure is still terminal, with the upstream diagnostic in every sink.
      expect(text).toContain('"type":"error"');
      for (const sink of [text, JSON.stringify(log.mock.calls), JSON.stringify(captures)]) {
        for (const detail of [reason, code, param]) expect(sink).toContain(detail);
      }
      expect(log).toHaveBeenCalledTimes(1);
      expect(captures).toHaveLength(1);
      expect(text + JSON.stringify(log.mock.calls)).not.toContain('private disk error');
    } finally { await relay.close(); log.mockRestore(); }
  });
}

for (const surface of ['stream', 'strict-http-400'] as const) test(`retains diagnostics and redacts secrets in real Pi errors, sessions and logs when ${surface} rejects`, async () => {
  // Given: a real managed Pi child and either a stream error or the exact VDI rejection.
  const reason = surface === 'strict-http-400' ? 'tools.0.custom.strict: Extra inputs are not permitted' : 'Context limit exceeded';
  const code = surface === 'strict-http-400' ? 'BAD_REQUEST' : 'context_length_exceeded';
  const param = surface === 'strict-http-400' ? 'tools.0.custom.strict' : 'max_output_tokens';
  const root = await mkdtemp(join(tmpdir(), 'databricks-diagnostic-turn-'));
  const runtime = runtimeFixture('openai-completions');
  const { service } = runtimeServiceFixture(runtime);
  const prompt = 'PRIVATE USER CONTENT FOR DIAGNOSTIC TEST';
  const foreignKey = 'sk-proj-abcdefghijklmnopqrstuv';
  const foreignPassword = 'upstream-password-private';
  const secrets = [runtime.apiKey, runtime.model, encodeURIComponent(runtime.model),
    runtime.baseUrl, new URL(runtime.baseUrl).hostname, prompt, foreignKey, foreignPassword];
  const events: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    // When: Responses rejects the turn (capture persistence is intentionally not configured).
    const turn = await startDatabricksPiSession({ dataRoot: root, cwd: root, sessionKey: 'diagnostic',
      model: runtime.appModelId, service, prompt,
      send: (channel, payload) => events.push({ channel, payload }),
      fetch: async () => surface === 'strict-http-400'
        ? Response.json({ message: reason, error_code: code }, { status: 400 })
        : new Response(`data: ${JSON.stringify({ type: 'response.failed', response: { error: {
          ...error, message: `${reason}; ${secrets.slice(0, -2).join(' ')}; api_key=${foreignKey}; password=${foreignPassword}`,
        }, output: [{ content: prompt }] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }),
    });
    try {
      await withDeadline(() => turn.completed, 25_000);
      // Then: the actual user event and persisted assistant error preserve diagnostics, never secrets.
      expect(turn.session.hasFatalError()).toBe(true);
      const failures = events.filter(event => event.channel === 'error' || event.payload.type === 'error');
      const savedPath = turn.session.getLastSessionPath();
      if (!savedPath) throw new Error('Missing saved session');
      const saved = (await readFile(savedPath, 'utf8')).split('\n').filter(line => line.includes('errorMessage')).join('\n');
      for (const sink of [JSON.stringify(failures), saved, JSON.stringify(log.mock.calls)]) {
        for (const detail of [reason, code, param]) expect(sink).toContain(detail);
        if (surface === 'strict-http-400') expect(sink).toContain('HTTP 400');
        for (const secret of secrets) expect(sink).not.toContain(secret);
      }
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      if (turn.child.exitCode === null && turn.child.signalCode === null) turn.child.kill('SIGKILL');
      await withDeadline(() => Promise.allSettled([turn.completed]), 5_000);
    }
  } finally { log.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
