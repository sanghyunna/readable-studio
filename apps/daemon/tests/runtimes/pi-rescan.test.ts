import { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as invocation from '../../src/runtimes/invocation.js';
import { _resetAgentDetectionCacheForTests, configureDetectionStorage, detectAgents } from '../../src/runtimes/detection.js';

let root: string;
const options = { enabledAgentIds: ['pi'] };
const env = { pi: { PI_BIN: process.execPath } };
const table = 'provider  model  context  max-out  thinking  images\nopenai  gpt-5  128K  32K  yes  yes\n';
function invocationResult(stdout: string) {
  return Object.assign(Promise.resolve({ stdout, stderr: '' }), { child: new ChildProcess() });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pi-rescan-'));
  _resetAgentDetectionCacheForTests();
  configureDetectionStorage(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  _resetAgentDetectionCacheForTests();
  await rm(root, { recursive: true, force: true });
});

test.each(['', 'No models available. Use /login to log into a provider via OAuth or API key.\n'])('reports consistent unavailable results when unchanged Pi has no credentials: %j', async (stdout) => {
  // Given an unchanged executable and model response, with no verified authentication.
  vi.spyOn(invocation, 'execAgentFile').mockImplementation((_bin, args) =>
    invocationResult(args.includes('--version') ? '0.83.0' : stdout));
  // When initial discovery and explicit refresh run against fresh durable storage.
  const initial = await detectAgents(env, options);
  const refreshed = await detectAgents(env, { ...options, refresh: true });
  // Then neither pass fabricates usable fallback models.
  expect(initial).toEqual(refreshed);
  expect(initial[0]).toMatchObject({ available: false, models: [], diagnostics: [{ reason: 'auth-unknown' }] });
});

test('does not lose a supposedly usable Pi when a failed listing recovers without verified authentication', async () => {
  // Given the same installed binary and credentials, but a failed first listing.
  let listings = 0;
  vi.spyOn(invocation, 'execAgentFile').mockImplementation((_bin, args) => {
    if (args.includes('--version')) return invocationResult('0.83.0');
    listings += 1;
    if (listings === 1) return Object.assign(Promise.reject(new Error('fixture listing failed')), { child: new ChildProcess() });
    return invocationResult(table);
  });
  // When discovery is retried by an explicit refresh.
  const initial = await detectAgents(env, options);
  const refreshed = await detectAgents(env, { ...options, refresh: true });
  // Then a listing failure cannot assert authentication that a catalogue cannot prove.
  expect(initial[0]?.available).toBe(refreshed[0]?.available);
  expect(initial[0]).toMatchObject({ available: false, models: [] });
  expect(refreshed[0]).toMatchObject({ available: false, models: [] });
});

test('keeps initial and refreshed catalogue results identical without verified execution authentication', async () => {
  // Given a stable model catalogue, which is not a verified execution session.
  vi.spyOn(invocation, 'execAgentFile').mockImplementation((_bin, args) =>
    invocationResult(args.includes('--version') ? '0.83.0' : table));
  // When both public discovery paths run.
  const initial = await detectAgents(env, options);
  const refreshed = await detectAgents(env, { ...options, refresh: true });
  // Then both report the same truthful unverified outcome.
  expect(initial).toEqual(refreshed);
  expect(initial[0]).toMatchObject({ available: false, modelsSource: 'live', models: [], diagnostics: [{ reason: 'auth-unknown' }] });
});
