import { afterAll, expect, test } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { safeProbe } from '../../src/runtimes/detection-probe.js';
import { fetchModels } from '../../src/runtimes/detection-model-fetch.js';
import { geminiAgentDef } from '../../src/runtimes/defs/gemini.js';
import { kimiAgentDef } from '../../src/runtimes/defs/kimi.js';
import { codexAgentDef } from '../../src/runtimes/defs/codex.js';
import { detectAcpModels } from '../../src/acp.js';
import { AGENT_DEFS } from '../../src/runtimes/registry.js';
import { resolveAgentExecutable, resolveOnPath } from '../../src/runtimes/executables.js';
import { isKnownModel, rememberLiveModels, resolveModelForAgent } from '../../src/runtimes/models.js';
import type { RuntimeAgentDef } from '../../src/runtimes/types.js';

const home = mkdtempSync(path.join(tmpdir(), 'runtime-usability-'));
const runner = path.join(home, 'fixture.ts');
writeFileSync(runner, `import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fixture 1.0'); process.exit(0); }
if (args.includes('--output-format')) {
  console.error('Unknown arguments: output-format, outputFormat'); process.exit(1);
}
if (args.includes('--help')) process.exit(0);
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const req = JSON.parse(line);
  if (req.id === undefined) return;
  let result = {};
  if (req.method === 'initialize') result = { protocolVersion: 1 };
  if (req.method === 'account/read') result = { account: { type: 'apiKey' } };
  if (req.method === 'model/list') result = req.params.cursor
    ? { data: [{ id: 'live-second', displayName: 'Second' }], nextCursor: null }
    : { data: [{ id: 'live-first', displayName: 'First' }], nextCursor: 'page2' };
  if (req.method === 'session/new') {
    // Exact observed Kimi failure; not an invented stderr-only login heuristic.
    if (process.env.FIXTURE_AUTH === 'missing') {
      console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'Authentication required' } })); return;
    }
    result = { sessionId: 'fixture-session', models: { availableModels: [{ modelId: 'configured-model', name: 'Configured' }], currentModelId: 'configured-model' } };
  }
  console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
});
`);
const bin = path.join(home, process.platform === 'win32' ? 'fixture.cmd' : 'fixture');
writeFileSync(bin, process.platform === 'win32'
  ? `@echo off\r\n"${process.execPath}" "${runner}" %*\r\n`
  : `#!/bin/sh\nexec '${process.execPath}' '${runner}' "$@"\n`);
if (process.platform !== 'win32') chmodSync(bin, 0o755);
afterAll(() => rmSync(home, { recursive: true, force: true }));

const baseEnv = { HOME: home, USERPROFILE: home, READABLE_AGENT_DISCOVERY_OFFLINE: '0' };

test('absent CLI has no path and no selectable models', async () => {
  const result = await safeProbe({ ...kimiAgentDef, id: 'absent-fixture', bin: 'readable-nonexistent-fixture-82b2' });
  expect(result.available).toBe(false);
  expect(result.path).toBeUndefined();
  expect(result.models).toEqual([]);
  expect(result.diagnostics?.[0]?.reason).toBe('not-on-path');
});

test('Gemini actual adapter flags rejected by a present CLI make it unusable', async () => {
  const result = await safeProbe(geminiAgentDef, { ...baseEnv, GEMINI_BIN: bin });
  expect(result.available).toBe(false);
  expect(result.path).toBe(bin);
  expect(result.models).toEqual([]);
  expect(result.diagnostics?.[0]?.reason).toBe('not-executable');
});

function acpDef(): RuntimeAgentDef {
  return { ...kimiAgentDef, fetchModels: (resolvedBin, env) => detectAcpModels({
    bin: resolvedBin, args: [runner, 'acp'], env, cwd: home, timeoutMs: 3000,
  }) };
}

