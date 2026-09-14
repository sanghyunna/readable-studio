import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabricksScanResponse } from '@readable-studio/contracts';
import type { CatalogueEntry } from './catalogue.js';
import { databricksEndpointLabel, resolveDatabricksCapabilities, resolveDatabricksReasoningOptions } from './capabilities.js';
import type { DatabricksConnectionBinding } from './credentials.js';
import { DatabricksServiceError } from './client.js';

export interface CatalogueGeneration {
  version: 1;
  revision: number;
  secret: string;
  bindings: DatabricksConnectionBinding[];
  entries: CatalogueEntry[];
  scopes: Array<{ id: string; profileId: string; name: string }>;
  scans: DatabricksScanResponse[];
}

/** One daemon owns this store. All writes are serialized; readers see whole generations. */
export class DatabricksStore {
  private readonly root: string;
  private readonly initial: Promise<CatalogueGeneration>;
  private current: CatalogueGeneration | undefined;
  private tail: Promise<void> = Promise.resolve();
  constructor(dataRoot: string) {
    this.root = join(dataRoot, 'databricks');
    this.initial = this.load();
  }

  private async load(): Promise<CatalogueGeneration> {
    try {
      const pointer: unknown = JSON.parse(await readFile(join(this.root, 'current.json'), 'utf8'));
      if (!pointer || typeof pointer !== 'object' || !('file' in pointer) || typeof pointer.file !== 'string' || !/^generation-[0-9a-f-]+\.json$/.test(pointer.file)) throw new Error();
      const generation = JSON.parse(await readFile(join(this.root, pointer.file), 'utf8')) as CatalogueGeneration;
      if (generation.version !== 1 || !Number.isSafeInteger(generation.revision) || typeof generation.secret !== 'string'
        || !Array.isArray(generation.bindings) || !Array.isArray(generation.entries) || !Array.isArray(generation.scopes) || !Array.isArray(generation.scans)) throw new Error();
      // Older catalogues already retained routing names. Restore UI identity without
      // changing IDs, registration, revisions, or performing a workspace lookup.
      for (const entry of generation.entries) {
        entry.endpoint.displayName ??= entry.upstreamName;
      }
      for (const scan of generation.scans) for (const endpoint of scan.endpoints) {
        const entry = generation.entries.find((candidate) => candidate.endpoint.id === endpoint.id);
        if (entry) endpoint.displayName ??= entry.upstreamName;
      }
      // Migrate each snapshot from its own served identity, not the latest entry:
      // a rescan may have changed the model behind the same endpoint ID.
      for (const endpoint of [...generation.entries.map((entry) => entry.endpoint), ...generation.scans.flatMap((scan) => scan.endpoints)]) {
        endpoint.reasoningOptions = resolveDatabricksReasoningOptions(endpoint.api,
          (endpoint.servedModelName?.split(', ') ?? []).map((name) => ({ name })));
        if (!endpoint.capabilities.limitSources || endpoint.capabilities.contextWindow === null || endpoint.capabilities.maxTokens === null) {
          const resolved = resolveDatabricksCapabilities({}, (endpoint.servedModelName?.split(', ') ?? []).map((name) => ({ name, metadata: {} })));
          endpoint.capabilities = { ...resolved, ...endpoint.capabilities, limitSources: {
            contextWindow: endpoint.capabilities.contextWindow === null ? resolved.limitSources!.contextWindow : endpoint.capabilities.limitSources?.contextWindow ?? 'metadata',
            maxTokens: endpoint.capabilities.maxTokens === null ? resolved.limitSources!.maxTokens : endpoint.capabilities.limitSources?.maxTokens ?? 'metadata',
          }, contextWindow: endpoint.capabilities.contextWindow ?? resolved.contextWindow,
          maxTokens: endpoint.capabilities.maxTokens ?? resolved.maxTokens };
        }
        if (endpoint.displayName) endpoint.label = databricksEndpointLabel(endpoint.servedModelName ?? endpoint.displayName);
      }
      return this.current = generation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE');
      // A missing referenced generation is corruption, not an empty catalogue.
      try { await readFile(join(this.root, 'current.json'), 'utf8'); }
      catch (pointerError) {
        if ((pointerError as NodeJS.ErrnoException).code === 'ENOENT') {
          return this.current = { version: 1, revision: 0, secret: randomBytes(32).toString('hex'), bindings: [], entries: [], scopes: [], scans: [] };
        }
      }
      throw new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE');
    }
  }

  async read(): Promise<CatalogueGeneration> {
    await this.initial;
    return structuredClone(this.current!);
  }

  async update(mutate: (next: CatalogueGeneration) => void): Promise<CatalogueGeneration> {
    const operation = this.tail.then(async () => {
      const next = await this.read();
      mutate(next);
      next.revision++;
      try {
        await mkdir(this.root, { recursive: true });
        const file = `generation-${randomUUID()}.json`;
        await this.atomicWrite(join(this.root, file), JSON.stringify(next));
        await this.atomicWrite(join(this.root, 'current.json'), JSON.stringify({ file }));
      } catch { throw new DatabricksServiceError('DATABRICKS_UPSTREAM_UNAVAILABLE', true); }
      this.current = next;
      return structuredClone(next);
    });
    // Keep the queue usable after a failed write; the operation still rejects to its caller.
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async atomicWrite(destination: string, value: string): Promise<void> {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
