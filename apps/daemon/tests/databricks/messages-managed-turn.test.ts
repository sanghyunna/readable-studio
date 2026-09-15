import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createDatabricksService } from '../../src/databricks/service.js';
import { startDatabricksPiSession } from '../../src/runtimes/pi-databricks.js';
import { normalizeResource } from '../../src/databricks/catalogue.js';
import { DatabricksStore } from '../../src/databricks/store.js';
import { withDeadline } from '../../src/databricks/client.js';
import { fixtureCliRunner, fixtureNow } from './pi-turn-fixture.js';

const metadata = { name: 'arbitrary-serving-alias', task: 'llm/v1/chat', max_output_tokens: 4096 };
const messagesPath = '/ai-gateway/anthropic/v1/messages';
const document = (turn: number) => `<!doctype html><html><body><h1>TURN_${turn}</h1></body></html>`;

function nativeStream(content: Record<string, unknown>, tool: boolean) {
  const frames = [
    { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 20, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Ready.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture_signature' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: tool ? { ...content, input: {} } : { type: 'text', text: '' } },
    ...(tool ? [{ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } }]
      : [{ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: content.text } }]),
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } },
    { type: 'message_stop' },
  ];
  const source = frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('');
  return new Response(new ReadableStream({ start(controller) {
    // Deliberately split JSON, tool arguments and SSE boundaries without timing.
    for (const byte of Buffer.from(source)) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

test('real Pi recovers to Messages, writes with a real tool, resumes natively after service restart and reports learned protocol', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'messages-recovery-'));
  const cwd = path.join(root, 'project'); await mkdir(cwd);
  const routes: string[] = [];
  let turn = 0; let messagesCalls = 0;
  const fixtureFetch: typeof fetch = async (input, init) => {
    if (!init?.method || init.method === 'GET') return Response.json(metadata);
    const route = new URL(String(input)).pathname; routes.push(route);
    if (route.endsWith('/responses')) return Response.json({ message: 'Responses API passthrough is not supported for model fixture.' }, { status: 400 });
    if (route !== messagesPath) return Response.json({ message: 'rejected parameter: tools' }, { status: 400 });
    const body = JSON.parse(String(init?.body));
    expect(body.tools).toHaveLength(4);
    expect(body.tools.every((tool: Record<string, unknown>) => tool.input_schema && !tool.function)).toBe(true);
    expect(new Headers(init?.headers).get('anthropic-version')).toBe('2023-06-01');
    messagesCalls++;
    if (messagesCalls % 2 === 1) return nativeStream({ type: 'tool_use', id: `toolu_write_${turn}`, name: 'write', input: { path: 'index.html', content: document(turn) } }, true);
    expect(JSON.stringify(body.messages)).toContain(`toolu_write_${turn}`);
    const results = body.messages.flatMap((message: { content: unknown }) => Array.isArray(message.content) ? message.content : [])
      .filter((block: { type: string }) => block.type === 'tool_result');
    expect(results.some((block: { tool_use_id: string }) => block.tool_use_id === `toolu_write_${turn}`)).toBe(true);
    return nativeStream({ type: 'text', text: 'DOCUMENT_WRITTEN' }, false);
  };
  const makeService = () => createDatabricksService({ dataRoot: root, now: () => fixtureNow, fetch: fixtureFetch,
    clientOptions: { runner: fixtureCliRunner, resolveExecutable: async () => 'fixture-databricks.exe' }, resolveResource: async () => metadata.name });
  try {
    let service = makeService();
    const profiles = await service.probe();
    const found = await service.lookup({ profileId: profiles.profiles[0]!.id, resourceId: 'fixture', kind: 'serving-endpoint' });
    expect(found.endpoint.api).toBe('openai-completions');
    const registered = await service.enable(found.endpoint.id, { scanId: found.scanId, expectedRevision: found.revision });
    let resumeSession: { path: string; root: string } | undefined;
    for (turn = 1; turn <= 2; turn++) {
      const start = routes.length;
      const events: Record<string, unknown>[] = [];
      const run = await startDatabricksPiSession({ dataRoot: root, cwd, sessionKey: 'fixture', model: registered.appModelId,
        service, fetch: fixtureFetch, prompt: 'Write index.html and summarize the saved document.',
        send: (_channel, event) => events.push(event), ...(resumeSession ? { resumeSession } : {}) });
      try {
        expect(run.runtime.invocation.args).not.toContain('--no-tools');
        const config = JSON.parse(await readFile(path.join(run.runtime.invocation.agentDir, 'models.json'), 'utf8'));
        expect(config.providers.databricks.api).toBe(turn === 1 ? 'openai-completions' : 'anthropic-messages');
        await withDeadline(() => run.completed, 25000);
        expect(run.session.hasFatalError()).toBe(false);
        expect(events.filter(event => event.type === 'text_delta').map(event => event.delta).join('')).toBe('DOCUMENT_WRITTEN');
        expect(await readFile(path.join(cwd, 'index.html'), 'utf8')).toBe(document(turn));
        const saved = run.session.getLastSessionPath(); expect(saved).toBeTruthy();
        resumeSession = { path: saved!, root: run.runtime.invocation.sessionDir };
        expect(routes.slice(start)).toEqual(turn === 1
          ? ['/serving-endpoints/arbitrary-serving-alias/invocations', messagesPath, messagesPath]
          : [messagesPath, messagesPath]);
      } finally {
        if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill();
        await withDeadline(() => Promise.allSettled([run.completed]), 5000);
      }
      service = makeService();
      const runtime = await service.resolveRuntime(registered.appModelId);
      expect(runtime.api).toBe('anthropic-messages'); expect(new URL(runtime.baseUrl).pathname).toBe('/ai-gateway/anthropic');
      expect((await service.listModels()).models[0]).toMatchObject({ api: 'anthropic-messages', protocolEvidence: { reason: 'runtime-accepted' }, capabilities: { tools: 'supported' } });
      const store = await new DatabricksStore(root).read();
      expect(store.scans.flatMap(scan => scan.endpoints).find(endpoint => endpoint.id === found.endpoint.id)?.api).toBe('anthropic-messages');
      const entry = store.entries[0]!;
      const resource = { kind: 'serving-endpoint' as const, name: metadata.name, metadata };
      expect(normalizeResource(store.secret, found.endpoint.profileId, resource, entry).endpoint.api).toBe('anthropic-messages');
      const changed = normalizeResource(store.secret, found.endpoint.profileId, { ...resource, metadata: { ...metadata, revision: 2 } }, entry);
      expect(changed.endpoint.api).toBe('openai-completions'); expect(changed.wireCapabilities).toBeUndefined();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 65000);
