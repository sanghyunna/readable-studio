import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { createBashToolDefinition, discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
import { startDatabricksPiSession } from '../../src/runtimes/pi-databricks.js';
import { withDeadline } from '../../src/databricks/client.js';
import { runtimeFixture, runtimeServiceFixture } from './runtime-fixture.js';

function capturedObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected captured JSON object');
  return value as Record<string, unknown>;
}

test('actual PowerShell registration does not inherit strict or grammar sampling from bash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'strict-origin-registration-'));
  try {
    const extension = fileURLToPath(new URL('../../src/runtimes/pi-powershell-extension.ts', import.meta.url));
    const loaded = await discoverAndLoadExtensions([extension], root, root);
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    const registered = [...loaded.extensions[0]!.tools.values()];
    expect(registered).toHaveLength(1);
    const powershell = registered[0]!.definition;
    const bash = createBashToolDefinition(root);
    for (const tool of [bash, powershell]) {
      expect(tool).not.toHaveProperty('strict');
      expect(tool).not.toHaveProperty('constrainedSampling');
      expect(tool.parameters).not.toHaveProperty('additionalProperties');
    }
    expect(powershell.name).toBe('powershell');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Run the real pinned Pi child, extension loader, provider SDK, RPC adapter and
// loopback relay. Capture the exact serialized body passed to upstream fetch.
// The only substitution is the remote endpoint: deterministic rejection avoids
// paid inference and stops the turn without inventing tool serialization.
for (const surface of ['responses', 'messages', 'chat', 'translated-messages', 'serving-invocations'] as const) {
  test(`managed Pi ${surface}: transmitted PowerShell and built-in tools must omit strict`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'strict-origin-'));
    const runtime = runtimeFixture(surface === 'messages' ? 'anthropic-messages' : 'openai-completions');
    if (surface === 'serving-invocations') runtime.baseUrl = 'https://workspace.example/serving-endpoints/strict-fixture/invocations';
    if (surface === 'chat') runtime.model = 'system.ai.gpt-oss-120b';
    if (surface === 'translated-messages') runtime.wireCapabilities = {
      responsesUnsupported: true, chatTokensField: 'max_completion_tokens', requiredOutputBudget: false, omittedFields: [],
    };
    const { service } = runtimeServiceFixture(runtime);
    const captures: Array<{ path: string; body: Record<string, unknown>; pid: number }> = [];
    const fixtureFetch: typeof fetch = async (input, init) => {
      captures.push({ path: new URL(String(input)).pathname, body: capturedObject(JSON.parse(String(init?.body))), pid: process.pid });
      return Response.json({ error_code: 'BAD_REQUEST', message: 'STRICT_ORIGIN_CAPTURE_COMPLETE' }, { status: 400 });
    };
    let turn: Awaited<ReturnType<typeof startDatabricksPiSession>> | undefined;
    try {
      const cwd = path.join(root, 'project');
      await mkdir(cwd);
      turn = await startDatabricksPiSession({ dataRoot: root, cwd, sessionKey: 'strict-origin', model: runtime.appModelId,
        reasoning: 'high', service, fetch: fixtureFetch, prompt: 'Return a short answer.', send: () => undefined,
        ...(process.env.STRICT_ORIGIN_PI_PACKAGE_ROOT ? { packageRoot: process.env.STRICT_ORIGIN_PI_PACKAGE_ROOT } : {}) });
      await withDeadline(() => turn!.completed, 20000);
      expect(captures).toHaveLength(1);
      const capture = captures[0]!;
      expect(capture.pid).not.toBe(turn.child.pid);
      const capturedTools = capture.body.tools;
      if (!Array.isArray(capturedTools)) throw new Error('Missing tools in transmitted payload');
      const tools = capturedTools.map(capturedObject);
      const definitions = tools.map(tool => capturedObject(tool.function ?? tool.custom ?? tool));
      expect(capture.path).toBe(surface === 'serving-invocations' ? '/serving-endpoints/strict-fixture/invocations'
        : surface === 'messages' || surface === 'translated-messages' ? '/ai-gateway/anthropic/v1/messages'
          : `/ai-gateway/openai/v1/${surface === 'responses' ? 'responses' : 'chat/completions'}`);
      // Log the raw tools, never a flattened summary that obscures their envelope.
      console.info('STRICT_ORIGIN_WIRE', JSON.stringify({ surface, path: capture.path, ownerPid: capture.pid, childPid: turn.child.pid, tools }));
      const powershell = definitions.find(tool => tool.name === 'powershell');
      const read = definitions.find(tool => tool.name === 'read');
      expect(powershell, 'real extension must be loaded and transmitted').toBeDefined();
      expect(read, 'built-in control must be transmitted').toBeDefined();
      expect(definitions.map(tool => tool.name).sort()).toEqual(['edit', 'powershell', 'read', 'write']);
      // Inspect the actual serialized payload for ALL tools, at ANY nesting depth.
      // These real Pi schemas have no user properties/literals named after keywords.
      expect.soft(JSON.stringify(tools), `strict escaped on ${capture.path}`).not.toContain('"strict":');
      expect.soft(JSON.stringify(tools), `additionalProperties escaped on ${capture.path}`).not.toContain('"additionalProperties":');
    } finally {
      if (turn) {
        if (turn.child.exitCode === null && turn.child.signalCode === null) turn.child.kill();
        await withDeadline(() => Promise.allSettled([turn!.completed]), 5000);
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
}
