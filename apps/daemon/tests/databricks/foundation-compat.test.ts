import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { createDatabricksRelay } from '../../src/databricks/relay.js';
import { startDatabricksPiSession } from '../../src/runtimes/pi-databricks.js';
import { runtimeFixture, runtimeServiceFixture } from './runtime-fixture.js';

// Captured MLflow validation signatures and content dialect, not model-name routing.
const unsupportedResponses = { error_code: 'BAD_REQUEST', message: 'Responses API passthrough is not supported for model arbitrary-deployment.' };
const unknownTokens = { error_code: 'BAD_REQUEST', message: 'Bad request: json: unknown field "max_completion_tokens"\n' };
const outputCeiling = { error_code: 'BAD_REQUEST', message: 'max_new_tokens 128000 cannot be greater than max_output_tokens 25000.\n' };
const content = [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Checked the file.' }] }, { type: 'text', text: 'FOUNDATION_OK' }];
const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }];
const completion = { id: 'chatcmpl_fixture', object: 'chat.completion', created: 1, model: 'private-model',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } };
const stream = `data: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;

function foundationFetch(requests: Array<{ route: string; body: any }>): typeof fetch {
  return async (input, init) => {
    const route = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body));
    requests.push({ route, body });
    if (route.endsWith('/responses')) return Response.json(unsupportedResponses, { status: 400 });
    if (body.max_completion_tokens !== undefined) return Response.json(unknownTokens, { status: 400 });
    if (body.max_tokens > 25000) return Response.json(outputCeiling, { status: 400 });
    assert.ok(body.max_tokens === undefined || body.max_tokens === 25000);
    assert.ok(body.tools.every((tool: any) => tool.type === 'function' && tool.function));
    assert.ok(Array.isArray(body.messages));
    return body.stream ? new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) : Response.json(completion);
  };
}

test('measured foundation capabilities select Chat, accepted token field and ceiling, cached across tool rounds', async () => {
  const runtime = runtimeFixture('openai-completions');
  runtime.model = 'renamed.custom-service'; // Identity cannot decide the wire recipe.
  const requests: Array<{ route: string; body: any }> = [];
  const relay = await createDatabricksRelay({ runtime, fetch: foundationFetch(requests) });
  try {
    for (let round = 0; round < 2; round++) {
      const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` },
        body: JSON.stringify({ model: relay.modelAlias, messages: [{ role: 'user', content: 'Read the file.' }], tools, reasoning_effort: 'high', max_completion_tokens: 128000 }) });
      assert.equal(response.status, 200);
      const result = await response.json() as any;
      assert.equal(result.choices[0].message.content, 'FOUNDATION_OK');
      assert.equal(result.choices[0].message.reasoning_content, 'Checked the file.');
    }
    assert.deepEqual(requests.map(x => x.route.split('/').at(-1)), ['responses', 'completions', 'completions', 'completions', 'completions']);
    assert.deepEqual(requests[0]!.body.reasoning, { effort: 'high' });
    for (const request of requests.slice(1)) assert.equal(request.body.reasoning_effort, 'high');
    assert.equal(requests.at(-1)!.body.max_tokens, 25000);
    assert.deepEqual(requests.at(-1)!.body.tools, tools);
  } finally { await relay.close(); }
});

test('real Pi renders unknown foundation limits, negotiates its wire shape and emits typed-block text', async () => {
  const runtime = runtimeFixture('openai-completions');
  runtime.reasoningOptions = [];
  runtime.capabilities = { tools: 'unknown', images: 'unknown', contextWindow: null, maxTokens: null };
  const { service } = runtimeServiceFixture(runtime);
  const root = await mkdtemp(path.join(tmpdir(), 'foundation-compat-'));
  const cwd = path.join(root, 'project'); await mkdir(cwd);
  const requests: Array<{ route: string; body: any }> = [];
  const events: Record<string, unknown>[] = [];
  let run: Awaited<ReturnType<typeof startDatabricksPiSession>> | undefined;
  try {
    run = await startDatabricksPiSession({ dataRoot: root, cwd, sessionKey: 'foundation-test', model: runtime.appModelId, service,
      prompt: 'Reply OK.', send: (_channel, event) => events.push(event), fetch: foundationFetch(requests) });
    await run.completed;
    assert.equal(run.session.hasFatalError(), false);
    assert.equal(events.filter(x => x.type === 'text_delta').map(x => x.delta).join(''), 'FOUNDATION_OK');
    assert.equal(requests.length, 2);
    for (const request of requests) for (const field of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) assert.equal(request.body[field], undefined);
    assert.equal(requests.at(-1)!.body.reasoning_effort, undefined);
    assert.equal(requests.at(-1)!.body.tools.length, 4);
  } finally {
    if (run && run.child.exitCode === null && run.child.signalCode === null) run.child.kill();
    await run?.runtime.close(); await rm(root, { recursive: true, force: true });
  }
}, 30000);

for (const status of [400, 401, 429, 500]) test(`tools rejection ${status} is bounded and diagnostics never expose private prose`, async () => {
  const runtime = runtimeFixture('openai-completions');
  let calls = 0;
  const relay = await createDatabricksRelay({ runtime, fetch: async () => {
    calls++;
    return Response.json({ error: { message: `Unsupported parameter: tools; ${runtime.apiKey} ${runtime.model} ${runtime.baseUrl}` } }, { status });
  } });
  try {
    const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias, messages: [], tools }) });
    assert.equal(response.status, status);
    const text = await response.text();
    assert.equal(calls, status === 400 ? 5 : 1);
    for (const secret of [runtime.apiKey, runtime.model, new URL(runtime.baseUrl).hostname]) assert.equal(text.includes(secret), false);
    if (status === 400) assert.equal(JSON.parse(text).error.upstreamMessage.includes('tools'), true);
  } finally { await relay.close(); }
});
