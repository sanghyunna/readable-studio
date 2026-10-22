import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, request } from 'node:http';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type { DatabricksSubprocessRunner } from '../src/databricks/client.js';
import { diagnoseUpdateConnection, registerUpdateRoutes, updateRequestSignal } from '../src/update-routes.js';
import { createDefaultUpdateServerResolver, createUpdateTokenProvider } from '../src/update-source.js';

afterEach(() => vi.useRealTimers());
const serverUrl = 'https://updates.example.com';

it('starts cancelled when a response disconnected before the signal was registered', () => {
  const req = Object.assign(new EventEmitter(), { aborted: false }) as Request;
  const res = Object.assign(new EventEmitter(), { destroyed: true, writableEnded: false }) as Response;
  expect(updateRequestSignal(req, res).aborted).toBe(true);
});

it('starts cancelled for an already aborted request and keeps a completed response uncancelled', () => {
  const aborted = Object.assign(new EventEmitter(), { aborted: true }) as Request;
  const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false }) as Response;
  expect(updateRequestSignal(aborted, response).aborted).toBe(true);
  const req = Object.assign(new EventEmitter(), { aborted: false }) as Request;
  const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false }) as Response;
  const signal = updateRequestSignal(req, res);
  Object.assign(res, { writableEnded: true, destroyed: true });
  res.emit('close');
  expect(signal.aborted).toBe(false);
  expect(req.listenerCount('aborted')).toBe(0);
});