test('observed Kimi session/new auth error reaches sign-in-required state', async () => {
  const result = await safeProbe(acpDef(), { ...baseEnv, KIMI_BIN: process.execPath, FIXTURE_AUTH: 'missing' });
  expect(result.available).toBe(false);
  expect(result.path).toBe(process.execPath);
  expect(result.models).toEqual([]);
  expect(result.authStatus).toBe('missing');
  expect(result.diagnostics?.[0]?.reason).toBe('auth-missing');
});

test('working authenticated adapter session surfaces only live configured models', async () => {
  const result = await safeProbe(acpDef(), { ...baseEnv, KIMI_BIN: process.execPath, FIXTURE_AUTH: 'ok' });
  expect(result.available).toBe(true);
  expect(result.modelsSource).toBe('live');
  expect(result.models.map((model) => model.id)).toEqual(['configured-model']);
});

test('Codex gets fresh paginated model/list through its real stdio protocol', async () => {
  const result = await safeProbe(codexAgentDef, { ...baseEnv, CODEX_BIN: bin, CODEX_HOME: home });
  expect(result.available).toBe(true);
  expect(result.modelsSource).toBe('live');
  expect(result.models.map((model) => model.id)).toEqual(['live-first', 'live-second']);
  expect(codexAgentDef.fallbackModels).toEqual([]);
});

test('catalogue alone and offline mode do not establish usability', async () => {
  const { modelDiscovery: _readiness, ...catalogueOnly } = kimiAgentDef;
  const def: RuntimeAgentDef = { ...catalogueOnly, fetchModels: async () => [{ id: 'unverified', label: 'Unverified' }] };
  for (const offline of ['0', '1']) {
    const result = await safeProbe(def, { ...baseEnv, KIMI_BIN: process.execPath, READABLE_AGENT_DISCOVERY_OFFLINE: offline });
    expect(result.available).toBe(false);
    expect(result.path).toBe(process.execPath);
    expect(result.models).toEqual([]);
    expect(result.diagnostics?.[0]?.reason).toBe('auth-unknown');
  }
});

test('no registry agent substitutes a fallback after failed discovery', async () => {
  for (const def of AGENT_DEFS) {
    const result = await fetchModels({ ...def, fetchModels: async () => { throw new Error('Authentication required'); } }, process.execPath, {});
    expect(result.models, def.id).toEqual([]);
    expect(result.failure?.kind, def.id).toBe('auth-required');
  }
});

test('failed rescan revokes remembered, static, and custom selections', () => {
  const def: RuntimeAgentDef = { ...kimiAgentDef, id: 'revoked-fixture', fallbackModels: [{ id: 'static', label: 'Static' }] };
  rememberLiveModels(def.id, [{ id: 'live', label: 'Live' }]);
  expect(isKnownModel(def, 'static')).toBe(false);
  rememberLiveModels(def.id, []);
  expect(resolveModelForAgent(def, 'live')).toBeNull();
  expect(resolveModelForAgent(def, 'static')).toBeNull();
  expect(resolveModelForAgent(def, 'custom')).toBeNull();
});

test('vendor-home bins resolve with minimal PATH, preserve overrides, and do not leak homes', () => {
  const before = { PATH: process.env.PATH, READABLE_AGENT_HOME: process.env.READABLE_AGENT_HOME };
  const vendorBin = path.join(home, '.fixture-vendor', 'bin');
  mkdirSync(vendorBin, { recursive: true });
  const vendorExe = path.join(vendorBin, process.platform === 'win32' ? 'fixture-vendor.EXE' : 'fixture-vendor');
  writeFileSync(vendorExe, 'fixture');
  try {
    process.env.PATH = '';
    process.env.READABLE_AGENT_HOME = home;
    expect(resolveOnPath('fixture-vendor')).toBe(vendorExe);
    expect(resolveAgentExecutable({ ...kimiAgentDef, bin: 'fixture-vendor' }, { KIMI_BIN: process.execPath })).toBe(process.execPath);
    const other = path.join(home, 'other-home');
    mkdirSync(other);
    process.env.READABLE_AGENT_HOME = other;
    expect(resolveOnPath('fixture-vendor')).toBeNull();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
