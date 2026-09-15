import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { describe, expect, it } from 'vitest';
import type { DatabricksScanEvent, DatabricksScanResponse } from '@readable-studio/contracts';
import { createDatabricksService } from '../../src/databricks/service.js';
import { registerDatabricksRoutes } from '../../src/databricks-routes.js';
import { listenOnFetchCompatiblePort } from '../../src/fetch-compatible-listener.js';

async function harness() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'databricks-rescan-'));
  let release: (() => void) | undefined;
  const service = createDatabricksService({ dataRoot,
    clientOptions: { resolveExecutable: async () => 'databricks.exe', runner: async (_exe, args) => ({
      stdout: args[0] === '--version' ? 'Databricks CLI v0.278.0' : JSON.stringify(args[1] === 'profiles'
        ? { profiles: [{ name: 'test', host: 'https://workspace.example' }] }
        : { access_token: 'fixture-only', expiry: new Date(Date.now() + 3600_000).toISOString() }), stderr: '', exitCode: 0,
    }) },
    fetch: async (url) => {
      if (new URL(url).pathname.endsWith('/serving-endpoints')) {
        await new Promise<void>((resolve) => { release = resolve; });
        return Response.json({ endpoints: [{ name: 'test-chat', task: 'llm/v1/chat' }] });
      }
      return Response.json({ catalogs: [] });
    },
  });
  const profileId = (await service.probe()).profiles[0]!.id;
  const app = express(); app.use(express.json());
  registerDatabricksRoutes(app, { service, setClient: () => service.status(), http: { requireLocalDaemonRequest: (_req, _res, next) => next() } });
  const { server, port } = await listenOnFetchCompatiblePort(createServer(app));
  const send = (path: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${port}/api/databricks${path}`, {
    method, signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { service, profileId, send,
    async scan() {
      const response = await send('/scans', 'POST', { profileId });
      expect(response.status).toBe(202);
      const started = await response.json() as DatabricksScanResponse;
      const stream = await send(`/scans/${started.scanId}/events`);
      const reader = stream.body!.getReader();
      // Headers and the first snapshot prove subscription before releasing discovery.
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('event: snapshot');
      release!();
      let text = '';
      while (true) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); }
      const events = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as DatabricksScanEvent);
      const done = events.find(event => event.type === 'done');
      expect(done?.type).toBe('done');
      if (done?.type !== 'done') throw new Error('Missing terminal scan event');
      return done.scan;
    },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(dataRoot, { recursive: true, force: true }); },
  };
}

describe('repeat scans through the HTTP/SSE surface', () => {
  it.each([false, true])('completes three fresh scans after registration (learned limits: %s)', async (learnLimits) => {
    const h = await harness();
    try {
      const first = await h.scan();
      expect(first.state).toBe('complete');
      const endpoint = first.endpoints[0]!;
      const registered = await h.service.enable(endpoint.id, { scanId: first.scanId, expectedRevision: first.revision });
      if (learnLimits) {
        const runtime = await h.service.resolveRuntime(registered.appModelId);
        await runtime.onCapabilitiesLearned!({ responsesUnsupported: true, chatTokensField: 'max_tokens', requiredOutputBudget: false, omittedFields: [], outputLimit: 8192 });
      }
      const second = await h.scan();
      const third = await h.scan();
      expect(new Set([first.scanId, second.scanId, third.scanId]).size).toBe(3);
      for (const result of [second, third]) {
        expect(result.state).toBe('complete');
        expect(result.counters).toEqual(first.counters);
        expect(result.endpoints[0]!.enabled).toBe(true);
        expect(result.endpoints[0]!.protocolEvidence).toBeDefined();
        if (learnLimits) expect(result.endpoints[0]!.capabilities).toMatchObject({ maxTokens: 8192, limitSources: { maxTokens: 'endpoint' } });
      }
    } finally { await h.close(); }
  });
});
