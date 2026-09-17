import { afterEach, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { ok } from 'node:assert/strict';
import { Server } from 'node:http';
import { closeHttpServer } from '../src/daemon-startup.js';
import { startServer } from '../src/server.js';
import type { RuntimeAgentDef } from '../src/runtimes/types.js';

vi.mock('../src/runtimes/detection-probe.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/runtimes/detection-probe.js')>(), safeProbe: vi.fn(),
}));
import { safeProbe } from '../src/runtimes/detection-probe.js';
import { _resetAgentDetectionCacheForTests, detectAgents } from '../src/runtimes/detection.js';

function deferred() {
  let resolve: () => void = () => { throw new Error('uninitialized signal'); };
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function startTestServer() {
  const result = await startServer({ port: 0, returnServer: true });
  ok(typeof result === 'object' && result !== null);
  ok('url' in result && typeof result.url === 'string');
  ok('server' in result && result.server instanceof Server);
  ok('shutdown' in result && typeof result.shutdown === 'function');
  return { url: result.url, server: result.server, shutdown: result.shutdown };
}

afterEach(() => { _resetAgentDetectionCacheForTests(); vi.restoreAllMocks(); });

it('accepts and cancels a headless run when cold discovery is still probing', async () => {
  // Given a cold real discovery pass held at the probe boundary.
  _resetAgentDetectionCacheForTests();
  const entered = deferred();
  const release = deferred();
  vi.mocked(safeProbe).mockImplementation(async (def: RuntimeAgentDef) => {
    entered.resolve();
    await release.promise;
    return { ...def, available: false, models: [], modelsSource: 'live' };
  });
  const started = await startTestServer();
  const beginning = performance.now();
  await entered.promise;
  try {
    // When acceptance is requested without waiting for verified agent selection.
    const response = await fetch(`${started.url}/api/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'cold run' }), signal: AbortSignal.timeout(2000),
    });
    // Then acceptance and cancellation are available while the scan is held.
    expect(response.status).toBe(202);
    const body = await response.json();
    ok(typeof body === 'object' && body !== null && 'runId' in body && typeof body.runId === 'string');
    const runId = body.runId;
    const cancelled = await fetch(`${started.url}/api/runs/${runId}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(200);
    console.log(JSON.stringify({ coldAcceptanceMs: performance.now() - beginning }));
    release.resolve();
    await detectAgents();
    const status = await fetch(`${started.url}/api/runs/${runId}`);
    expect(await status.json()).toMatchObject({ status: 'canceled' });
  } finally {
    release.resolve();
    await detectAgents();
    await started.shutdown?.();
    await closeHttpServer(started.server);
  }
});

it('serves readiness while agent selection waits for verified cold results', async () => {
  // Given a pending discovery pass with an eventual verified model.
  _resetAgentDetectionCacheForTests();
  const dataDir = process.env.READABLE_DATA_DIR;
  if (!dataDir) throw new TypeError('test data directory missing');
  await rm(path.join(dataDir, 'agent-scan.json'), { force: true });
  const entered = deferred();
  const release = deferred();
  vi.mocked(safeProbe).mockImplementation(async (def: RuntimeAgentDef) => {
    entered.resolve();
    await release.promise;
    return { ...def, available: true, authStatus: 'ok', path: process.execPath,
      models: [{ id: 'verified-cold-model', label: 'Verified' }], modelsSource: 'live' };
  });
  const started = await startTestServer();
  await entered.promise;
  try {
    // When readiness is read while model verification is pending.
    const ready = await fetch(`${started.url}/api/ready`, { signal: AbortSignal.timeout(2000) });
    // Then readiness is independent, and the selection surface returns verified data after release.
    expect(ready.status).toBe(200);
    const agents = fetch(`${started.url}/api/agents?refresh=1`, { signal: AbortSignal.timeout(5000) });
    release.resolve();
    const response = await agents;
    expect(await response.json()).toMatchObject({ agents: expect.arrayContaining([
      expect.objectContaining({ available: true, modelsSource: 'live',
        models: [{ id: 'verified-cold-model', label: 'Verified' }] }),
    ]) });
  } finally {
    release.resolve();
    await detectAgents();
    await started.shutdown?.();
    await closeHttpServer(started.server);
  }
});
