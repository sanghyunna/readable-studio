import type http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  DesignTemplateImportResponse,
  DesignTemplateUploadAnalysisResponse,
  DesignTemplateUploadCancelResponse,
  DesignTemplateUploadFinalizeResponse,
  DesignTemplatesResponse,
} from '@readable-studio/contracts';
import { startServer } from '../src/server.js';
import { closeDatabase } from '../src/db.js';
import { buildTemplateZip, kitTemplateEntries, validTemplateEntries } from './helpers/template-zip.js';

const dataDir = process.env.READABLE_DATA_DIR;
if (!dataDir) throw new Error('isolated READABLE_DATA_DIR required');
let server: http.Server;
let baseUrl: string;
let shutdown: () => Promise<void>;
beforeAll(async () => {
  const started = await startServer({ port: 0, returnServer: true }) as { server: http.Server; url: string; shutdown: () => Promise<void> };
  server = started.server;
  baseUrl = started.url;
  shutdown = started.shutdown;
});
afterAll(async () => {
  await shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase();
});

const uploads = () => `${baseUrl}/api/design-template-uploads`;
async function analyse(entries: { name: string; body: string | Buffer }[], fileName = 'kit.zip', headers: Record<string, string> = {}) {
  const form = new FormData();
  form.append('file', new Blob([buildTemplateZip(entries)]), fileName);
  return fetch(`${uploads()}/analyse`, { method: 'POST', body: form, headers, signal: AbortSignal.timeout(15_000) });
}
const finalize = (sessionId: string, body: unknown) => fetch(`${uploads()}/${sessionId}/finalize`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const listing = async () =>
  (await (await fetch(`${baseUrl}/api/design-templates`)).json() as DesignTemplatesResponse).designTemplates;

describe('design template upload routes', () => {
  it('analyses, serves pages, finalizes once as a report and cancels idempotently', async () => {
    const res = await analyse(kitTemplateEntries());
    expect(res.status).toBe(201);
    const analysis = await res.json() as DesignTemplateUploadAnalysisResponse;
    expect(analysis.prompt).toEqual({ file: 'PROMPT.md' });
    expect(analysis.pages.map((p) => p.file)).toEqual(['kit/cover.html', 'kit/report.htm', 'kit/nested/detail.html']);
    expect((await listing()).some((t) => t.displayName?.en === 'Kit Pack')).toBe(false);

    const again = await fetch(`${uploads()}/${analysis.sessionId}`);
    expect(again.status).toBe(200);
    expect((await again.json() as DesignTemplateUploadAnalysisResponse).sessionId).toBe(analysis.sessionId);

    const page = await fetch(`${baseUrl}${analysis.pages[2]!.previewUrl}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Kit detail');
    const css = await fetch(`${uploads()}/${analysis.sessionId}/pages/kit/assets/shared.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect((await fetch(`${uploads()}/${analysis.sessionId}/pages/kit/..%2f..%2fsession.json`)).status).toBe(403);
    expect((await fetch(`${uploads()}/${analysis.sessionId}/pages/kit/missing.html`)).status).toBe(404);
    expect((await fetch(`${uploads()}/${analysis.sessionId}/thumbnails/not-a-page`)).status).toBe(404);

    const badType = await finalize(analysis.sessionId, { type: 'slides', name: 'x', coverPageId: analysis.suggestedCoverPageId });
    expect(badType.status).toBe(400);
    expect((await badType.json() as { error: { code: string } }).error.code).toBe('BAD_REQUEST');

    const selection = { type: 'report', name: 'Kit Report', coverPageId: analysis.pages[1]!.id };
    const done = await finalize(analysis.sessionId, selection);
    expect(done.status).toBe(201);
    const { template } = await done.json() as DesignTemplateUploadFinalizeResponse;
    expect(template).toMatchObject({
      id: 'user-kit-report', userImported: true, templateType: 'report', cover: 'kit/report.htm', mode: 'prototype',
    });
    const retried = await finalize(analysis.sessionId, selection);
    expect(retried.status).toBe(201);
    expect((await retried.json() as DesignTemplateUploadFinalizeResponse).template.id).toBe(template.id);
    expect((await finalize(analysis.sessionId, { ...selection, type: 'deck' })).status).toBe(409);
    expect((await listing()).filter((t) => t.id.startsWith('user-kit-report'))).toHaveLength(1);
    expect((await listing()).find((t) => t.id === template.id)).toMatchObject({ templateType: 'report' });

    const cancelled = await fetch(`${uploads()}/${analysis.sessionId}`, { method: 'DELETE' });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json() as DesignTemplateUploadCancelResponse).toEqual({ ok: true });
    expect((await fetch(`${uploads()}/${analysis.sessionId}`, { method: 'DELETE' })).status).toBe(200);
    expect((await listing()).some((t) => t.id === template.id)).toBe(true);
    await fetch(`${baseUrl}/api/design-templates/${template.id}`, { method: 'DELETE' });
  });

  it('cancelled and unknown sessions answer 404', async () => {
    const analysis = await (await analyse(kitTemplateEntries())).json() as DesignTemplateUploadAnalysisResponse;
    expect((await fetch(`${uploads()}/${analysis.sessionId}`, { method: 'DELETE' })).status).toBe(200);
    const gone = await fetch(`${uploads()}/${analysis.sessionId}`);
    expect(gone.status).toBe(404);
    expect((await gone.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    expect((await fetch(`${uploads()}/${analysis.sessionId}/pages/kit/cover.html`)).status).toBe(404);
    expect((await finalize(analysis.sessionId, { type: 'deck', name: 'x', coverPageId: analysis.suggestedCoverPageId })).status).toBe(404);
    expect((await fetch(`${uploads()}/not-a-session`)).status).toBe(404);
  });

  it('rejects invalid uploads with 400 and foreign origins with 403', async () => {
    expect((await analyse(kitTemplateEntries().slice(1))).status).toBe(400);
    expect((await analyse(kitTemplateEntries(), 'kit.txt')).status).toBe(400);
    expect((await analyse([...kitTemplateEntries(), { name: '../evil.html', body: 'x' }])).status).toBe(400);
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('not a zip')]), 'broken.zip');
    expect((await fetch(`${uploads()}/analyse`, { method: 'POST', body: form })).status).toBe(400);
    expect((await analyse(kitTemplateEntries(), 'kit.zip', { origin: 'http://evil.example' })).status).toBe(403);
  });

  it('lists templateType deck for legacy imports, including manifests without a type', async () => {
    const form = new FormData();
    form.append('file', new Blob([buildTemplateZip(validTemplateEntries())]), 'legacy.zip');
    const res = await fetch(`${baseUrl}/api/design-templates/import`, { method: 'POST', body: form });
    expect(res.status).toBe(201);
    const { template } = await res.json() as DesignTemplateImportResponse;
    expect(template.templateType).toBe('deck');
    const manifestPath = path.join(dataDir!, 'design-templates', template.id, 'import.json');
    const { type: _type, ...legacy } = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, JSON.stringify(legacy));
    expect((await listing()).find((t) => t.id === template.id)).toMatchObject({ templateType: 'deck', mode: 'deck' });
    await fetch(`${baseUrl}/api/design-templates/${template.id}`, { method: 'DELETE' });
  });
});
