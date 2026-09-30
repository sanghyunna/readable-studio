import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeResource } from '../../src/databricks/catalogue.js';
import { servingTask } from '../../src/databricks/serving-task.js';
import { registerDatabricksRoutes } from '../../src/databricks-routes.js';
import { runDatabricksCli } from '../../src/databricks-cli.js';
import { listenOnFetchCompatiblePort } from '../../src/fetch-compatible-listener.js';
import { namedFixture, json } from './named-fixture.js';

// Unmodified redacted response objects captured 2026-09-29, not documentation shapes.
const { observedList: list, observedDetails } = JSON.parse(await readFile(new URL('./fixtures/serving-wire.json', import.meta.url), 'utf8'));
const details: (typeof list)[] = observedDetails;
const normalize = (metadata: Record<string, unknown>) => normalizeResource('test-secret', `dbc_${'a'.repeat(32)}`,
  { kind: 'serving-endpoint', name: String(metadata.name), metadata }).endpoint;
afterEach(() => vi.restoreAllMocks());

describe('captured Databricks Foundation wire', () => {
  it('classifies all 11 list and detail rows from the observed TOP-LEVEL task', () => {
    for (const rows of [list.endpoints, details]) {
      expect(rows).toHaveLength(11);
      expect(rows.filter((row: Record<string, unknown>) => servingTask(row) === 'llm/v1/chat')).toHaveLength(8);
      expect(rows.filter((row: Record<string, unknown>) => servingTask(row) === 'llm/v1/embeddings')).toHaveLength(3);
      for (const row of rows) {
        expect(row.config.served_entities[0].foundation_model).not.toHaveProperty('task');
        expect(servingTask(row)).toBe(row.task);
      }
    }
  });

  it.each([0, 1])('uses a safe advertised GPT-OSS context and logs table disagreement: detail %i', (index) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = normalize(details[index]);
    expect(result.capabilities).toMatchObject({ contextWindow: 128_000, limitSources: { contextWindow: 'advertised' } });
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      field: 'contextWindow', selected: 128_000, selectedSource: 'advertised', modelTable: 131_072,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(details[index].name);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('system.ai');
  });

  it('explicit numeric workspace metadata wins over prose and the generic model table', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Fault/precedence mutation of the captured body, not an invented endpoint shape.
    const result = normalize({ ...details[0], context_window: 120_000 });
    expect(result.capabilities).toMatchObject({ contextWindow: 120_000, limitSources: { contextWindow: 'metadata' } });
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      field: 'contextWindow', selected: 120_000, selectedSource: 'metadata', modelTable: 131_072,
    });
  });

  it('discovers, streams, registers and lists all 8 real chat shapes through HTTP and the CLI', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixture = await namedFixture(async (url, init) => {
      expect(init.method).not.toBe('POST'); // Enumeration/registration must not spend inference tokens.
      const path = new URL(url).pathname;
      if (path === '/api/2.0/serving-endpoints') return json(list);
      // No UC response was captured: model permission denial, never invent a successful shape.
      return new Response(null, { status: 403 });
    });
    const app = express(); app.use(express.json());
    registerDatabricksRoutes(app, { service: fixture.service, setClient: async () => fixture.service.status(),
      http: { requireLocalDaemonRequest: (_req, _res, next) => next() } });
    const { server, port } = await listenOnFetchCompatiblePort(createServer(app));
    const invoke = async (args: string[], expectedExit = 0) => {
      let stdout = '';
      const result = await runDatabricksCli([...args, '--json'], { resolveDaemonUrl: async () => `http://127.0.0.1:${port}`,
        stdout: text => { stdout += text; }, stderr: () => {} });
      expect(result.exitCode, stdout).toBe(expectedExit);
      return JSON.parse(stdout);
    };
    try {
      const scan = await invoke(['scan', '--profile', fixture.profileId], 3);
      expect(scan.endpoints).toHaveLength(8);
      expect(scan.counters).toMatchObject({ candidates: 11, excluded: 3 });
      for (const endpoint of scan.endpoints) await invoke(['enable', endpoint.id, '--scan', scan.scanId, '--revision', String(scan.revision)]);
      const models = await invoke(['models']);
      expect(models.models).toHaveLength(8);
      expect(models.models.every((row: { availability: string; enabled: boolean }) => row.availability === 'compatible' && row.enabled)).toBe(true);
      expect(models.models.map((row: { servedModelName: string }) => row.servedModelName).sort())
        .toEqual(details.filter(row => row.task === 'llm/v1/chat').map(row => row.config.served_entities[0].foundation_model.name).sort());
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('distinguishes an unavailable local daemon from an upstream Databricks failure', async () => {
    let output = '';
    const result = await runDatabricksCli(['models', '--json'], {
      resolveDaemonUrl: async () => 'http://127.0.0.1:7456',
      fetch: async () => { throw new TypeError('fetch failed: PRIVATE_VALUE'); },
      stdout: text => { output += text; }, stderr: () => {},
    });
    expect(result.exitCode).toBe(64);
    expect(JSON.parse(output).error.code).toBe('daemon-not-running');
    expect(output).not.toContain('PRIVATE_VALUE');
  });
});
