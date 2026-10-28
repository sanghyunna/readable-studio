import type http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  DesignTemplateImportResponse,
  DesignTemplateUploadAnalysisResponse,
  DesignTemplateUploadBundleAnalysisResponse,
  DesignTemplateUploadBundleCancelResponse,
  DesignTemplateUploadCancelResponse,
  DesignTemplateUploadFinalizeResponse,
  DesignTemplatesResponse,
} from '@readable-studio/contracts';
import { startServer } from '../src/server.js';
import { closeDatabase } from '../src/db.js';
import { buildBundleZip, buildTemplateZip, kitTemplateEntries, validTemplateEntries } from './helpers/template-zip.js';

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
  return analyseZip(buildTemplateZip(entries), fileName, headers);
}
async function analyseZip(zip: Buffer, fileName = 'kit.zip', headers: Record<string, string> = {}) {
  const form = new FormData();
  form.append('file', new Blob([zip]), fileName);
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
    expect(analysis).toMatchObject({ kind: 'single', detectedType: 'report', detection: { type: 'report' } });
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

  it('finalizes the detected type when the type is omitted and rejects website uploads', async () => {
    const analysis = await (await analyse(kitTemplateEntries())).json() as DesignTemplateUploadAnalysisResponse;
    const selection = { name: 'Detected Kit', coverPageId: analysis.suggestedCoverPageId };
    const website = await finalize(analysis.sessionId, { ...selection, type: 'website' });
    expect(website.status).toBe(400);
    expect((await website.json() as { error: { message: string } }).error.message)
      .toBe('website templates can no longer be uploaded; use deck or report');
    const done = await finalize(analysis.sessionId, selection);
    expect(done.status).toBe(201);
    const { template } = await done.json() as DesignTemplateUploadFinalizeResponse;
    expect(template).toMatchObject({ templateType: 'report', mode: 'prototype' });
    expect((await finalize(analysis.sessionId, { ...selection, type: 'report' })).status).toBe(201);
    expect((await finalize(analysis.sessionId, { ...selection, type: 'website' })).status).toBe(400);
    await fetch(`${baseUrl}/api/design-templates/${template.id}`, { method: 'DELETE' });
  });

  it('analyses a bundle into child sessions and cancels the unsaved ones', async () => {
    const zip = buildBundleZip([
      { name: 'deck.zip', entries: validTemplateEntries() },
      { name: 'report.zip', entries: kitTemplateEntries() },
      { name: 'broken.zip', entries: kitTemplateEntries().slice(1) },
    ]);
    const res = await analyseZip(zip, 'pack.zip');
    expect(res.status).toBe(201);
    const bundle = await res.json() as DesignTemplateUploadBundleAnalysisResponse;
    expect(bundle).toMatchObject({ kind: 'bundle', originalFileName: 'pack.zip' });
    expect(bundle.templates.map((t) => [t.entryName, t.ok])).toEqual([['broken.zip', false], ['deck.zip', true], ['report.zip', true]]);
    const [deckChild, reportChild] = bundle.templates.flatMap((t) => (t.ok ? [t.analysis] : []));

    const child = await fetch(`${uploads()}/${reportChild!.sessionId}`);
    expect(child.status).toBe(200);
    expect(await child.json()).toMatchObject({ kind: 'single', bundleId: bundle.bundleId, detectedType: 'report' });
    expect((await fetch(`${baseUrl}${reportChild!.pages[0]!.previewUrl}`)).status).toBe(200);

    const saved = await finalize(deckChild!.sessionId, { name: deckChild!.suggestedName, coverPageId: deckChild!.suggestedCoverPageId });
    expect(saved.status).toBe(201);
    const { template } = await saved.json() as DesignTemplateUploadFinalizeResponse;
    expect(template).toMatchObject({ templateType: 'deck' });

    const bundleUrl = `${uploads()}/bundles/${bundle.bundleId}`;
    expect((await fetch(bundleUrl, { method: 'DELETE', headers: { origin: 'http://evil.example' } })).status).toBe(403);
    const cancelled = await fetch(bundleUrl, { method: 'DELETE' });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json() as DesignTemplateUploadBundleCancelResponse)
      .toEqual({ ok: true, cancelledSessionIds: [reportChild!.sessionId] });
    expect((await fetch(`${uploads()}/${reportChild!.sessionId}`)).status).toBe(404);
    expect(await (await fetch(bundleUrl, { method: 'DELETE' })).json()).toEqual({ ok: true, cancelledSessionIds: [] });
    expect(await (await fetch(`${uploads()}/bundles/not-a-bundle`, { method: 'DELETE' })).json()).toEqual({ ok: true, cancelledSessionIds: [] });
    expect((await listing()).some((t) => t.id === template.id)).toBe(true);
    await fetch(`${baseUrl}/api/design-templates/${template.id}`, { method: 'DELETE' });
  });

  it('rejects a bundle without valid templates with 400', async () => {
    const res = await analyseZip(buildBundleZip([{ name: 'a.zip', entries: kitTemplateEntries().slice(1) }]), 'pack.zip');
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { message: string } }).error.message)
      .toBe('bundle contains no valid templates: a.zip: template zip must contain PROMPT.md at its root');
  });

  it('keeps listing, renaming and deleting an existing website template', async () => {
    const form = new FormData();
    form.append('file', new Blob([buildTemplateZip(validTemplateEntries())]), 'site.zip');
    const { template } = await (await fetch(`${baseUrl}/api/design-templates/import`, { method: 'POST', body: form })).json() as DesignTemplateImportResponse;
    // Turn it into a pre-1.3.9 website upload.
    const dir = path.join(dataDir!, 'design-templates', template.id);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'import.json'), 'utf8'));
    writeFileSync(path.join(dir, 'import.json'), JSON.stringify({ ...manifest, type: 'website' }));
    const renamed = await fetch(`${baseUrl}/api/design-templates/${template.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Old Site' }),
    });
    expect(renamed.status).toBe(200);
    const skillMd = readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    expect(skillMd).toContain('hubType: website');
    expect(skillMd).toContain('mode: prototype');
    expect((await listing()).find((t) => t.id === template.id)).toMatchObject({ templateType: 'website', displayName: { en: 'Old Site' } });
    expect((await fetch(`${baseUrl}/api/design-templates/${template.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await listing()).some((t) => t.id === template.id)).toBe(false);
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
