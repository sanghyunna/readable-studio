import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  DesignTemplateImportResponse,
  DesignTemplatesResponse,
} from '@readable-studio/contracts';
import { startServer } from '../src/server.js';
import { closeDatabase } from '../src/db.js';
import { buildTemplateZip, validTemplateEntries } from './helpers/template-zip.js';

const dataDir = process.env.READABLE_DATA_DIR;
if (!dataDir) throw new Error('isolated READABLE_DATA_DIR required');

let server: http.Server;
let baseUrl: string;
let shutdown: () => Promise<void>;

beforeAll(async () => {
  const started = await startServer({ port: 0, returnServer: true }) as {
    server: http.Server;
    url: string;
    shutdown: () => Promise<void>;
  };
  server = started.server;
  baseUrl = started.url;
  shutdown = started.shutdown;
});

afterAll(async () => {
  await shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase();
});

async function upload(entries: { name: string; body: string | Buffer }[], fileName: string) {
  const form = new FormData();
  form.append('file', new Blob([buildTemplateZip(entries)]), fileName);
  return fetch(`${baseUrl}/api/design-templates/import`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
}

const listing = async () =>
  (await (await fetch(`${baseUrl}/api/design-templates`)).json() as DesignTemplatesResponse).designTemplates;

describe('user template importedAt', () => {
  it('surfaces importedAt in the import response and in the list response', async () => {
    const res = await upload(validTemplateEntries(), 'deck.zip');
    expect(res.status).toBe(201);
    const { template } = await res.json() as DesignTemplateImportResponse;

    expect(template.userImported).toBe(true);
    expect(typeof template.importedAt).toBe('string');
    expect(Date.parse(template.importedAt!)).not.toBeNaN();

    const listed = (await listing()).find((t) => t.id === template.id);
    expect(listed).toBeDefined();
    expect(listed!.importedAt).toBe(template.importedAt);

    await fetch(`${baseUrl}/api/design-templates/${template.id}`, { method: 'DELETE' });
  });

  it('does not expose importedAt on built-in templates', async () => {
    const builtIn = (await listing()).find((t) => t.id === 'blog-post');
    expect(builtIn).toBeDefined();
    expect(builtIn!.importedAt).toBeUndefined();
  });
});
