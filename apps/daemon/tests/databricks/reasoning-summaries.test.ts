import { expect, test } from 'vitest';
import { createDatabricksRelay, type DatabricksRelay } from '../../src/databricks/relay.js';
import { runtimeFixture } from './runtime-fixture.js';

// Documented shapes, NOT live captures:
// https://docs.databricks.com/aws/en/machine-learning/model-serving/query-reason-models
// https://docs.databricks.com/aws/en/machine-learning/model-serving/score-foundation-models
// https://docs.databricks.com/aws/en/machine-learning/foundation-model-apis/api-reference
const thought = 'DOCUMENTED_THOUGHT';
const answer = 'DOCUMENTED_ANSWER';
const summary = [{ type: 'summary_text', text: thought, signature: 'opaque-signature' },
  { type: 'summary_encrypted_text', data: 'opaque-encrypted' }];
const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }];
const reasoning = { id: 'reasoning_1', type: 'reasoning', summary };
const result = { id: 'resp_fixture', status: 'completed', output: [reasoning,
  { type: 'message', content: [{ type: 'output_text', text: answer }] }] };
const sse = (frames: unknown[]) => frames.map(frame => `data: ${frame === '[DONE]' ? frame : JSON.stringify(frame)}\n\n`).join('');
const post = (relay: DatabricksRelay, body: Record<string, unknown>, native = false) => fetch(`${relay.baseUrl}${native ? '/v1/messages' : '/chat/completions'}`, {
  method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` },
  body: JSON.stringify({ model: relay.modelAlias, messages: [], ...body }),
});
const chunks = (text: string) => text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)));

for (const stream of [false, true]) test(`documented shape: Claude Chat readable summaries survive encrypted, signature and unknown blocks (${stream ? 'SSE' : 'JSON'})`, async () => {
  const runtime = runtimeFixture('openai-completions');
  runtime.baseUrl = 'https://workspace.example/serving-endpoints/claude-summary/invocations';
  const content = [{ type: 'reasoning', summary: [...summary, null, { type: 'summary_text', text: 7 }] },
    null, { type: 'future_block', data: 'unreadable' }, { type: 'reasoning', summary: null }, { type: 'text', text: answer }];
  const payload = { choices: [{ index: 0, [stream ? 'delta' : 'message']: { role: 'assistant', content }, finish_reason: 'stop' }] };
  const relay = await createDatabricksRelay({ runtime, fetch: async () => stream
    ? new Response(sse([payload, '[DONE]']), { headers: { 'content-type': 'text/event-stream' } }) : Response.json(payload) });
  try {
    const response = await post(relay, { stream });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('event: error');
    expect(text).not.toContain('opaque-');
    const messages = stream ? chunks(text).flatMap(chunk => chunk.choices.map((choice: any) => choice.delta)) : [JSON.parse(text).choices[0].message];
    expect(messages.map((message: any) => message.reasoning_content ?? '').join('')).toBe(thought);
    expect(messages.map((message: any) => message.content ?? '').join('')).toBe(answer);
    if (stream) expect(messages.filter((message: any) => message.reasoning_content || message.content))
      .toMatchObject([{ reasoning_content: thought }, { content: answer }]);
  } finally { await relay.close(); }
});

test('documented shape: Responses JSON reasoning output surfaces readable summaries', async () => {
  const relay = await createDatabricksRelay({ runtime: runtimeFixture('openai-completions'), fetch: async () => Response.json(result) });
  try {
    const response = await post(relay, { tools });
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: answer, reasoning_content: thought } }] });
  } finally { await relay.close(); }
});

for (const final of ['item', 'completed'] as const) for (const deltas of [false, true]) {
  test(`documented shape: Responses ${final} reasoning appears once with deltas=${deltas}`, async () => {
    const frames = [{ type: 'response.created', response: { id: result.id } },
      ...(deltas ? [{ type: 'response.reasoning_summary_text.delta', item_id: reasoning.id, output_index: 0, delta: thought }] : []),
      ...(final === 'item' ? [{ type: 'response.output_item.done', output_index: 0, item: reasoning }] : []),
      { type: 'response.output_text.delta', delta: answer }, { type: 'response.completed', response: result }];
    const relay = await createDatabricksRelay({ runtime: runtimeFixture('openai-completions'), fetch: async () => new Response(sse(frames), { headers: { 'content-type': 'text/event-stream' } }) });
    try {
      const response = await post(relay, { tools, stream: true });
      const parsed = chunks(await response.text());
      expect(parsed.flatMap(chunk => chunk.choices ?? []).map(choice => choice.delta.reasoning_content ?? '').join('')).toBe(thought);
      expect(parsed.flatMap(chunk => chunk.choices ?? []).map(choice => choice.delta.content ?? '').join('')).toBe(answer);
    } finally { await relay.close(); }
  });
}

for (const translated of [false, true]) test(`documented shape: Claude effort sends the effort beta without enabling idle thinking (translated=${translated})`, async () => {
  const runtime = runtimeFixture(translated ? 'openai-completions' : 'anthropic-messages');
  const seen: { body: any; beta: string | null }[] = [];
  const relay = await createDatabricksRelay({ runtime, fetch: async (url, init) => {
    expect(new URL(String(url)).pathname).toBe('/ai-gateway/anthropic/v1/messages');
    seen.push({ body: JSON.parse(String(init?.body)), beta: new Headers(init?.headers).get('anthropic-beta') });
    return Response.json({ type: 'message', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' });
  } });
  try {
    const response = await post(relay, translated ? { reasoning_effort: 'high' } : { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } }, !translated);
    await response.text(); expect(response.status).toBe(200);
    expect(seen[0]!.body.thinking.type).toBe('adaptive');
    expect(seen[0]!.body.output_config).toEqual({ effort: 'high' });
    expect(seen[0]!.beta?.split(',')).toContain('effort-2025-11-24');
    if (!translated) {
      await (await post(relay, {}, true)).text();
      expect(seen[1]!.body.thinking).toBeUndefined();
      expect(seen[1]!.beta).toBeNull();
    }
  } finally { await relay.close(); }
});

test('documented shape: rejected Claude effort beta retries once and stays disabled across relay instances', async () => {
  const runtime = runtimeFixture(); runtime.model = 'claude-beta-fallback-fixture';
  const seen: Array<string | null> = [];
  const upstream: typeof fetch = async (_url, init) => {
    const beta = new Headers(init?.headers).get('anthropic-beta'); seen.push(beta);
    return beta ? Response.json({ message: 'Unsupported anthropic-beta: effort-2025-11-24' }, { status: 400 })
      : Response.json({ type: 'message', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' });
  };
  for (let turn = 0; turn < 2; turn++) {
    const relay = await createDatabricksRelay({ runtime, fetch: upstream });
    try {
      const response = await post(relay, { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }, true);
      expect(response.status).toBe(200); await response.text();
    } finally { await relay.close(); }
  }
  expect(seen).toEqual(['effort-2025-11-24', null, null]);
});

for (const [model, servedModelName, enabled] of [
  ['system.ai.gpt-5.6-luna', undefined, true], ['databricks-o3', undefined, true],
  ['custom-service', 'gpt-5.6-luna', true], ['custom-service', 'claude-sonnet-5', false],
  ['system.ai.claude-sonnet-4-5', undefined, false], ['system.ai.gpt-oss-120b-alias', undefined, false],
  ['unknown-service', undefined, false],
] as const) test(`documented shape: Responses summary is scoped to GPT/o-series (${model}, ${servedModelName})`, async () => {
  const runtime = Object.assign(runtimeFixture('openai-completions'), { model, servedModelName });
  const seen: any[] = [];
  const relay = await createDatabricksRelay({ runtime, fetch: async (_url, init) => {
    seen.push(JSON.parse(String(init?.body))); return Response.json(result);
  } });
  try {
    for (const effort of ['high', 'none', undefined]) {
      await (await post(relay, { tools, ...(effort ? { reasoning_effort: effort } : {}) })).text();
      expect(seen.at(-1).reasoning?.summary).toBe(enabled && effort === 'high' ? 'auto' : undefined);
      expect(seen.at(-1).reasoning?.effort).toBe(effort);
    }
  } finally { await relay.close(); }
});

test('documented shape: Responses summary rejection retries without summary and remembers only that endpoint', async () => {
  const runtime = Object.assign(runtimeFixture('openai-completions'), { model: 'summary-fallback', servedModelName: 'gpt-5.6-luna' });
  const seen: any[] = [];
  const upstream: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); seen.push(body.reasoning);
    return body.reasoning.summary ? Response.json({ error: { message: 'Unsupported parameter: reasoning.summary', param: 'reasoning.summary' } }, { status: 400 })
      : Response.json(result);
  };
  for (let turn = 0; turn < 2; turn++) {
    const relay = await createDatabricksRelay({ runtime, fetch: upstream });
    try { const response = await post(relay, { tools, reasoning_effort: 'high' }); expect(response.status).toBe(200); await response.text(); }
    finally { await relay.close(); }
  }
  expect(seen).toEqual([{ effort: 'high', summary: 'auto' }, { effort: 'high' }, { effort: 'high' }]);
  const relay = await createDatabricksRelay({ runtime: { ...runtime, baseUrl: 'https://other-workspace.example/ai-gateway/openai/v1' }, fetch: async (_url, init) => {
    expect(JSON.parse(String(init?.body)).reasoning.summary).toBe('auto'); return Response.json(result);
  } });
  try { await (await post(relay, { tools, reasoning_effort: 'high' })).text(); } finally { await relay.close(); }
});

for (const native of [false, true]) test(`unrelated 400 keeps existing retry behavior and does not disable reasoning feature (native=${native})`, async () => {
  const runtime = Object.assign(runtimeFixture(native ? 'anthropic-messages' : 'openai-completions'), { model: `unrelated-400-${native}`, servedModelName: 'gpt-5.6-luna' });
  let calls = 0;
  const relay = await createDatabricksRelay({ runtime, fetch: async (_url, init) => {
    if (native) expect(new Headers(init?.headers).get('anthropic-beta')).toBe('effort-2025-11-24');
    else expect(JSON.parse(String(init?.body)).reasoning.summary).toBe('auto');
    if (++calls === 1) return Response.json({ message: 'Invalid input' }, { status: 400 });
    return Response.json(native ? { type: 'message', content: [], stop_reason: 'end_turn' } : result);
  } });
  try {
    const response = await post(relay, native ? { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } } : { tools, reasoning_effort: 'high' }, native);
    expect(response.status).toBe(200); await response.text(); expect(calls).toBe(2);
  } finally { await relay.close(); }
});
