import { afterEach, expect, it, vi } from 'vitest';
import type { DatabricksSubprocessRunner } from '../src/databricks/client.js';
import { diagnoseUpdateConnection } from '../src/update-routes.js';
import { createUpdateTokenProvider } from '../src/update-source.js';

afterEach(() => vi.useRealTimers());

it.each([
  ['command-error', 'cli-exit', 'connection-closed'], ['spawn-error', 'spawn', undefined], ['request-abort', 'aborted', undefined],
  ['http-error', 'cli-exit', 'http'], ['tls-error', 'cli-exit', 'tls'],
] as const)('explains the workspace-only failure for %s without contacting the pasted URL or exposing CLI text', async (cause, category, hint) => {
  vi.useFakeTimers();
  const calls: string[][] = [];
  const controller = new AbortController();
  const runner: DatabricksSubprocessRunner = async (_executable, args) => {
    calls.push([...args]);
    if (args[0] === '--version') return { stdout: 'Databricks CLI v0.250.0', stderr: '', exitCode: 0 };
    if (args[0] === 'auth' && args[1] === 'profiles') return {
      stdout: JSON.stringify({ profiles: [{ name: 'TEAM', host: 'https://workspace.azuredatabricks.net', is_default: true }] }), stderr: '', exitCode: 0,
    };
    if (args[0] === 'apps' && args[1] === 'get') return { stdout: '', stderr: 'HTTP 404 RESOURCE_DOES_NOT_EXIST', exitCode: 1 };
    if (args[0] === 'apps' && args[1] === 'list') {
      if (cause === 'spawn-error') throw new Error('fixture-only process launch rejection');
      if (cause === 'request-abort') return new Promise(() => {});
      if (cause === 'http-error') return { stdout: '', stderr: 'Error: HTTP 503 private-cookie=secret-123 Authorization: Bearer secret-123', exitCode: 1 };
      if (cause === 'tls-error') return { stdout: '', stderr: 'Error: x509 TLS certificate private-cookie=secret-123', exitCode: 1 };
      return { stdout: '', stderr: 'Error: Get "https://workspace.azuredatabricks.net/api/2.0/apps": EOF', exitCode: 1 };
    }
    throw new Error('Diagnostic must stop before token acquisition');
  };
  const fetcher = vi.fn<typeof fetch>();
  const report = diagnoseUpdateConnection('https://readable-studio-updates-123.aws.databricksapps.com', {
    signal: controller.signal,
    token: createUpdateTokenProvider({ runner, resolveCli: async () => ({ path: 'C:\\fixture\\databricks.exe', source: 'path' }) }), fetch: fetcher,
  });
  if (cause === 'request-abort') { await vi.advanceTimersByTimeAsync(31_001); controller.abort(); }
  const result = await report;
  expect(result).toMatchObject({ ok: false, failure: 'unreachable' });
  if (cause === 'request-abort') {
    expect(controller.signal.aborted).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    return;
  }
  expect(result.steps.map(({ step, ok }) => ({ step, ok }))).toEqual([
    { step: 'url', ok: true }, { step: 'cli', ok: true }, { step: 'profiles', ok: true }, { step: 'workspace', ok: false },
  ]);
  const step = result.steps.at(-1);
  expect(step?.detail).toContain(`category=${category}`);
  if (hint) expect(step?.detail).toContain(`cause=${hint}`);
  if (cause === 'http-error') expect(step?.httpStatus).toBe(503);
  if (cause !== 'spawn-error') expect(step?.detail).toContain('exit=1');
  for (const value of ['TEAM', 'workspace.azuredatabricks.net', 'secret-123', 'private-cookie', 'Authorization', 'fixture-only']) {
    expect(step?.detail).not.toContain(value);
  }
  expect(calls).toEqual([
    ['--version'], ['auth', 'profiles', '--output', 'json'], ['apps', 'get', 'readable-studio-updates', '--profile', 'TEAM', '--output', 'json'], ['apps', 'list', '--profile', 'TEAM', '--output', 'json'],
  ]);
  expect(fetcher).not.toHaveBeenCalled();
});
