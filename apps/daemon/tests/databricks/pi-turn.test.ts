import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { DatabricksScanResponse } from '@readable-studio/contracts';
import { withDeadline } from '../../src/databricks/client.js';
import { createDatabricksService, type DatabricksService } from '../../src/databricks/service.js';
import { attachPiRpcSession } from '../../src/pi-rpc.js';
import { createDatabricksPiRuntime } from '../../src/runtimes/pi-databricks.js';
import { resolvePiEntrypoint } from '../../src/runtimes/pi-package.js';
import { getAgentDef } from '../../src/runtimes/registry.js';
import { createDatabricksAgentDef, registeredDatabricksModels } from '../../src/runtimes/defs/databricks.js';
import { safeProbe } from '../../src/runtimes/detection-probe.js';
import { writeAppConfig } from '../../src/app-config.js';
import { scanRunEventsForUsageAnalytics } from '../../src/run-analytics-observability.js';
import { assertNoDatabricksIdentityLeaks } from './privacy-fixture.js';
import { protocolFixture } from './runtime-fixture.js';
import {
  createPiTurnFixture, fixtureCliRunner, fixtureNow, upstreamBearer, upstreamHost,
} from './pi-turn-fixture.js';

async function scan(service: DatabricksService, profileId: string) {
  const started = await service.startScan({ profileId });
  let resolve!: (scan: DatabricksScanResponse) => void;
  const completed = new Promise<DatabricksScanResponse>((yes) => { resolve = yes; });
  // subscribeScan installs its listener before reading and replays terminal state;
  // even a scan completed before this call cannot be missed.
  const unsubscribe = await service.subscribeScan(started.scanId, (event) => {
    if (event.type === 'done') resolve(event.scan);
  });
  try { return await withDeadline(() => completed, 10_000); }
  finally { unsubscribe(); }
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  assert.ok(Array.isArray(content));
  return content.filter((block) => ['text', 'input_text', 'output_text'].includes(block.type)).map((block) => block.text).join('');
}

