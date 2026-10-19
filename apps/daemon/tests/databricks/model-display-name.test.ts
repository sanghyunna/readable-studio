import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeResource } from '../../src/databricks/catalogue.js';
import { scanWorkspace, type WorkspaceScanOptions } from '../../src/databricks/scan.js';
import { DatabricksStore } from '../../src/databricks/store.js';
import { createDatabricksService } from '../../src/databricks/service.js';
import { registeredDatabricksModels, type DatabricksRuntimeService } from '../../src/runtimes/defs/databricks.js';
import type { DatabricksRegisteredEndpoint } from '@readable-studio/contracts';

function endpoint(name: string, kind: DatabricksRegisteredEndpoint['kind'] = 'uc-model-service'): DatabricksRegisteredEndpoint {
  return normalizeResource('secret', 'profile', {
    kind, name, metadata: { supported_api_types: ['openai/v1/chat/completions'] },
  }).endpoint as DatabricksRegisteredEndpoint;
}

function options(models: DatabricksRegisteredEndpoint[]) {
  return registeredDatabricksModels({ listModels: async () => ({ models, revision: 1 }) } as DatabricksRuntimeService);
}

describe('Databricks catalogue display names', () => {
  it('shortens a UC name without changing any routing or selection identity', async () => {
    const model = endpoint('system.ai.databricks-claude-opus-5-5');
    const [option] = await options([model]);
    expect(option!.label).toBe('databricks-claude-opus-5-5');
    expect(option!.id).toBe(model.appModelId);
    const entry = normalizeResource('secret', 'profile', {
      kind: 'uc-model-service', name: model.displayName!, metadata: {},
    });
    expect(entry.upstreamName).toBe('system.ai.databricks-claude-opus-5-5');
    expect(entry.endpoint.appModelId).toBe(model.appModelId);
  });

  it.each(['gpt-5.6-luna', 'claude-3.5-sonnet', 'llama-3.1-70b', 'meta-llama-3.3-70b-instruct', 'vendor.model.v3.5'])(
    'preserves all periods in UC model %s and in serving endpoint names', async name => {
      const [uc] = await options([endpoint(`system.ai.${name}`)]);
      const [serving] = await options([endpoint(name, 'serving-endpoint')]);
      expect(uc!.label).toBe(name);
      expect(serving!.label).toBe(name);
    },
  );

  it('distinguishes schemas and endpoint/service collisions', async () => {
    const models = [endpoint('system.ai.same'), endpoint('corp.prod.same'), endpoint('same', 'serving-endpoint')];
    const labels = (await options(models)).map(option => option.label);
    expect(new Set(labels).size).toBe(3);
    expect(labels.every(label => label.includes('same'))).toBe(true);
  });

  it('uses structured UC catalog and schema without treating model periods as separators', async () => {
    const model = normalizeResource('secret', 'profile', {
      kind: 'uc-model-service', name: 'catalog.with.dot.schema.vendor.model.v3.5',
      metadata: { catalog_name: 'catalog.with.dot', schema_name: 'schema', supported_api_types: ['openai/v1/chat/completions'] },
    }).endpoint as DatabricksRegisteredEndpoint;
    expect((await options([model]))[0]!.label).toBe('vendor.model.v3.5');
  });

  it('retains the known schema boundary from enumeration even when detail metadata omits it', async () => {
    const scope = 'catalog.with.dot.schema';
    const name = `${scope}.vendor.model.v3.5`;
    const scan = await scanWorkspace({
      binding: { host: 'https://workspace.example' } as WorkspaceScanOptions['binding'],
      bearer: 'fixture', scopeNames: [scope],
      fetch: async url => {
        const path = new URL(url).pathname;
        return Response.json(path.endsWith('/model-services') ? { model_services: [{ name: `model-services/${name}` }] }
          : path.includes('/model-services/') ? { supported_api_types: ['openai/v1/chat/completions'] }
          : { endpoints: [] });
      },
    });
    expect(scan.resources).toHaveLength(1);
    expect(scan.resources[0]).toMatchObject({ name, ucModelName: 'vendor.model.v3.5' });
    const entry = normalizeResource('secret', 'profile', scan.resources[0]!);
    expect((await options([entry.endpoint as DatabricksRegisteredEndpoint]))[0]!.label).toBe('vendor.model.v3.5');
    expect(entry.upstreamName).toBe(name);
  });

  it('migrates saved catalogue labels and disambiguates public models without changing cached ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'databricks-names-'));
    try {
      const entries = [
        { kind: 'uc-model-service' as const, name: 'system.ai.same' },
        { kind: 'uc-model-service' as const, name: 'corp.prod.same' },
        { kind: 'serving-endpoint' as const, name: 'same' },
        { kind: 'uc-model-service' as const, name: 'catalog.with.dot.schema.vendor.model.v3.5', ucModelName: 'vendor.model.v3.5' },
      ].map(resource => normalizeResource('secret', 'profile', {
        ...resource, metadata: { supported_api_types: ['openai/v1/chat/completions'] },
      }));
      for (const entry of entries) {
        entry.endpoint.enabled = true;
        entry.endpoint.label = entry.upstreamName;
      }
      await new DatabricksStore(root).update(next => { next.entries = entries; });
      const listed = await createDatabricksService({ dataRoot: root }).listModels();
      expect(listed.models.map(model => model.appModelId)).toEqual(entries.map(entry => entry.endpoint.appModelId));
      expect(new Set(listed.models.slice(0, 3).map(model => model.label)).size).toBe(3);
      expect(listed.models[3]!.label).toBe('vendor.model.v3.5');
      const restarted = await new DatabricksStore(root).read();
      expect(restarted.entries.map(entry => entry.upstreamName)).toEqual(entries.map(entry => entry.upstreamName));
      expect(restarted.entries.map(entry => entry.endpoint.appModelId)).toEqual(entries.map(entry => entry.endpoint.appModelId));
      expect(restarted.revision).toBe(listed.revision);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
