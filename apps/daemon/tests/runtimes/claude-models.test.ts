import { afterEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeAgentDef } from '../../src/runtimes/defs/claude.js';
import { fetchModels } from '../../src/runtimes/detection-model-fetch.js';
import { parseClaudeModelCatalog } from '../../src/runtimes/defs/claude-model-discovery.js';
import { DEFAULT_MODEL_OPTION } from '../../src/runtimes/models.js';
import type { RuntimeAgentDef } from '../../src/runtimes/types.js';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), spawn,
}));

const measuredModels = [
  { value: 'default', displayName: 'Default (recommended)' },
  { value: 'opus[1m]', displayName: 'Opus (1M context)' },
  { value: 'fable[1m]', displayName: 'Fable' },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'haiku', displayName: 'Haiku' },
];
const roots: string[] = [];
function environment() {
  const home = mkdtempSync(join(tmpdir(), 'claude-models-'));
  roots.push(home);
  return { HOME: home, MMD_MODEL_ROUTES_FILE: join(home, 'routes.json') };
}
function cli(mode: 'success' | 'error' | 'hang' | 'malformed' | 'default') {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; }),
  });
  let input = '';
  child.stdin.on('data', (chunk: Buffer) => { input += chunk.toString(); });
  child.stdin.on('finish', () => {
    if (mode === 'hang') return;
    if (mode === 'error') {
      child.stderr.write('unknown option --safe-mode');
      child.emit('close', 1);
      return;
    }
    const request: unknown = JSON.parse(input);
    expect(request).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } });
    if (typeof request !== 'object' || request === null || !('request_id' in request)) throw new Error('Missing request id');
    child.stdout.write(`${JSON.stringify({ type: 'control_response', response: {
      subtype: 'success', request_id: request.request_id,
      response: { models: mode === 'malformed' ? [] : mode === 'default' ? measuredModels.slice(0, 1) : measuredModels },
    } })}\n`);
    queueMicrotask(() => child.emit('close', 0));
  });
  spawn.mockReturnValue(child);
  return child;
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('returns live measured ids verbatim when the resolved CLI initializes after stdin EOF', async () => {
  // Given
  const child = cli('success');
  const env = environment();
  const bin = join(tmpdir(), 'resolved-claude.exe');
  // When
  const result = await fetchModels(claudeAgentDef, bin, env);
  // Then
  expect(result).toEqual({ source: 'live', models: measuredModels.slice(1).map((m) => ({ id: m.value, label: m.displayName })) });
  expect(spawn.mock.calls[0]?.[0]).toBe(bin);
  expect(spawn.mock.calls[0]?.[1]).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--safe-mode', '--strict-mcp-config']);
  expect(child.stdin.writableEnded).toBe(true);
});

test('returns only configured MMS aliases when the override exists', async () => {
  // Given
  const env = environment();
  writeFileSync(env.MMD_MODEL_ROUTES_FILE, JSON.stringify({ routes: { 'proxy-only': {} } }));
  // When
  const result = await fetchModels(claudeAgentDef, 'unused-claude', env);
  // Then
  expect(result).toEqual({ source: 'live', models: [{ id: 'proxy-only', label: 'proxy-only' }] });
  expect(spawn).not.toHaveBeenCalled();
});

test.each(['error', 'malformed', 'default'] as const)('returns truthful non-live failure when CLI response is %s', async (mode) => {
  // Given
  cli(mode);
  // When
  const result = await fetchModels(claudeAgentDef, 'claude', environment());
  // Then
  expect(result).toMatchObject({ source: 'fallback', models: [], failure: { kind: mode === 'error' ? 'adapter-incompatible' : 'unverified' } });
});

test('declares a separate authentication status probe when discovery is only a selector catalogue', () => {
  // Given
  const def: RuntimeAgentDef = claudeAgentDef;
  // When
  const args = def.authProbe?.args;
  // Then
  expect(args).toEqual(['auth', 'status', '--json']);
});

test('normalizes the default sentinel once when the stream includes repeated selector entries', () => {
  // Given
  const stdout = `noise\n${JSON.stringify({ type: 'control_response', response: {
    subtype: 'success', request_id: 'models-capability-check', response: { models: [...measuredModels, ...measuredModels] },
  } })}\n`;
  // When
  const models = parseClaudeModelCatalog(stdout);
  // Then
  expect(models).toEqual([DEFAULT_MODEL_OPTION, ...measuredModels.slice(1).map((model) => ({ id: model.value, label: model.displayName }))]);
});

test('kills the child when cancellation occurs after launch', async () => {
  // Given
  const child = cli('hang');
  const controller = new AbortController();
  const spawned = new Promise<void>((resolve) => spawn.mockImplementationOnce(() => { resolve(); return child; }));
  // When
  const pending = claudeAgentDef.fetchModels('claude', environment(), controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await spawned;
  controller.abort();
  // Then
  await rejected;
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});

test('does not spawn when already cancelled', async () => {
  // Given
  const controller = new AbortController();
  controller.abort();
  // When
  const pending = claudeAgentDef.fetchModels('claude', environment(), controller.signal);
  // Then
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(spawn).not.toHaveBeenCalled();
});

test('kills the waiting CLI and settles discovery when its deadline expires', async () => {
  // Given
  vi.useFakeTimers();
  const child = cli('hang');
  const spawned = new Promise<void>((resolve) => spawn.mockImplementationOnce(() => { resolve(); return child; }));
  // When
  const result = fetchModels(claudeAgentDef, 'claude', environment());
  await spawned;
  await vi.advanceTimersByTimeAsync(10_000);
  // Then
  expect(await result).toMatchObject({ source: 'fallback', models: [], failure: { kind: 'discovery-failed' } });
  expect(child.kill).toHaveBeenCalled();
});
