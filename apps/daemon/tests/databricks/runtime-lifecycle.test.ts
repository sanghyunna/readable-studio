import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { withDeadline } from '../../src/databricks/client.js';
import { startDatabricksPiSession } from '../../src/runtimes/pi-databricks.js';
import { runtimeFixture, runtimeServiceFixture } from './runtime-fixture.js';

for (const action of ['kill', 'abort', 'close-relay'] as const) {
  test(`managed Pi ${action} mid-stream drains upstream before a second turn in the same conversation`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'databricks-lifecycle-'));
    const cwd = path.join(root, 'project');
    await mkdir(cwd);
    const runtime = runtimeFixture('openai-completions');
    const { service } = runtimeServiceFixture(runtime);
    const events = new EventEmitter();
    const deadline = AbortSignal.timeout(20_000);
    const textReceived = once(events, 'text', { signal: deadline });
    const cancelled = once(events, 'cancel', { signal: deadline });
    let release!: () => void;
    const disposal = new Promise<void>((resolve) => { release = resolve; });
    let disposed = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          { type: 'response.created', response: { id: 'resp_partial', created_at: 1 } },
          { type: 'response.output_text.delta', delta: 'PARTIAL' },
        ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')));
      },
      async cancel() { events.emit('cancel'); await disposal; disposed = true; },
    });
    const options = { dataRoot: root, cwd, sessionKey: 'same-conversation', model: runtime.appModelId, service,
      prompt: 'Reply only OK.' };
    let first: Awaited<ReturnType<typeof startDatabricksPiSession>> | undefined;
    let second: Awaited<ReturnType<typeof startDatabricksPiSession>> | undefined;
    try {
      first = await startDatabricksPiSession({ ...options,
        send: (_channel, event) => { if (event.type === 'text_delta') events.emit('text'); },
        fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      });
      const completed = first.completed.then(() => ({ ok: true }), () => ({ ok: false }));
      let quiescent = false;
      void completed.then(() => { quiescent = true; });
      await textReceived;
      if (action === 'kill') first.child.kill('SIGKILL');
      else if (action === 'abort') first.session.abort();
      else void first.runtime.close();
      await cancelled;
      assert.equal(quiescent, false);
      assert.equal((await stat(first.runtime.invocation.agentDir)).isDirectory(), true);
      release();
      await withDeadline(() => completed, 10_000);
      assert.equal(disposed, true);
      assert.equal(body.locked, false);
      await assert.rejects(stat(first.runtime.invocation.agentDir), { code: 'ENOENT' });
      const output: string[] = [];
      const sessionPath = first.session.getLastSessionPath();
      const responseFixture = await readFile(new URL('./fixtures/luna-responses-stream.txt', import.meta.url), 'utf8');
      let requests = 0;
      second = await startDatabricksPiSession({ ...options,
        ...(sessionPath ? { resumeSession: { path: sessionPath, root: first.runtime.invocation.sessionDir } } : {}),
        send: (_channel, event) => { if (event.type === 'text_delta') output.push(String(event.delta)); },
        fetch: async (input) => {
          requests++;
          assert.equal(String(input), `${runtime.baseUrl}/responses`);
          return new Response(responseFixture, { headers: { 'content-type': 'text/event-stream' } });
        },
      });
      assert.equal(second.runtime.invocation.sessionDir, first.runtime.invocation.sessionDir);
      assert.notEqual(second.runtime.invocation.agentDir, first.runtime.invocation.agentDir);
      await withDeadline(() => second!.completed, 15_000);
      assert.equal(second.session.hasFatalError(), false);
      assert.equal(second.child.exitCode, 0);
      assert.equal(output.join(''), 'OK');
      assert.equal(requests, 1);
    } finally {
      release();
      for (const run of [first, second]) if (run) {
        if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL');
        await withDeadline(() => Promise.allSettled([run.completed]), 10_000);
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 40_000);
}

test('fatal managed turn captures its session and exits without a native assertion', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'databricks-fatal-'));
  const cwd = path.join(root, 'project');
  await mkdir(cwd);
  const runtime = runtimeFixture('openai-completions');
  const { service } = runtimeServiceFixture(runtime);
  const run = await startDatabricksPiSession({ dataRoot: root, cwd, sessionKey: 'fatal', model: runtime.appModelId, service,
    prompt: 'Reply OK.', send: () => {}, fetch: async () => new Response('data: {"type":"response.failed","response":{"error":{"message":"fixture failure"}}}\n\n',
      { headers: { 'content-type': 'text/event-stream' } }),
  });
  let stderr = '';
  run.child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
  try {
    await withDeadline(() => run.completed, 15_000);
    assert.equal(run.session.hasFatalError(), true);
    assert.ok(run.session.getLastSessionPath());
    assert.equal(run.child.exitCode, 0, stderr);
    assert.equal(stderr.includes('UV_HANDLE_CLOSING'), false);
  } finally {
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL');
    await withDeadline(() => Promise.allSettled([run.completed]), 10_000);
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
