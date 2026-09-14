import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeResource, type CatalogueEntry } from '../../src/databricks/catalogue.js';
import { DatabricksStore, type CatalogueGeneration } from '../../src/databricks/store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function entry(model: string): CatalogueEntry {
  return normalizeResource('secret', 'profile', { kind: 'serving-endpoint', name: model,
    metadata: { task: 'llm/v1/chat', config: { served_entities: [{ external_model: { name: model } }] } } });
}

async function savedStore(entries: CatalogueEntry[], legacy = false) {
  const root = await mkdtemp(join(tmpdir(), 'databricks-limits-store-'));
  roots.push(root);
  const store = new DatabricksStore(root);
  const saved = await store.update((generation) => {
    generation.entries = entries;
    generation.scans = [{ scanId: 'scan', profileId: 'profile', revision: 2, state: 'complete',
      createdAt: '2026-09-12T00:00:00.000Z', startedAt: null, completedAt: null,
      endpoints: structuredClone(entries.map((item) => item.endpoint)), cursor: null,
      counters: { scopesChecked: 1, scopesInaccessible: 0, candidates: entries.length, excluded: 0 },
      completeness: { serving: true, uc: true, truncated: false }, issues: [] }];
    if (legacy) for (const endpoint of [...generation.entries.map((item) => item.endpoint), ...generation.scans[0]!.endpoints]) {
      endpoint.capabilities = { tools: 'supported', images: 'unknown', contextWindow: null, maxTokens: null };
    }
  });
  return { root, saved };
}

function capabilities(generation: CatalogueGeneration) {
  return [...generation.entries.map((item) => item.endpoint), ...generation.scans.flatMap((scan) => scan.endpoints)]
    .map((endpoint) => endpoint.capabilities);
}

describe('Databricks persisted capability generations', () => {
  it('round-trips known and explicitly unknown limits in entries and scan snapshots', async () => {
    const { root, saved } = await savedStore([entry('claude-sonnet-5'), entry('gpt-5.6-luna'), entry('unrecognised')]);
    const restored = await new DatabricksStore(root).read();
    expect(restored).toEqual(saved);
    expect(restored.entries.map((item) => item.endpoint.capabilities)).toMatchObject([
      { contextWindow: 1_000_000, maxTokens: 128_000 },
      { contextWindow: 1_050_000, maxTokens: 128_000 },
      { contextWindow: null, maxTokens: null, limitSources: { contextWindow: 'unknown', maxTokens: 'unknown' } },
    ]);
  });

  it('migrates legacy scan snapshots as well as registered entries without changing revisions', async () => {
    const { root, saved } = await savedStore([entry('claude-sonnet-5')], true);
    const restarted = new DatabricksStore(root);
    const restored = await restarted.read();
    expect(restored.revision).toBe(saved.revision);
    expect(restored.scans[0]!.revision).toBe(saved.scans[0]!.revision);
    for (const capability of capabilities(restored)) expect(capability).toEqual({
      tools: 'supported', images: 'unknown', contextWindow: 1_000_000, maxTokens: 128_000,
      limitSources: { contextWindow: 'model-table', maxTokens: 'model-table' },
    });
    const persisted = await restarted.update(() => {});
    expect(await new DatabricksStore(root).read()).toEqual(persisted);
  });

  it('refreshes legacy effort lists from each snapshot identity without rescanning or changing registration', async () => {
    const sonnet = entry('claude-sonnet-5');
    sonnet.endpoint.api = 'anthropic-messages';
    sonnet.endpoint.enabled = true;
    const luna = entry('gpt-5.6-luna');
    for (const item of [sonnet, luna]) item.endpoint.reasoningOptions = ['high', 'xhigh'].map((id) => ({ id, label: id }));
    const { root, saved } = await savedStore([sonnet, luna]);
    const restarted = new DatabricksStore(root);
    const restored = await restarted.read();
    expect(restored.revision).toBe(saved.revision);
    expect(restored.scans[0]!.revision).toBe(saved.scans[0]!.revision);
    for (const endpoints of [restored.entries.map((item) => item.endpoint), restored.scans[0]!.endpoints]) {
      expect(endpoints[0]!.reasoningOptions?.map(({ id }) => id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
      expect(endpoints[1]!.reasoningOptions?.map(({ id }) => id)).toEqual(['low', 'medium', 'high', 'xhigh']);
      expect(endpoints[0]).toMatchObject({ id: sonnet.endpoint.id, appModelId: sonnet.endpoint.appModelId, enabled: true });
    }
    await restarted.update((generation) => {
      // A current Luna entry must not rewrite its historical Sonnet scan.
      generation.entries[0]!.endpoint.servedModelName = 'gpt-5.6-luna';
      generation.entries[0]!.endpoint.api = 'openai-completions';
      // Nor may an alias supply missing served identity.
      delete generation.entries[1]!.endpoint.servedModelName;
    });
    const changed = await new DatabricksStore(root).read();
    expect(changed.entries[0]!.endpoint.reasoningOptions?.map(({ id }) => id)).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(changed.entries[1]!.endpoint.reasoningOptions).toEqual([]);
    expect(changed.scans[0]!.endpoints[0]!.reasoningOptions?.map(({ id }) => id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    const persisted = await new DatabricksStore(root).update(() => {});
    expect(await new DatabricksStore(root).read()).toEqual(persisted);
  });

  it('does not apply the latest entry identity to a historical unknown scan snapshot', async () => {
    const { root } = await savedStore([entry('unrecognised')], true);
    const store = new DatabricksStore(root);
    await store.update((generation) => {
      const previous = generation.entries[0]!;
      generation.entries[0] = entry('claude-sonnet-5');
      generation.entries[0]!.endpoint.id = previous.endpoint.id;
    });
    const restored = await new DatabricksStore(root).read();
    expect(restored.entries[0]!.endpoint.capabilities.contextWindow).toBe(1_000_000);
    expect(restored.scans[0]!.endpoints[0]!.capabilities).toMatchObject({ contextWindow: null, maxTokens: null,
      limitSources: { contextWindow: 'unknown', maxTokens: 'unknown' } });
  });
});
