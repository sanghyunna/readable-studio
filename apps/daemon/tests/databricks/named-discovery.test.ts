import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { classifyProtocol, normalizeResource } from '../../src/databricks/catalogue.js';
import { scanWorkspace, objectValue } from '../../src/databricks/scan.js';

// Documentation-only compatibility contrasts; real Foundation responses below use root task.
const wire = JSON.parse(await readFile(new URL('./fixtures/serving-wire.json', import.meta.url), 'utf8'));
const examples: unknown = wire.documented;
if (!Array.isArray(examples)) throw new Error('Invalid documentation fixture');
const foundation = objectValue(wire.observedDetails[8]);
const custom = objectValue(examples[1]);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('serving task discovery', () => {
  it('classifies the captured Foundation endpoint using top-level task', () => {
    // Given
    const resource = { kind: 'serving-endpoint' as const, name: String(foundation.name), metadata: foundation };
    // When
    const entry = normalizeResource('secret', 'profile', resource);
    // Then
    expect(entry.endpoint.api).toBe('openai-completions');
    expect(entry.upstreamName).toBe(foundation.name);
  });
  it('retains nested-task compatibility for the documentation-only Foundation example', () => {
    expect(classifyProtocol({ kind: 'serving-endpoint', name: 'documented', metadata: objectValue(examples[0]) })).toBe('openai-completions');
  });
  it('retains the documented custom non-chat endpoint as unresolved', () => {
    // Given / When
    const api = classifyProtocol({ kind: 'serving-endpoint', name: String(custom.name), metadata: custom });
    // Then
    expect(api).toBe(null);
  });
  it('lists a sparse Foundation row after detail enrichment without enriching complete chat rows', async () => {
    // Given
    const paths: string[] = [];
    const binding = { id: 'profile', host: 'https://workspace.example', profileName: 'test', isDefault: false };
    // When
    const result = await scanWorkspace({ binding, bearer: 'test', fetch: async (url) => {
      const path = new URL(url).pathname; paths.push(path);
      if (path === '/api/2.0/serving-endpoints') return json({ endpoints: [{ name: foundation.name }, { name: 'custom-chat', task: 'llm/v1/chat' }] });
      if (path === `/api/2.0/serving-endpoints/${encodeURIComponent(String(foundation.name))}`) return json(foundation);
      if (path === '/api/2.1/unity-catalog/catalogs') return json({});
      throw new Error('Unexpected request');
    } });
    // Then
    expect(result.resources.map(classifyProtocol)).toEqual(['openai-completions', 'openai-completions']);
    expect(paths).toHaveLength(3);
  });
  it('does not discard an unresolved list row when detail access is denied', async () => {
    // Given / When
    const result = await scanWorkspace({ binding: { id: 'p', host: 'https://workspace.example', profileName: 'p', isDefault: false }, bearer: 'test',
      fetch: async url => new URL(url).pathname === '/api/2.0/serving-endpoints' ? json({ endpoints: [{ name: 'private' }] }) : json({}, 403) });
    // Then
    expect(result.resources.map(row => row.name)).toEqual(['private']);
  });
});
