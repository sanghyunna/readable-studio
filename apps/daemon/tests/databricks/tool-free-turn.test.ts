import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createDatabricksService } from '../../src/databricks/service.js';
import { startDatabricksPiSession } from '../../src/runtimes/pi-databricks.js';
import { composeSystemPrompt } from '../../src/prompts/system.js';
import { normalizeResource } from '../../src/databricks/catalogue.js';
import { withDeadline } from '../../src/databricks/client.js';
import { fixtureCliRunner, fixtureNow } from './pi-turn-fixture.js';

// Owner-confirmed shape; synthetic identity, no guessed model family or JSON resource.
const metadata = { name: 'fixture-endpoint', task: 'llm/v1/chat' };
const rejection = { reason: 'bad-request', upstreamStatus: 400, retryable: false, upstreamMessage: 'rejected parameter: tools' };
const html = '<!doctype html><html><head><title>Fixture</title></head><body><h1>DOCUMENT_OK</h1></body></html>';
const artifact = `<artifact identifier="index" type="text/html" title="Fixture">${html}</artifact>`;

function stream(text: string, responses: boolean) {
  const payloads = responses ? [
    { type: 'response.created', response: { id: 'resp_fixture', created_at: 1 } },
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } },
  ] : [{ id: 'chat_fixture', object: 'chat.completion.chunk', created: 1,
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }] }];
  return new Response(payloads.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + (responses ? '' : 'data: [DONE]\n\n'), { headers: { 'content-type': 'text/event-stream' } });
}

test('real managed Pi exhausts tool routes, emits one index artifact, and restart starts with no tools', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tool-free-pi-'));
  const cwd = path.join(root, 'project'); await mkdir(cwd);
  const requests: Record<string, unknown>[] = [];
  const fixtureFetch: typeof fetch = async (input, init) => {
    if (!init?.method || init.method === 'GET') return Response.json(metadata);
    const body = JSON.parse(String(init?.body)); requests.push(body);
    if (body.tools !== undefined) return Response.json({ message: rejection.upstreamMessage }, { status: rejection.upstreamStatus });
    const messages = JSON.stringify(body.input ?? body.messages);
    const policies = [...messages.replaceAll('\\"', '"').matchAll(/<readable-html-output-policy>(.*?)<\/readable-html-output-policy>/g)].map(match => JSON.parse(match[1]!));
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ delivery: 'artifact', fileTools: false, artifactIdentifier: 'index' });
    expect(body.tool_choice).toBeUndefined();
    return stream(artifact, String(input).endsWith('/responses'));
  };
  const makeService = () => createDatabricksService({ dataRoot: root, now: () => fixtureNow, fetch: fixtureFetch,
    clientOptions: { runner: fixtureCliRunner, resolveExecutable: async () => 'fixture-databricks.exe' }, resolveResource: async () => metadata.name });
  try {
    let service = makeService();
    const profiles = await service.probe();
    const found = await service.lookup({ profileId: profiles.profiles[0]!.id, resourceId: 'fixture', kind: 'serving-endpoint' });
    const registered = await service.enable(found.endpoint.id, { scanId: found.scanId, expectedRevision: found.revision });
    let resumeSession: { path: string; root: string } | undefined;
    for (let turn = 0; turn < 2; turn++) {
      const events: Record<string, unknown>[] = [];
      const run = await startDatabricksPiSession({ dataRoot: root, cwd, sessionKey: 'fixture', model: registered.appModelId,
        service, fetch: fixtureFetch, prompt: composeSystemPrompt({ streamFormat: 'pi-rpc' }) + '\nBuild the complete fixture document.',
        send: (_channel, event) => events.push(event), ...(resumeSession ? { resumeSession } : {}) });
      try {
        expect(run.runtime.invocation.args.includes('--no-tools')).toBe(turn === 1);
        await withDeadline(() => run.completed, 25000);
        expect(run.session.hasFatalError()).toBe(false);
        const output = events.filter(event => event.type === 'text_delta').map(event => event.delta).join('');
        expect(output).toBe(artifact);
        expect([...output.matchAll(/<artifact\s/g)]).toHaveLength(1);
        expect(events.filter(event => event.type === 'tool_use')).toHaveLength(0);
        const saved = run.session.getLastSessionPath(); expect(saved).toBeTruthy();
        resumeSession = { path: saved!, root: run.runtime.invocation.sessionDir };
      } finally {
        if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill();
        await withDeadline(() => Promise.allSettled([run.completed]), 5000);
      }
      service = makeService(); // Real store reload, not a shared in-memory runtime fixture.
      const learned = await service.resolveRuntime(registered.appModelId);
      expect(learned.wireCapabilities?.tools).toBe('unsupported');
      expect((await service.listModels()).models[0]!.capabilities.tools).toBe('unsupported');
    }
    expect(requests.map(body => Array.isArray(body.tools) ? body.tools.length : 0)).toEqual([4, 4, 0, 0]);
    expect(requests.filter(body => Array.isArray(body.tools) && body.tools.some(tool => 'input_schema' in tool))).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 65000);

test('metadata changes invalidate learned route and tool state; identical metadata retains it', () => {
  const resource = { kind: 'serving-endpoint' as const, name: metadata.name, metadata };
  const entry = normalizeResource('secret', 'profile', resource);
  entry.wireCapabilities = { responsesUnsupported: false, responsesPath: '/ai-gateway/codex/v1/responses', tools: 'unsupported', toolSurfaceVersion: 2, chatTokensField: 'max_tokens', requiredOutputBudget: false, omittedFields: [] };
  expect(normalizeResource('secret', 'profile', resource, entry).endpoint.capabilities.tools).toBe('unsupported');
  const refreshed = normalizeResource('secret', 'profile', { ...resource, metadata: { ...metadata, revision: 2 } }, entry);
  expect(refreshed.wireCapabilities).toBeUndefined(); expect(refreshed.endpoint.capabilities.tools).toBe('unknown');
});