for (const api of ['anthropic-messages', 'openai-completions'] as const) {
  test(`registered ${api}: real names are allowed in UI DTOs, never logs, diagnostics, analytics, app config or generated Pi files`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'databricks-pi-turn-'));
    const fixture = await createPiTurnFixture();
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    try {
      const cwd = path.join(root, 'project');
      await mkdir(cwd);
      const service = createDatabricksService({
        dataRoot: root, now: () => fixtureNow, fetch: fixture.fetch,
        clientOptions: { runner: fixtureCliRunner, resolveExecutable: async () => 'fixture-databricks.exe' },
      });
      const profiles = await service.probe();
      expect(profiles.issues).toEqual([]);
      expect(profiles.profiles).toHaveLength(1);
      const discovered = await scan(service, profiles.profiles[0]!.id);
      expect(discovered.state, JSON.stringify({ discovered, errors: fixture.errors })).toBe('complete');
      expect(discovered.completeness).toEqual({ serving: true, uc: true, truncated: false });
      expect((await service.listModels()).models).toEqual([]);
      const endpoint = discovered.endpoints.find((entry) => entry.kind === 'uc-model-service' && entry.api === api);
      assert.ok(endpoint);
      const enabled = await service.enable(endpoint.id, { scanId: discovered.scanId, expectedRevision: discovered.revision });
      const model = enabled.appModelId;
      expect(model).toMatch(/^dbm_[a-f0-9]{32}$/);
      expect((await registeredDatabricksModels(service)).map((entry) => entry.id)).toEqual([model]);
      expect(getAgentDef('databricks')).toMatchObject({ id: 'databricks', streamFormat: 'pi-rpc', modelSelectionRequired: true });
      const upstreamModel = protocolFixture(api).request.body.model;
      expect(endpoint.displayName).toBe(upstreamModel);
      expect(endpoint.servedModelName).toBe(protocolFixture(api).response.body.model);
      expect(profiles.profiles[0]?.workspaceDisplayLabel).toBe(upstreamHost);
      const detected = await safeProbe(createDatabricksAgentDef(() => service));
      expect(detected.models[0]?.label).toBe(endpoint.servedModelName);
      await writeAppConfig(root, { agentId: 'databricks', agentModels: { databricks: { model } } });
      const appConfig = await readFile(path.join(root, 'app-config.json'), 'utf8');
      expect(JSON.parse(appConfig).agentModels.databricks.model).toBe(model);
      const privateValues = [upstreamBearer, upstreamModel, upstreamHost];
      const resolution = await service.resolveRuntime(model);
      expect(resolution).toMatchObject({ appModelId: model, model: upstreamModel, apiKey: upstreamBearer, api });
      const engine = resolvePiEntrypoint();
      expect(JSON.parse(await readFile(path.join(engine.packageRoot, 'package.json'), 'utf8'))).toMatchObject({
        name: '@earendil-works/pi-coding-agent', version: '0.83.0',
      });
      const sessionKey = JSON.stringify([cwd, 'two-turn-conversation']);
      const prompts = ['Remember this context marker: DBX_CONTEXT_7E921. Reply only OK.', 'Use the earlier context marker. Reply only OK.'];
      const sessionPaths: string[] = [];
      const sessionIds: string[] = [];
      let sessionDir: string | undefined;
      for (const [index, prompt] of prompts.entries()) {
        const runtime = await createDatabricksPiRuntime({
          dataRoot: root, cwd, sessionKey, model, reasoning: 'high', service, fetch: fixture.fetch,
          env: { ...process.env, DATABRICKS_TOKEN: upstreamBearer, Anthropic_Api_Key: upstreamBearer, OPENAI_API_KEY: upstreamBearer },
        });
        let child: ReturnType<typeof spawn> | undefined;
        let closed: Promise<void> | undefined;
        let stdout = '';
        let stderr = '';
        const events: Array<{ channel: string; payload: Record<string, unknown> }> = [];
        try {
          const invocation = runtime.invocation;
          if (sessionDir) expect(invocation.sessionDir).toBe(sessionDir);
          sessionDir = invocation.sessionDir;
          expect(invocation.command).toBe(process.execPath);
          expect(invocation.args[0]).toBe(engine.entrypoint);
          const configText = await readFile(path.join(invocation.agentDir, 'models.json'), 'utf8');
          const settingsText = await readFile(path.join(invocation.agentDir, 'settings.json'), 'utf8');
          const provider = JSON.parse(configText).providers.databricks;
          expect(provider.apiKey).toMatch(/^dbr_/);
          expect(provider.models.map((entry: { id: string }) => entry.id)).toEqual([model]);
          // Inspect the exact env/argv/config that this real spawn receives, not a mock.
          assertNoDatabricksIdentityLeaks({ invocation, 'models.json': configText, 'settings.json': settingsText,
            'app-config.json': appConfig, diagnostics: detected.diagnostics ?? [] }, privateValues);
          child = spawn(invocation.command, invocation.args, {
            cwd: invocation.cwd, env: invocation.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
          });
          closed = new Promise<void>((resolve) => { child!.once('close', () => resolve()); });
          child.stdout!.on('data', (chunk) => { stdout += chunk.toString(); });
          child.stderr!.on('data', (chunk) => { stderr += chunk.toString(); });
          // Subscribe to raw stdout and close BEFORE attach sends prompt/switch_session.
          // This is the same managed invocation + transport composition as server.ts.
          const session = attachPiRpcSession({
            child, prompt, cwd, sessionDir: invocation.sessionDir, model,
            send: (channel, payload) => events.push({ channel, payload }),
            ...(index === 1 ? { resumeSession: { path: sessionPaths[0]!, root: invocation.sessionDir } } : {}),
          });
          await withDeadline(() => session.waitForQuiescence(), 25_000);
          expect(session.hasFatalError()).toBe(false);
          expect(child.exitCode).toBe(0);
          expect(events.filter((event) => event.channel === 'error' || event.payload.type === 'error')).toEqual([]);
          expect(events.filter((event) => event.payload.type === 'text_delta').map((event) => event.payload.delta).join('')).toBe('OK');
          expect(events.find((event) => event.payload.label === 'initializing')?.payload.model).toBe(model);
          const rpc = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
          expect(rpc.filter((event) => event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta')
            .map((event) => event.assistantMessageEvent.delta).join('')).toBe('OK');
          expect(rpc.some((event) => event.type === 'agent_end')).toBe(true);
          expect(rpc.some((event) => event.type === 'agent_settled')).toBe(true);
          expect(rpc.some((event) => event.type === 'response' && event.command === 'get_state' && event.success === true)).toBe(true);
          if (index === 1) {
            const switched = rpc.findIndex((event) => event.type === 'response' && event.command === 'switch_session' && event.success === true);
            expect(switched).toBeGreaterThanOrEqual(0);
            expect(rpc.findIndex((event) => event.type === 'agent_start')).toBeGreaterThan(switched);
          }
          const sessionPath = session.getLastSessionPath();
          assert.ok(sessionPath);
          sessionPaths.push(sessionPath);
          const saved = await readFile(sessionPath, 'utf8');
          const header = JSON.parse(saved.split('\n')[0]!);
          expect(header.type).toBe('session');
          expect(typeof header.id).toBe('string');
          sessionIds.push(header.id);
          const runEvents = events.map((event) => ({ event: event.channel, data: event.payload }));
          const analytics = scanRunEventsForUsageAnalytics(runEvents, model, 0);
          expect(analytics.agent_reported_model).toBeNull();
          const inferredAnalytics = scanRunEventsForUsageAnalytics(runEvents, undefined, 0);
          expect(inferredAnalytics.agent_reported_model).toBe(model);
          assertNoDatabricksIdentityLeaks({ stdout, stderr, session: saved, events, analytics, inferredAnalytics,
            logs: logs.map((log) => log.mock.calls) }, privateValues);
          expect(fixture.errors).toEqual([]);
          expect(fixture.requests).toHaveLength(index + 1);
          const request = fixture.requests[index]!;
          expect(request.authorization).toBe(`Bearer ${upstreamBearer}`);
          expect(request.body.model).toBe(upstreamModel);
          expect(request.body.model).not.toBe(model);
          expect(request.body.stream).toBe(true);
          expect(request.path).toBe(api === 'anthropic-messages' ? '/ai-gateway/anthropic/v1/messages' : '/ai-gateway/openai/v1/responses');
          const messages = (api === 'anthropic-messages' ? request.body.messages : request.body.input)
            .filter((message) => message.role !== 'system' && message.role !== 'developer');
          expect(messages.map((message) => message.role)).toEqual(index === 0 ? ['user'] : ['user', 'assistant', 'user']);
          expect(messages.map((message) => messageText(message.content))).toEqual(index === 0 ? [prompts[0]] : [prompts[0], 'OK', prompts[1]]);
        } catch (error) {
          throw new Error(`Pi turn ${index + 1} (${api}) failed\nFixture errors: ${JSON.stringify(fixture.errors)}\nRPC stdout:\n${stdout}\nChild stderr:\n${stderr}\nUI events: ${JSON.stringify(events)}`, { cause: error });
        } finally {
          if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          try { if (closed) await withDeadline(() => closed!, 5_000); }
          finally { await runtime.close(); }
        }
      }
      expect(sessionPaths[1]).toBe(sessionPaths[0]);
      expect(sessionIds[1]).toBe(sessionIds[0]);
      expect(fixture.requests).toHaveLength(2);
      expect(fixture.errors).toEqual([]);
    } finally {
      for (const log of logs) log.mockRestore();
      try { await fixture.close(); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  }, 70_000);
}
