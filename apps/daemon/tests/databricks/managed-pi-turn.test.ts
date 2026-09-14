import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { withDeadline } from '../../src/databricks/client.js';
import { createDatabricksService } from '../../src/databricks/service.js';
import { registeredDatabricksModels } from '../../src/runtimes/defs/databricks.js';
import { startDatabricksPiSession } from '../../src/runtimes/pi-databricks.js';
import { resolvePiEntrypoint } from '../../src/runtimes/pi-package.js';
import { getAgentDef } from '../../src/runtimes/registry.js';
import { createPiTurnFixture, fixtureCliRunner, fixtureNow, upstreamBearer, upstreamHost } from './pi-turn-fixture.js';
import { protocolFixture } from './runtime-fixture.js';

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  assert.ok(Array.isArray(content));
  return content.filter((block) => ['text', 'input_text', 'output_text'].includes(block.type)).map((block) => block.text).join('');
}

for (const api of ['anthropic-messages', 'openai-completions'] as const) {
  test(`managed Pi entrypoint: registered ${api} preserves two-turn context without upstream credentials`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'databricks-managed-pi-'));
    const fixture = await createPiTurnFixture();
    try {
      const cwd = path.join(root, 'project');
      await mkdir(cwd);
      const upstreamModel = protocolFixture(api).request.body.model;
      const service = createDatabricksService({
        dataRoot: root, now: () => fixtureNow, fetch: fixture.fetch,
        clientOptions: { runner: fixtureCliRunner, resolveExecutable: async () => 'fixture-databricks.exe' },
        // A daemon-private resource resolver, not a public FQN parameter.
        resolveResource: async (resourceId) => resourceId === 'fixture-resource' ? upstreamModel : null,
      });
      const profiles = await service.probe();
      expect(profiles.issues).toEqual([]);
      expect(profiles.profiles).toHaveLength(1);
      expect((await registeredDatabricksModels(service))).toEqual([]);
      expect(getAgentDef('databricks')).toMatchObject({
        id: 'databricks', streamFormat: 'pi-rpc', modelSelectionRequired: true, fallbackModels: [],
      });
      const found = await service.lookup({
        profileId: profiles.profiles[0]!.id, resourceId: 'fixture-resource', kind: 'uc-model-service',
      });
      expect(found.endpoint.api).toBe(api);
      expect((await service.listModels()).models).toEqual([]);
      const registered = await service.enable(found.endpoint.id, {
        scanId: found.scanId, expectedRevision: found.revision,
      });
      const model = registered.appModelId;
      expect(model).toMatch(/^dbm_[a-f0-9]{32}$/);
      expect((await registeredDatabricksModels(service)).map((entry) => entry.id)).toEqual([model]);
      const engine = resolvePiEntrypoint();
      expect(JSON.parse(await readFile(path.join(engine.packageRoot, 'package.json'), 'utf8'))).toMatchObject({
        name: '@earendil-works/pi-coding-agent', version: '0.83.0',
      });
      const prompts = ['Remember DBX_MANAGED_CONTEXT_8B37. Reply only OK.', 'Recall the earlier marker. Reply only OK.'];
      let resumeSession: { path: string; root: string } | undefined;
      let sessionId: string | undefined;
      for (const [index, prompt] of prompts.entries()) {
        const events: Array<{ channel: string; payload: Record<string, unknown> }> = [];
        let stdout = '';
        let stderr = '';
        // The callback is subscribed before launch; the real RPC adapter creates
        // its quiescence promise/listeners before sending prompt or switch_session.
        const turn = await startDatabricksPiSession({
          dataRoot: root, cwd, sessionKey: JSON.stringify([cwd, 'managed-conversation']),
          model, reasoning: 'high', prompt, service, fetch: fixture.fetch,
          env: { ...process.env, DATABRICKS_TOKEN: upstreamBearer, Anthropic_Api_Key: upstreamBearer, OPENAI_API_KEY: upstreamBearer },
          send: (channel, payload) => events.push({ channel, payload }),
          ...(resumeSession ? { resumeSession } : {}),
        });
        // Observe the actual child stream, not a fabricated RPC transport.
        turn.child.stdout!.on('data', (chunk) => { stdout += chunk.toString(); });
        turn.child.stderr!.on('data', (chunk) => { stderr += chunk.toString(); });
        try {
          const invocation = turn.runtime.invocation;
          expect(invocation.command).toBe(process.execPath);
          expect(invocation.args[0]).toBe(engine.entrypoint);
          expect(invocation.args[invocation.args.indexOf('--model') + 1]).toBe(model);
          for (const privateValue of [upstreamBearer, upstreamModel, upstreamHost]) {
            expect(JSON.stringify(invocation)).not.toContain(privateValue);
          }
          await withDeadline(() => turn.completed, 25_000);
          expect(turn.session.hasFatalError()).toBe(false);
          expect(turn.child.exitCode).toBe(0);
          expect(events.filter((event) => event.channel === 'error' || event.payload.type === 'error')).toEqual([]);
          expect(events.filter((event) => event.payload.type === 'text_delta').map((event) => event.payload.delta).join('')).toBe('OK');
          expect(events.find((event) => event.payload.label === 'initializing')?.payload.model).toBe(model);
          const rpc = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
          expect(rpc.filter((event) => event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta')
            .map((event) => event.assistantMessageEvent.delta).join('')).toBe('OK');
          expect(rpc.some((event) => event.type === 'agent_settled')).toBe(true);
          expect(rpc.some((event) => event.type === 'response' && event.command === 'get_state' && event.success === true)).toBe(true);
          const savedPath = turn.session.getLastSessionPath();
          assert.ok(savedPath);
          const saved = await readFile(savedPath, 'utf8');
          const header = JSON.parse(saved.split('\n')[0]!);
          expect(header.type).toBe('session');
          expect(typeof header.id).toBe('string');
          if (resumeSession) {
            expect(savedPath).toBe(resumeSession.path);
            expect(invocation.sessionDir).toBe(resumeSession.root);
            expect(header.id).toBe(sessionId);
            const switched = rpc.findIndex((event) => event.type === 'response' && event.command === 'switch_session' && event.success === true);
            expect(switched).toBeGreaterThanOrEqual(0);
            expect(rpc.findIndex((event) => event.type === 'agent_start')).toBeGreaterThan(switched);
          }
          resumeSession = { path: savedPath, root: invocation.sessionDir };
          sessionId = header.id;
          for (const privateValue of [upstreamBearer, upstreamModel, upstreamHost]) {
            expect(stdout + saved + JSON.stringify(events)).not.toContain(privateValue);
          }
          expect(fixture.errors).toEqual([]);
          expect(fixture.requests).toHaveLength(index + 1);
          const request = fixture.requests[index]!;
          expect(request.authorization).toBe(`Bearer ${upstreamBearer}`);
          expect(request.body.model).toBe(upstreamModel);
          expect(request.body.model).not.toBe(model);
          expect(request.body.stream).toBe(true);
          expect(request.path).toBe(api === 'anthropic-messages' ? '/ai-gateway/anthropic/v1/messages' : '/ai-gateway/openai/v1/responses');
          const messages = (api === 'anthropic-messages' ? request.body.messages : request.body.input)
            .filter((message) => !['system', 'developer'].includes(message.role));
          expect(messages.map((message) => message.role)).toEqual(index === 0 ? ['user'] : ['user', 'assistant', 'user']);
          expect(messages.map((message) => text(message.content))).toEqual(index === 0 ? [prompts[0]] : [prompts[0], 'OK', prompts[1]]);
        } catch (error) {
          throw new Error(`Managed ${api} turn ${index + 1} failed\nFixture errors: ${JSON.stringify(fixture.errors)}\nRPC stdout:\n${stdout}\nChild stderr:\n${stderr}\nUI events: ${JSON.stringify(events)}`, { cause: error });
        } finally {
          if (turn.child.exitCode === null && turn.child.signalCode === null) turn.child.kill('SIGKILL');
          // allSettled observes failure during cleanup without masking the original
          // assertion; the normal path above always asserts successful completion.
          await withDeadline(() => Promise.allSettled([turn.completed]), 5_000);
        }
      }
      expect(fixture.requests).toHaveLength(2);
    } finally {
      try { await fixture.close(); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  }, 70_000);
}