it('does not treat an Apps get transport failure as a missing app or acquire a bearer', async () => {
  const calls: string[] = [];
  const runner: DatabricksSubprocessRunner = async (_executable, args) => {
    calls.push(args[1] ?? 'version');
    if (args[0] === '--version') return { stdout: 'Databricks CLI v1.10.0', stderr: '', exitCode: 0 };
    if (args[1] === 'profiles') return { stdout: JSON.stringify({ profiles: [{ name: 'DEFAULT', host: 'https://workspace.example.com' }] }), stderr: '', exitCode: 0 };
    return { stdout: '', stderr: 'HTTP 503 connection closed', exitCode: 1 };
  };
  const fetcher = vi.fn<typeof fetch>();
  const result = await diagnoseUpdateConnection(serverUrl, {
    token: createUpdateTokenProvider({ runner, resolveCli: async () => ({ path: 'C:\\fixture\\databricks.exe', source: 'path' }) }), fetch: fetcher });
  expect(result).toMatchObject({ ok: false, failure: 'unreachable' });
  expect(result.steps.at(-1)?.httpStatus).toBe(503);
  expect(calls).toEqual(['version', 'profiles', 'get']);
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(['known-app', 'other-app', 'other-url'] as const)('allows a successful 31-second workspace lookup through %s', async (mode) => {
  vi.useFakeTimers();
  const calls: string[][] = [];
  const runner: DatabricksSubprocessRunner = async (_executable, args) => {
    calls.push([...args]);
    let value: unknown;
    if (args[0] === '--version') return { stdout: 'Databricks CLI v1.10.0', stderr: '', exitCode: 0 };
    if (args[1] === 'profiles') value = { profiles: [{ name: 'DEFAULT', host: 'https://workspace.example.com' }] };
    else if (args[1] === 'get' && mode === 'other-app') return { stdout: '', stderr: 'HTTP 404 RESOURCE_DOES_NOT_EXIST', exitCode: 1 };
    else if (args[1] === 'get' && mode === 'other-url') value = { name: 'readable-studio-updates', url: 'https://different.example.com' };
    else if (args[0] === 'apps') {
      await new Promise<void>((done) => setTimeout(done, 31_000));
      value = args[1] === 'get' ? { name: 'readable-studio-updates', url: serverUrl } : [{ url: serverUrl }];
    } else value = { access_token: 'fixture-only', expiry: new Date(Date.now() + 3_600_000).toISOString() };
    return { stdout: JSON.stringify(value), stderr: '', exitCode: 0 };
  };
  const result = diagnoseUpdateConnection(serverUrl, {
    token: createUpdateTokenProvider({ runner, resolveCli: async () => ({ path: 'C:\\fixture\\databricks.exe', source: 'path' }) }),
    fetch: async () => Response.json({ ok: true, service: 'readable-studio-update-server', apiVersion: 1 }),
  }, { latest: false });
  await vi.advanceTimersByTimeAsync(31_001);
  expect(await result).toMatchObject({ ok: true, timeoutMs: 0 });
  expect(calls.filter((args) => args[0] === 'apps').map((args) => args[1])).toEqual(mode === 'known-app' ? ['get'] : ['get', 'list']);
});

it.each(['get', 'token'] as const)('propagates requester cancellation into the pending %s subprocess and stops subsequent work', async (stage) => {
  const controller = new AbortController();
  let entered!: () => void;
  const ready = new Promise<void>((done) => { entered = done; });
  let childSignal: AbortSignal | undefined;
  let aborted = false;
  const runner: DatabricksSubprocessRunner = async (_executable, args, options) => {
    if (args[0] === '--version') return { stdout: 'Databricks CLI v1.10.0', stderr: '', exitCode: 0 };
    if (args[1] === stage) {
      childSignal = options.signal;
      options.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      entered();
      return new Promise(() => {});
    }
    const value = args[1] === 'profiles' ? { profiles: [{ name: 'DEFAULT', host: 'https://workspace.example.com' }] }
      : { name: 'readable-studio-updates', url: serverUrl };
    return { stdout: JSON.stringify(value), stderr: '', exitCode: 0 };
  };
  const fetcher = vi.fn<typeof fetch>();
  const result = diagnoseUpdateConnection(serverUrl, { signal: controller.signal,
    token: createUpdateTokenProvider({ runner, resolveCli: async () => ({ path: 'C:\\fixture\\databricks.exe', source: 'path' }) }), fetch: fetcher });
  await ready;
  controller.abort();
  expect(await result).toMatchObject({ ok: false });
  expect(childSignal?.aborted).toBe(true);
  expect(aborted).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});

it('allows the default Apps get to finish after 31 seconds', async () => {
  vi.useFakeTimers();
  const runner: DatabricksSubprocessRunner = async (_executable, args) => {
    if (args[0] === '--version') return { stdout: 'Databricks CLI v1.10.0', stderr: '', exitCode: 0 };
    await new Promise<void>((done) => setTimeout(done, 31_000));
    return { stdout: JSON.stringify({ url: serverUrl }), stderr: '', exitCode: 0 };
  };
  const result = createDefaultUpdateServerResolver({ runner, resolveCli: async () => ({ path: 'C:\\fixture\\databricks.exe', source: 'path' }) })();
  await vi.advanceTimersByTimeAsync(31_001);
  expect(await result).toBe(serverUrl);
});

it('aborts the pending CLI child when the real HTTP requester disconnects', async () => {
  let entered!: () => void;
  let cancelled!: () => void;
  const ready = new Promise<void>((done) => { entered = done; });
  const aborted = new Promise<void>((done) => { cancelled = done; });
  const runner: DatabricksSubprocessRunner = async (_executable, args, options) => {
    if (args[0] === '--version') return { stdout: 'Databricks CLI v1.10.0', stderr: '', exitCode: 0 };
    if (args[1] === 'get') {
      options.signal.addEventListener('abort', cancelled, { once: true });
      entered();
      return new Promise(() => {});
    }
    return { stdout: JSON.stringify({ profiles: [{ name: 'DEFAULT', host: 'https://workspace.example.com' }] }), stderr: '', exitCode: 0 };
  };
  const app = express(); app.use(express.json());
  registerUpdateRoutes(app, { token: createUpdateTokenProvider({ runner, resolveCli: async () => ({ path: 'C:\\fixture\\databricks.exe', source: 'path' }) }) });
  const server = createServer(app);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('Expected HTTP port');
  const client = request({ hostname: '127.0.0.1', port: address.port, path: '/api/update/connection', method: 'POST', headers: { 'Content-Type': 'application/json' } });
  client.on('error', () => {});
  try {
    client.end(JSON.stringify({ serverUrl }));
    await ready;
    client.destroy();
    await aborted;
  } finally {
    client.destroy();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
