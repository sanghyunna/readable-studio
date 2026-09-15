import { expect, test } from 'vitest';
import { createDatabricksRelay } from '../../src/databricks/relay.js';
import { runtimeFixture } from './runtime-fixture.js';

export const messagesPath = '/ai-gateway/anthropic/v1/messages';
export const tools = [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
const rejected = () => Response.json({ message: 'rejected parameter: tools' }, { status: 400 });
const reply = { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'tool_use', id: 'toolu_original', name: 'read', input: { path: 'index.html' } }], stop_reason: 'tool_use', usage: { input_tokens: 11, output_tokens: 7 } };

test('task-only serving Chat tools rejection tries Messages with translated tools, context, images, effort and tool history', async () => {
  const runtime = runtimeFixture('openai-completions'); runtime.baseUrl = 'https://workspace.example/serving-endpoints/task-only/invocations';
  runtime.wireCapabilities = { responsesUnsupported: true, chatTokensField: 'max_tokens', requiredOutputBudget: false, omittedFields: [] };
  const routes: string[] = [];
  const relay = await createDatabricksRelay({ runtime, fetch: async (input, init) => {
    const route = new URL(String(input)).pathname; routes.push(route);
    const body = JSON.parse(String(init?.body));
    if (route !== messagesPath) return rejected();
    expect(new Headers(init?.headers).get('anthropic-version')).toBe('2023-06-01');
    expect(body.tools).toEqual([{ name: 'read', description: 'Read a file', input_schema: tools[0]!.function.parameters }]);
    expect(body.system).toEqual([{ type: 'text', text: 'system context' }]);
    expect(body.max_tokens).toBe(4096); expect(body.max_completion_tokens).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined(); expect(body.output_config).toEqual({ effort: 'high' });
    expect(body.thinking).toEqual({ type: 'adaptive' }); expect(body.stream_options).toBeUndefined();
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Read it' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_previous', name: 'read', input: { path: 'brief.txt' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_previous', content: 'brief contents' }] },
    ]);
    return Response.json(reply);
  } });
  try {
    const response = await fetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${relay.capabilityKey}` }, body: JSON.stringify({ model: relay.modelAlias, tools, max_completion_tokens: 4096, reasoning_effort: 'high', stream_options: { include_usage: true }, messages: [
      { role: 'developer', content: 'system context' },
      { role: 'user', content: [{ type: 'text', text: 'Read it' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_previous', type: 'function', function: { name: 'read', arguments: '{"path":"brief.txt"}' } }] },
      { role: 'tool', tool_call_id: 'call_previous', content: 'brief contents' },
    ] }) });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'toolu_original', type: 'function', function: { name: 'read', arguments: '{"path":"index.html"}' } }] } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
    expect(routes).toEqual(['/serving-endpoints/task-only/invocations', messagesPath]);
  } finally { await relay.close(); }
});
