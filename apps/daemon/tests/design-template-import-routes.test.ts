import type http from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  DesignTemplateDeleteResponse,
  DesignTemplateImportResponse,
  DesignTemplateRenameResponse,
  DesignTemplatesResponse,
} from '@readable-studio/contracts';
import { startServer } from '../src/server.js';
import { closeDatabase } from '../src/db.js';
import { PNG_1PX, buildBundleZip, buildTemplateZip, kitTemplateEntries, validTemplateEntries } from './helpers/template-zip.js';

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

async function upload(entries: { name: string; body: string | Buffer }[], fileName: string) {
  const form = new FormData();
  form.append('file', new Blob([buildTemplateZip(entries)]), fileName);
  return fetch(`${baseUrl}/api/design-templates/import`, { method: 'POST', body: form, signal: AbortSignal.timeout(15_000) });
}
const listing = async () =>
  (await (await fetch(`${baseUrl}/api/design-templates`)).json() as DesignTemplatesResponse).designTemplates;

describe('design template import routes', () => {
  it('imports, lists, serves the thumbnail, renames, and deletes a user template', async () => {
    const res = await upload([...validTemplateEntries(), { name: 'thumbnail.png', body: PNG_1PX }], 'deck.zip');
    expect(res.status).toBe(201);
    const { template } = await res.json() as DesignTemplateImportResponse;
    expect(template).toMatchObject({
      id: 'user-quarterly-review', source: 'user', mode: 'deck', userImported: true,
      thumbnail: { status: 'ready', source: 'zip' },
    });

    const listed = (await listing()).find((t) => t.id === template.id);
    expect(listed).toMatchObject({ userImported: true, source: 'user', thumbnail: { status: 'ready' } });
    expect((await listing()).find((t) => t.id === 'blog-post')?.userImported).toBeUndefined();

    const thumb = await fetch(`${baseUrl}/api/design-templates/${template.id}/thumbnail`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await thumb.arrayBuffer()).equals(PNG_1PX)).toBe(true);

    const renamed = await fetch(`${baseUrl}/api/design-templates/${template.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Board Update' }),
    });
    expect(renamed.status).toBe(200);
    const renamedBody = await renamed.json() as DesignTemplateRenameResponse;
    expect(renamedBody.template).toMatchObject({ id: template.id, displayName: { en: 'Board Update' } });

    const removed = await fetch(`${baseUrl}/api/design-templates/${template.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(await removed.json() as DesignTemplateDeleteResponse).toEqual({ ok: true, id: template.id });
    expect(existsSync(path.join(dataDir!, 'design-templates', template.id))).toBe(false);
    expect((await listing()).some((t) => t.id === template.id)).toBe(false);
  });

  it('marks templates without a zip thumbnail pending and 404s their thumbnail', async () => {
    const res = await upload(validTemplateEntries('plain prompt'), 'Pending Deck.zip');
    expect(res.status).toBe(201);
    const { template } = await res.json() as DesignTemplateImportResponse;
    expect(template.thumbnail).toMatchObject({ status: 'pending', source: null });
    expect((await fetch(`${baseUrl}/api/design-templates/${template.id}/thumbnail`)).status).toBe(404);
    await fetch(`${baseUrl}/api/design-templates/${template.id}`, { method: 'DELETE' });
  });

  it('lists the actual cover path for a pending live preview instead of assuming cover.html', async () => {
    const res = await upload([
      { name: 'PROMPT.md', body: '---\nname: Custom cover\ncover: slides/opening.htm\n---\nUse these layouts.' },
      { name: 'slides/opening.htm', body: '<!doctype html><h1>Opening</h1>' },
      { name: 'agenda.html', body: '<!doctype html><h1>Agenda</h1>' },
    ], 'custom-cover.zip');
    expect(res.status).toBe(201);
    const { template } = await res.json() as DesignTemplateImportResponse;
    expect((await listing()).find((entry) => entry.id === template.id)).toMatchObject({
      cover: 'slides/opening.htm', thumbnail: { status: 'pending' },
    });
    const cover = await fetch(`${baseUrl}/api/design-templates/${template.id}/pages/slides/opening.htm`);
    expect(cover.status).toBe(200);
    expect(await cover.text()).toContain('<h1>Opening</h1>');
    await fetch(`${baseUrl}/api/design-templates/${template.id}`, { method: 'DELETE' });
  });

  it('registers the detected type and rejects a bundle zip', async () => {
    const res = await upload(kitTemplateEntries(), 'kit.zip');
    expect(res.status).toBe(201);
    const { template } = await res.json() as DesignTemplateImportResponse;
    expect(template).toMatchObject({ templateType: 'report', mode: 'prototype' });
    await fetch(`${baseUrl}/api/design-templates/${template.id}`, { method: 'DELETE' });

    const form = new FormData();
    form.append('file', new Blob([buildBundleZip([{ name: 'a.zip', entries: validTemplateEntries() }, { name: 'b.zip', entries: kitTemplateEntries() }])]), 'pack.zip');
    const bundle = await fetch(`${baseUrl}/api/design-templates/import`, { method: 'POST', body: form });
    expect(bundle.status).toBe(400);
    expect((await bundle.json() as { error: { message: string } }).error.message)
      .toBe('zip is a template bundle (2 templates); use the template upload wizard or "readable design-templates import <zip> --all"');
  });

  it('rejects invalid zips with 400', async () => {
    const missingPrompt = await upload(validTemplateEntries().slice(1), 'deck.zip');
    expect(missingPrompt.status).toBe(400);
    const traversal = await upload([...validTemplateEntries(), { name: '../evil.html', body: 'x' }], 'deck.zip');
    expect(traversal.status).toBe(400);
    const notZip = await upload(validTemplateEntries(), 'deck.txt');
    expect(notZip.status).toBe(400);
  });

  it('refuses to rename or delete a built-in template', async () => {
    const del = await fetch(`${baseUrl}/api/design-templates/blog-post`, { method: 'DELETE' });
    expect(del.status).toBe(403);
    const patch = await fetch(`${baseUrl}/api/design-templates/blog-post`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }),
    });
    expect(patch.status).toBe(403);
    expect((await listing()).some((t) => t.id === 'blog-post')).toBe(true);
  });
});
