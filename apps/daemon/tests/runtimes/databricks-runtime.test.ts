import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, vi } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createDatabricksAgentDef } from '../../src/runtimes/defs/databricks.js';
import { safeProbe } from '../../src/runtimes/detection-probe.js';
import { cachedSafeProbe } from '../../src/runtimes/detection-cache.js';
import { resolveModelForAgent } from '../../src/runtimes/models.js';
import { createDatabricksPiRuntime, renderDatabricksPiProvider, startDatabricksPiSession } from '../../src/runtimes/pi-databricks.js';
import { spawnEnvForAgent } from '../../src/runtimes/env.js';
import { getAgentDef } from '../../src/runtimes/registry.js';
import { piAgentDef } from '../../src/runtimes/defs/pi.js';
import * as invocation from '../../src/runtimes/invocation.js';
import { fixtureStream, runtimeFixture, runtimeServiceFixture } from '../databricks/runtime-fixture.js';

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'databricks-runtime-'));
  const cwd = path.join(root, 'project');
  await mkdir(cwd);
  return { root, cwd, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('Databricks is available with a ready CLI but requires a registered model', async () => {
  const fixture = runtimeServiceFixture();
  fixture.catalogue.models = [];
  const def = createDatabricksAgentDef(() => fixture.service);
  const detected = await safeProbe(def);
  assert.equal(getAgentDef('databricks')?.id, 'databricks');
  assert.deepEqual(def.fallbackModels, []);
  assert.deepEqual(detected.models, []);
  assert.equal(detected.modelsSource, 'live');
  assert.equal(detected.available, true);
  assert.equal(detected.diagnostics?.length, 1);
  assert.equal(detected.version, '0.282.0');
  assert.equal(detected.authStatus, 'ok');
  assert.equal(detected.modelSelectionRequired, true);
  assert.equal(detected.modelManagement, 'databricks');
  for (const model of [null, '', 'default', 'arbitrary/model', '--model']) assert.equal(resolveModelForAgent(def, model), null);
  assert.throws(() => def.buildArgs('', [], [], { model: 'arbitrary/model' }));
});

test('Databricks stays unavailable with no credentials, models, or usable CLI', async () => {
  const fixture = runtimeServiceFixture();
  fixture.catalogue.models = [];
  fixture.status.auth = 'auth-required';
  fixture.status.setupRequired = true;
  const def = createDatabricksAgentDef(() => fixture.service);
  for (const cli of ['missing', 'uninvocable', 'unsupported'] as const) {
    fixture.status.cli = cli;
    const detected = await cachedSafeProbe(safeProbe, def);
    assert.equal(detected.available, false);
    assert.equal(detected.authStatus, 'missing');
    assert.equal(detected.modelsSource, 'live');
    assert.deepEqual(detected.models, []);
    assert.equal(detected.modelSelectionRequired, true);
    assert.equal(detected.modelManagement, 'databricks');
    assert.equal(resolveModelForAgent(def, 'default'), null);
  }
});

test('Databricks detection uses registered models and bypasses stale detection caches', async () => {
  const fixture = runtimeServiceFixture();
  const def = createDatabricksAgentDef(() => fixture.service);
  const registered = await cachedSafeProbe(safeProbe, def);
  assert.equal(registered.available, true);
  assert.equal(registered.models.length, 1);
  assert.equal(resolveModelForAgent(def, registered.models[0]!.id), registered.models[0]!.id);
  assert.deepEqual(registered.models[0]?.reasoningOptions?.map((option) => option.id), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(registered.models[0]?.source, 'databricks');
  assert.equal(registered.models[0]?.connectionId, 'dbc_opaque_profile');
  assert.equal('detect' in registered, false);
  fixture.catalogue.models = [];
  const empty = await cachedSafeProbe(safeProbe, def);
  assert.deepEqual(empty.models, []);
  assert.equal(empty.available, true);
  assert.equal(resolveModelForAgent(def, 'dbm_opaque_model'), null);
});

test('direct Pi remains a separate selectable runtime definition', () => {
  assert.equal(getAgentDef('pi'), piAgentDef);
  assert.equal(piAgentDef.id, 'pi');
  assert.equal(piAgentDef.name, 'Pi');
  assert.equal(piAgentDef.bin, 'pi');
  assert.equal('modelSelectionRequired' in piAgentDef, false);
  assert.deepEqual(piAgentDef.buildArgs('', [], [], {}, {}), ['--mode', 'rpc']);
});

for (const api of ['openai-completions', 'anthropic-messages'] as const) {
  test(`managed ${api} provider is parsed by embedded Pi and contains only relay material`, async () => {
    const temporary = await temporaryRoot();
    const resolution = runtimeFixture(api);
    const { service } = runtimeServiceFixture(resolution);
    const handle = await createDatabricksPiRuntime({ dataRoot: temporary.root, cwd: temporary.cwd, sessionKey: 'conversation', model: resolution.appModelId, service, reasoning: 'high' });
    try {
      const { invocation } = handle;
      const modelsText = await readFile(path.join(invocation.agentDir, 'models.json'), 'utf8');
      const settings = JSON.parse(await readFile(path.join(invocation.agentDir, 'settings.json'), 'utf8'));
      const json = JSON.parse(modelsText);
      const provider = json.providers.databricks;
      assert.equal(provider.api, api);
      assert.match(provider.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.notEqual(provider.apiKey, resolution.apiKey);
      assert.equal(provider.models[0].id, resolution.appModelId);
      assert.equal(settings.defaultModel, resolution.appModelId);
      assert.deepEqual(settings.enabledModels, [`databricks/${resolution.appModelId}`]);
      assert.equal(modelsText.includes(resolution.apiKey), false);
      assert.equal(modelsText.includes(resolution.model), false);
      assert.equal(JSON.stringify(invocation).includes(resolution.apiKey), false);
      assert.equal(JSON.stringify(invocation).includes(resolution.model), false);
      assert.equal(invocation.command, process.execPath);
      assert.ok(invocation.args[0]?.endsWith('rpc-entry.js'));
      assert.equal(invocation.args[invocation.args.indexOf('--session-dir') + 1], invocation.sessionDir);
      assert.equal(invocation.env.PI_CODING_AGENT_DIR, invocation.agentDir);
      const pi = await ModelRuntime.create({ modelsPath: path.join(invocation.agentDir, 'models.json'), authPath: path.join(invocation.agentDir, 'auth.json'), modelsStorePath: path.join(invocation.agentDir, 'cache.json'), allowModelNetwork: false });
      assert.equal(pi.getError(), undefined);
      const model = pi.getModel('databricks', resolution.appModelId);
      assert.ok(model);
      assert.equal(model.api, api);
      if (api === 'anthropic-messages') {
        assert.equal(provider.models[0].compat.forceAdaptiveThinking, true);
        assert.deepEqual(provider.models[0].thinkingLevelMap, { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' });
      } else {
        assert.equal(provider.models[0].compat.maxTokensField, 'max_completion_tokens');
        assert.equal(provider.models[0].compat.thinkingFormat, 'openai');
      }
    } finally { await handle.close(); await temporary.cleanup(); }
  });

  test(`embedded Pi executes ${api} through the real RPC child and loopback surface`, async () => {
    const temporary = await temporaryRoot();
    const resolution = runtimeFixture(api);
    const { service } = runtimeServiceFixture(resolution);
    // Exercise the live Luna/Sonnet budgets, not the small fixture defaults.
    resolution.capabilities.contextWindow = api === 'anthropic-messages' ? 1_000_000 : 1_050_000;
    resolution.capabilities.maxTokens = 128_000;
    const events: Array<Record<string, unknown>> = [];
    let requestCount = 0;
    const run = await startDatabricksPiSession({
      dataRoot: temporary.root, cwd: temporary.cwd, sessionKey: 'conversation', model: resolution.appModelId, reasoning: api === 'anthropic-messages' ? 'xhigh' : 'high', service,
      prompt: 'Reply only OK.', send: (_channel, event) => events.push(event),
      fetch: async (input, init) => {
        requestCount++;
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, resolution.model);
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${resolution.apiKey}`);
        assert.equal(String(input), `${resolution.baseUrl}${api === 'anthropic-messages' ? '/v1/messages' : '/responses'}`);
        if (api === 'anthropic-messages') {
          assert.equal(body.thinking.type, 'adaptive');
          assert.equal(body.output_config.effort, 'xhigh');
          assert.equal(body.thinking.budget_tokens, undefined);
          assert.equal(body.reasoning_effort, undefined);
          assert.equal(body.max_tokens, 128_000);
        } else {
          assert.deepEqual(body.reasoning, { effort: 'high' });
          assert.equal(body.max_output_tokens, 128_000);
          assert.deepEqual(Object.keys(body).sort(), ['input', 'max_output_tokens', 'model', 'reasoning', 'store', 'stream', 'tools']);
          assert.equal(body.store, false);
          assert.equal(body.tools.length, 4);
          assert.ok(body.tools.every((tool: { type: string }) => tool.type === 'function'));
        }
        return new Response(api === 'anthropic-messages' ? fixtureStream(api)
          : await readFile(new URL('../databricks/fixtures/luna-responses-stream.txt', import.meta.url), 'utf8'),
        { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    let stderr = '';
    run.child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    try {
      await run.completed;
      assert.equal(run.session.hasFatalError(), false, `${stderr}\n${JSON.stringify(events)}`);
      assert.equal(requestCount, 1, JSON.stringify(events));
      assert.equal(events.filter((event) => event.type === 'text_delta').map((event) => event.delta).join(''), 'OK', JSON.stringify(events));
      const sessionPath = run.session.getLastSessionPath();
      assert.ok(sessionPath);
      const saved = await readFile(sessionPath, 'utf8');
      assert.equal(saved.includes(resolution.apiKey), false);
      assert.equal(saved.includes(resolution.model), false);
      await assert.rejects(stat(run.runtime.invocation.agentDir), { code: 'ENOENT' });
    } finally {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill();
      await run.runtime.close();
      await temporary.cleanup();
    }
  }, 30_000);
}

test('namespace/config/session isolation does not touch direct Pi and rejects disabled selections', async () => {
  const temporary = await temporaryRoot();
  const resolution = runtimeFixture();
  const { service, catalogue } = runtimeServiceFixture(resolution);
  const directHome = path.join(temporary.root, 'direct-pi');
  await mkdir(directHome);
  await writeFile(path.join(directHome, 'settings.json'), '{"direct":true}');
  const options = { dataRoot: path.join(temporary.root, 'namespace-a'), cwd: temporary.cwd, sessionKey: '../conversation', model: resolution.appModelId, service,
    env: { ...process.env, PI_CODING_AGENT_DIR: directHome, DATABRICKS_TOKEN: resolution.apiKey, Anthropic_Api_Key: 'ambient', NODE_OPTIONS: '--inspect' },
  };
  const a = await createDatabricksPiRuntime(options);
  const b = await createDatabricksPiRuntime({ ...options, dataRoot: path.join(temporary.root, 'namespace-b') });
  try {
    assert.notEqual(a.invocation.agentDir, b.invocation.agentDir);
    assert.notEqual(a.invocation.sessionDir, b.invocation.sessionDir);
    assert.notEqual(a.invocation.env.PI_CODING_AGENT_DIR, directHome);
    assert.equal(a.invocation.env.DATABRICKS_TOKEN, undefined);
    assert.equal(a.invocation.env.Anthropic_Api_Key, undefined);
    assert.equal(a.invocation.env.NODE_OPTIONS, undefined);
    assert.equal(await readFile(path.join(directHome, 'settings.json'), 'utf8'), '{"direct":true}');
    assert.deepEqual(piAgentDef.buildArgs('', [], [], {}, {}), ['--mode', 'rpc']);
    const c = await createDatabricksPiRuntime(options);
    assert.equal(c.invocation.sessionDir, a.invocation.sessionDir);
    assert.notEqual(c.invocation.agentDir, a.invocation.agentDir);
    await c.close();
    catalogue.models = [];
    await assert.rejects(createDatabricksPiRuntime(options), /DATABRICKS_SCAN_EXPIRED/);
    await assert.rejects(createDatabricksPiRuntime({ ...options, model: 'default' }));
  } finally { await Promise.all([a.close(), b.close()]); await temporary.cleanup(); }
});

test('managed provider renders registered limits exactly and uses the disclosed fallback for unknown limits', () => {
  const relay = { baseUrl: 'http://127.0.0.1:1234', capabilityKey: 'local-only', modelAlias: 'dbm_opaque_model' };
  const known = runtimeFixture();
  known.capabilities = { ...known.capabilities, contextWindow: 987_654, maxTokens: 76_543 };
  const knownModel = renderDatabricksPiProvider(known, relay).models.providers.databricks.models[0]!;
  assert.equal(knownModel.contextWindow, 987_654);
  assert.equal(knownModel.maxTokens, 76_543);

  const unknown = runtimeFixture();
  unknown.capabilities = { ...unknown.capabilities, contextWindow: null, maxTokens: null };
  const model = renderDatabricksPiProvider(unknown, relay).models.providers.databricks.models[0]!;
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.maxTokens, 128_000);
  assert.notEqual(model.contextWindow, 32_768);
  assert.notEqual(model.maxTokens, 4_096);
});

test('Anthropic provider never maps rejected minimal or budget thinking to a launch', () => {
  const resolution = runtimeFixture();
  const relay = { baseUrl: 'http://127.0.0.1:1234', capabilityKey: 'local-only', modelAlias: resolution.appModelId };
  assert.throws(() => renderDatabricksPiProvider(resolution, relay, 'minimal'));
  assert.throws(() => renderDatabricksPiProvider(resolution, relay, 'off'));
  assert.equal(renderDatabricksPiProvider(resolution, relay, 'xhigh').settings.defaultThinkingLevel, 'xhigh');
});

test('Databricks spawn environment is credential-blind without altering direct Pi env', () => {
  const base = { PATH: 'tools', SystemRoot: 'C:\\Windows', Databricks_Token: 'secret', ANTHROPIC_API_KEY: 'direct-secret', PI_CODING_AGENT_DIR: 'direct-home' };
  assert.deepEqual(spawnEnvForAgent('databricks', base, { DATABRICKS_TOKEN: 'configured' }, {}), { PATH: 'tools', SystemRoot: 'C:\\Windows' });
  const direct = spawnEnvForAgent('pi', base, {}, {});
  assert.equal(direct.ANTHROPIC_API_KEY, 'direct-secret');
  assert.equal(direct.PI_CODING_AGENT_DIR, 'direct-home');
});

test('direct Pi model discovery parses stdout, never the stderr diagnostic table', async () => {
  const exec = vi.spyOn(invocation, 'execAgentFile').mockResolvedValue({
    stdout: 'provider model context max-out thinking images\nopenai stdout-model 128K 16K yes yes\n',
    stderr: 'provider model context max-out thinking images\nanthropic stderr-decoy 128K 16K yes yes\n',
  });
  try {
    const models = await piAgentDef.fetchModels('pi', {});
    assert.deepEqual(models?.map((model) => model.id), ['default', 'openai/stdout-model']);
    assert.equal(exec.mock.calls[0]?.[1][0], '--list-models');
  } finally { exec.mockRestore(); }
});
