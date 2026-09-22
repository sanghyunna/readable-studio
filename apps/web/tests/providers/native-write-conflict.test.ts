import { afterEach, expect, it, vi } from 'vitest';
import { streamViaDaemon } from '../../src/providers/daemon';
afterEach(() => vi.unstubAllGlobals());
it('delivers the terminal recovery checkpoint rather than the earlier native conflict', async () => {
  // Given a watcher conflict followed by terminal recovery, with REST already terminal.
  const details = { kind: 'native-overwrite', path: 'index.html' };
  const finalDetails = { ...details, checkpointId: 'saved-checkpoint', sidecar: 'index.agent-run.html' };
  const frames = [details, finalDetails].map(item => `event: error\ndata: ${JSON.stringify({ error: { code: 'CONFLICT', message: 'external write', details: item } })}\n\n`).join('') + 'event: end\ndata: {"code":1,"status":"failed"}\n\n';
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/runs') return Response.json({ runId: 'run' });
    if (url === '/api/runs/run/events') return new Response(frames, { headers: { 'content-type': 'text/event-stream' } });
    if (url === '/api/runs/run') return Response.json({ id: 'run', status: 'failed' });
    throw new Error(`Unexpected request ${url}`);
  }));
  const handlers = { onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn(), onAgentEvent: vi.fn() };
  // When the real SSE consumer reads the complete stream.
  await streamViaDaemon({ agentId: 'mock', history: [{ id: 'message', role: 'user', content: 'edit' }], systemPrompt: '', signal: new AbortController().signal, handlers });
  // Then the UI receives one error carrying the recoverable artifact, not stale metadata.
  expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'CONFLICT', details: finalDetails }));
  expect(handlers.onDone).not.toHaveBeenCalled();
});
