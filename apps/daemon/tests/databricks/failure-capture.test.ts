import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createDatabricksFailureCapture, databricksFailureCapturePath, writeDatabricksFailureCapture } from '../../src/databricks/failure-capture.js';
import { createDatabricksRelay } from '../../src/databricks/relay.js';
import { runtimeFixture } from './runtime-fixture.js';

const privatePrompt = 'PRIVATE PROMPT CONTENT';
const requestBody = {
  model: 'dbm_opaque_model',
  messages: [{ role: 'user', content: privatePrompt }],
  tools: [{ type: 'function', function: { name: 'private_tool_name', strict: true, parameters: {
    type: 'object', additionalProperties: false, properties: { document: { type: 'string' } },
  } } }],
  reasoning_effort: 'high', parallel_tool_calls: false, max_completion_tokens: 4096,
  stream_options: { include_usage: true }, output_config: { effort: 'high' },
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function sendFailure(relay: Awaited<ReturnType<typeof createDatabricksRelay>>): Promise<Response> {
  return fetch(`${relay.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${relay.capabilityKey}` },
    body: JSON.stringify(requestBody),
  });
}

test('failed gateway request captures the final route, structure-only body, and upstream rejection', async () => {
  // Given: a serving-invocations route whose rejection contains every private value class.
  const root = await mkdtemp(join(tmpdir(), 'databricks-failure-capture-'));
  const base = runtimeFixture('openai-completions');
  base.baseUrl = 'https://private-workspace.example/serving-endpoints/private-endpoint-name/invocations';
  const runtime = {
    ...base,
    captureFailure: (capture: Parameters<typeof writeDatabricksFailureCapture>[1]) => writeDatabricksFailureCapture(root, capture),
  };
  const transmitted: unknown[] = [];
  const relay = await createDatabricksRelay({ runtime, fetch: async (_url, init) => {
    transmitted.push(JSON.parse(String(init?.body)));
    return Response.json({
      error: { type: 'invalid_request_error', message: `Rejected strict additionalProperties at ${base.baseUrl} with ${base.apiKey}` },
      echoed_prompt: privatePrompt,
    }, { status: 400 });
  } });

  try {
    // When: the gateway rejects the exact outbound shape.
    const response = await sendFailure(relay);
    const failure = await response.json();

    // Then: the existing typed failure still surfaces once, and one decisive capture exists.
    expect(response.status).toBe(400);
    expect(failure).toMatchObject({ type: 'error', error: { reason: 'bad-request', upstreamStatus: 400 } });
    // The saved diagnostic must describe the actual post-sanitization request,
    // not the caller's input. Compare against the body seen by upstream fetch.
    expect(transmitted).toHaveLength(1);
    expect(JSON.stringify(transmitted[0])).not.toContain('"strict":');
    expect(JSON.stringify(transmitted[0])).not.toContain('"additionalProperties":');
    expect(requestBody.tools[0]!.function.strict).toBe(true);
    const capture: unknown = JSON.parse(await readFile(databricksFailureCapturePath(root), 'utf8'));
    if (!record(transmitted[0]) || !record(capture)) throw new Error('Missing observed request or capture');
    const observedCapture = createDatabricksFailureCapture({
      body: transmitted[0], endpoint: new URL(base.baseUrl), routeKind: 'serving-invocations',
      model: base.model, appModelId: base.appModelId, endpointId: base.endpointId,
      status: 400, upstreamBody: {},
    });
    expect(capture.request).toEqual(observedCapture.request);
    expect(capture).toMatchObject({
      schemaVersion: 1,
      diagnosticOutcome: 'gateway-rejection',
      captureStatus: 'captured',
      route: {
        kind: 'serving-invocations',
        endpoint: { id: base.endpointId, pathTemplate: '/serving-endpoints/[redacted]/invocations' },
        model: { appModelId: base.appModelId, upstreamValue: '[redacted]' },
      },
      request: {
        body: {
          messages: [{ role: '[redacted:string]', content: '[redacted:string]' }],
          tools: [{ type: '[redacted:string]', function: {
            name: '[redacted:string]', parameters: {
              type: '[redacted:string]',
              properties: { document: { type: '[redacted:string]' } },
            },
          } }],
          reasoning_effort: '[redacted:string]',
          parallel_tool_calls: '[redacted:boolean]',
          max_completion_tokens: '[redacted:number]',
          stream_options: { include_usage: '[redacted:boolean]' },
          output_config: { effort: '[redacted:string]' },
        },
        indicators: {
          tools: { present: true, envelope: 'openai-function', strict: false, additionalProperties: false },
          fields: {
            reasoning_effort: true, parallel_tool_calls: true, max_completion_tokens: true,
            stream_options: true, output_config: true,
          },
        },
      },
      response: {
        status: 400,
        body: { error: { type: 'invalid_request_error', message: 'Rejected strict additionalProperties at [redacted] with [redacted]' },
          echoed_prompt: '[redacted:string]' },
        rejectionFields: ['strict', 'additionalProperties'],
      },
    });
    const serialized = JSON.stringify(capture);
    for (const secret of [base.apiKey, base.model, base.baseUrl, new URL(base.baseUrl).hostname,
      privatePrompt, 'private_tool_name']) expect(serialized).not.toContain(secret);
  } finally {
    await relay.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('failure diagnostics still detect rejected keywords when an observed request contains them', () => {
  const runtime = runtimeFixture('openai-completions');
  const capture = createDatabricksFailureCapture({
    body: requestBody, endpoint: new URL(runtime.baseUrl), routeKind: 'chat-completions',
    model: runtime.model, appModelId: runtime.appModelId, endpointId: runtime.endpointId,
    status: 400, upstreamBody: { error: { message: 'strict additionalProperties' } },
  });
  expect(capture.request.indicators.tools).toMatchObject({ strict: true, additionalProperties: true });
  expect(capture.request.body).toMatchObject({ tools: [{ function: {
    strict: '[redacted:boolean]', parameters: { additionalProperties: '[redacted:boolean]' },
  } }] });
});

test('capture writer fault is explicit without replacing the typed upstream failure', async () => {
  // Given: the diagnostic writer fails after a real upstream rejection.
  const base = runtimeFixture('openai-completions');
  base.baseUrl = 'https://private-workspace.example/serving-endpoints/private-endpoint-name/invocations';
  const runtime = {
    ...base,
    captureFailure: async () => { throw new Error('fixture disk fault'); },
  };
  const relay = await createDatabricksRelay({ runtime, fetch: async () => Response.json({ error: { message: 'invalid request' } }, { status: 400 }) });

  try {
    // When: capture fails.
    const response = await sendFailure(relay);
    const failure = await response.json();

    // Then: there is still one typed gateway error, with capture failure called out separately.
    expect(response.status).toBe(400);
    expect(failure).toMatchObject({ type: 'error', error: { reason: 'bad-request', upstreamStatus: 400 } });
    if (!record(failure) || !record(failure.error) || typeof failure.error.message !== 'string') throw new Error('Missing typed failure');
    expect(failure.error.message).toContain('Diagnostic capture failed');
    expect(JSON.stringify(failure)).not.toContain('fixture disk fault');
  } finally {
    await relay.close();
  }
});
