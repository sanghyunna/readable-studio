import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createDatabricksRelay } from '../../src/databricks/relay.js';
import { runtimeFixture } from './runtime-fixture.js';

const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} }, strict: false } }];
const call = { type: 'function_call', call_id: 'call_original', name: 'read', arguments: '{"path":"check.txt"}' };
const result = { id: 'resp_test', created_at: 1, status: 'completed', output: [call], usage: {
  input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 6 },
} };
const sse = (events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');

test('Responses translates message history, images, tool choice, budgets and JSON tool results', async () => {
  const runtime = runtimeFixture('openai-completions');
  // A renamed service must take precisely the same route.
  runtime.model = 'unrelated.alias';
  const relay = await createDatabricksRelay({ runtime, fetch: async (url, init) => {
    assert.equal(String(url), `${runtime.baseUrl}/responses`);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: runtime.model, stream: false, store: false, reasoning: { effort: 'xhigh' }, max_output_tokens: 4096,
      tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: {} }, strict: false }],
      tool_choice: { type: 'function', name: 'read' },
      input: [{ role: 'developer', content: 'system' }, { role: 'user', content: [
        { type: 'input_text', text: 'read it' }, { type: 'input_image', image_url: 'data:image/png;base64,AA==', detail: 'auto' },
      ] }, { role: 'assistant', content: [{ type: 'output_text', text: 'reading' }] }, call,
      { type: 'function_call_output', call_id: call.call_id, output: 'contents' }],
    });
    return new Response(JSON.stringify({ ...result, model: runtime.model }));
  } });
  try {
    const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({
      model: relay.modelAlias, tools, reasoning_effort: 'xhigh', max_completion_tokens: 4096, stream: false, stream_options: { include_usage: true },
      tool_choice: { type: 'function', function: { name: 'read' } }, messages: [
        { role: 'developer', content: 'system' }, { role: 'user', content: [{ type: 'text', text: 'read it' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', detail: 'auto' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'reading' }], tool_calls: [{ id: call.call_id, type: 'function', function: { name: call.name, arguments: call.arguments } }] },
        { role: 'tool', tool_call_id: call.call_id, content: 'contents' },
      ],
    }) });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.model, relay.modelAlias);
    assert.deepEqual(body.choices[0], { index: 0, message: { role: 'assistant', content: null, tool_calls: [
      { id: call.call_id, type: 'function', function: { name: call.name, arguments: call.arguments } },
    ] }, finish_reason: 'tool_calls' });
    assert.deepEqual(body.usage, { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30,
      prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 6 } });
  } finally { await relay.close(); }
});

test('Responses split SSE preserves tool indexes, arguments, reasoning, usage and completion', async () => {
  const source = sse([
    { type: 'response.created', response: { id: result.id, created_at: 1 } },
    { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
    { type: 'response.output_item.added', output_index: 2, item: { ...call, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '"check.txt"}' },
    { type: 'response.completed', response: result },
  ]);
  const relay = await createDatabricksRelay({ runtime: runtimeFixture('openai-completions'), fetch: async () => new Response(new ReadableStream({ start(controller) {
    for (const byte of Buffer.from(source)) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } }) });
  try {
    const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias, messages: [], tools, reasoning_effort: 'high', stream: true }) });
    const frames = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
    assert.equal(frames.pop(), '[DONE]');
    const chunks = frames.map(frame => JSON.parse(frame));
    assert.equal(chunks[1].choices[0].delta.reasoning_content, 'thinking');
    const calls = chunks.flatMap(chunk => chunk.choices[0].delta.tool_calls ?? []);
    assert.deepEqual(calls.map(tool => tool.index), [0, 0, 0]);
    assert.equal(calls[0].id, call.call_id);
    assert.equal(calls.map(tool => tool.function.arguments).join(''), call.arguments);
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
    assert.equal(chunks.at(-1).usage.completion_tokens_details.reasoning_tokens, 6);
  } finally { await relay.close(); }
});

for (const ending of ['failed', 'truncated', 'incomplete'] as const) {
  test(`Responses ${ending} is not silently treated as successful completion`, async () => {
    const runtime = runtimeFixture('openai-completions');
    const events = [{ type: 'response.created', response: { id: result.id } },
      ...(ending === 'truncated' ? [] : [{ type: `response.${ending}`, response: ending === 'failed'
        ? { error: { message: `${runtime.apiKey} rejected` } } : { ...result, status: 'incomplete' } }])];
    const relay = await createDatabricksRelay({ runtime, fetch: async () => new Response(sse(events), { headers: { 'content-type': 'text/event-stream' } }) });
    try {
      const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias, messages: [], tools, stream: true }) });
      const text = await response.text();
      assert.equal(text.includes(runtime.apiKey), false);
      if (ending === 'incomplete') assert.ok(text.includes('"finish_reason":"length"'));
      else { assert.ok(text.includes('event: error')); assert.equal(text.includes('[DONE]'), false); }
    } finally { await relay.close(); }
  });
}
