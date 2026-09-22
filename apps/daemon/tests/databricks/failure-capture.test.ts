import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { databricksFailureCapturePath, writeDatabricksFailureCapture } from '../../src/databricks/failure-capture.js';
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
  const relay = await createDatabricksRelay({ runtime, fetch: async () => Response.json({
    error: { type: 'invalid_request_error', message: `Rejected strict additionalProperties at ${base.baseUrl} with ${base.apiKey}` },
    echoed_prompt: privatePrompt,
  }, { status: 400 }) });

  try {
    // When: the gateway rejects the exact outbound shape.
    const response = await sendFailure(relay);
    const failure = await response.json();

    // Then: the existing typed failure still surfaces once, and one decisive capture exists.
    expect(response.status).toBe(400);
    expect(failure).toMatchObject({ type: 'error', error: { reason: 'bad-request', upstreamStatus: 400 } });
    const capture: unknown = JSON.parse(await readFile(databricksFailureCapturePath(root), 'utf8'));
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
            name: '[redacted:string]', strict: '[redacted:boolean]', parameters: {
              type: '[redacted:string]', additionalProperties: '[redacted:boolean]',
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
          tools: { present: true, envelope: 'openai-function', strict: true, additionalProperties: true },
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
