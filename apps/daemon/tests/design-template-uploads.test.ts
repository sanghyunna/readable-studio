// Upload-wizard sessions: analyse extracts a ZIP into a hidden session without
// registering a template, renders every page through the desktop renderer,
// and finalize registers exactly one template with the chosen type/name/cover.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/design-template-thumbnails.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/design-template-thumbnails.js')>()),
  requestTemplateThumbnails: vi.fn(async () => undefined),
}));

import {
  configureTemplateThumbnails,
  requestTemplateThumbnails,
} from '../src/design-template-thumbnails.js';
import { DesignTemplateImportError, renameUserDesignTemplate } from '../src/design-template-import.js';
import { DesignTemplateUploadSessions } from '../src/design-template-uploads.js';
import { invalidateSkillListCache, listSkills } from '../src/skills.js';
import { PNG_1PX, buildTemplateZip, kitTemplateEntries } from './helpers/template-zip.js';

const WEBP = Buffer.from('524946460400000057454250', 'hex');
const ORIGIN = 'http://127.0.0.1:12345';
let root: string;
let clock: number;
let sessions: DesignTemplateUploadSessions;
const render = vi.fn();

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'rs-template-uploads-'));
  clock = Date.parse('2026-10-19T00:00:00.000Z');
  render.mockReset().mockResolvedValue(WEBP);
  vi.mocked(requestTemplateThumbnails).mockClear();
  configureTemplateThumbnails({ root, origin: () => ORIGIN, render, ready: async () => true });
  sessions = new DesignTemplateUploadSessions({ root, now: () => clock });
});
afterEach(async () => {
  sessions.dispose();
  invalidateSkillListCache();
  rmSync(root, { recursive: true, force: true });
});

const analyse = (entries: { name: string; body: string | Buffer }[] = kitTemplateEntries(), originalFileName = 'kit.zip') =>
  sessions.analyse({ zip: buildTemplateZip(entries), originalFileName });
const pageId = (analysis: { pages: { id: string; file: string }[] }, file: string) =>
  analysis.pages.find((p) => p.file === file)!.id;
const uploadsDir = () => path.join(root, '.uploads');

async function expectStatus(promise: Promise<unknown>, status: number) {
  const err = await promise.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(DesignTemplateImportError);
  expect((err as DesignTemplateImportError).status).toBe(status);
}

describe('design template upload analyse', () => {
  it('uses each template page canvas for previews and captures instead of a 1080p viewport', async () => {
    const analysis = await analyse([
      { name: 'PROMPT.md', body: 'Native page dimensions' },
      { name: 'wide.html', body: '<link rel="stylesheet" href="assets/deck.css"><main class="slide">720p</main>' },
      { name: 'assets/deck.css', body: ':root{--canvasW:1280px;--canvasH:720px}.slide{width:var(--canvasW);height:var(--canvasH)}' },
      { name: 'portrait.html', body: '<main style="width:900px;height:1200px">Portrait</main>' },
      { name: 'responsive.html', body: '<main style="width:100%;min-height:100vh">Responsive</main>' },
    ]);
    await sessions.whenIdle(analysis.sessionId);
    expect(analysis.pages.map((page) => page.viewport)).toEqual([
      { width: 1280, height: 720 }, { width: 900, height: 1200 }, { width: 1920, height: 1080 },
    ]);
    expect(render.mock.calls.map((call) => call[1])).toEqual([
      { width: 1280, height: 720, outWidth: 480, outHeight: 270 },
      { width: 900, height: 1200, outWidth: 360, outHeight: 480 },
      { width: 1920, height: 1080, outWidth: 480, outHeight: 270 },
    ]);
    const resumed = new DesignTemplateUploadSessions({ root, now: () => clock });
    expect((await resumed.get(analysis.sessionId)).pages[1]!.viewport).toEqual({ width: 900, height: 1200 });
    resumed.dispose();
  });

  it('lists every HTML of a root PROMPT.md + kit/*.html zip and registers nothing', async () => {
    const analysis = await analyse();
    expect(analysis.sessionId).toMatch(/^[a-f0-9]{32}$/);
    expect(analysis.expiresAt).toBe(new Date(clock + 60 * 60_000).toISOString());
    expect(analysis.originalFileName).toBe('kit.zip');
    expect(analysis.prompt).toEqual({ file: 'PROMPT.md' });
    expect(analysis.suggestedName).toBe('Kit Pack');
    expect(analysis.pages.map((p) => p.file)).toEqual(['kit/cover.html', 'kit/report.htm', 'kit/nested/detail.html']);
    expect(analysis.pages.find((p) => p.file === 'kit/report.htm')!.use).toBe('Body section');
    expect(analysis.suggestedCoverPageId).toBe(pageId(analysis, 'kit/cover.html'));
    for (const page of analysis.pages) {
      expect(page.id).not.toContain('/');
      expect(page.previewUrl).toBe(`/api/design-template-uploads/${analysis.sessionId}/pages/${page.file}`);
      expect(page.thumbnailUrl).toBe(`/api/design-template-uploads/${analysis.sessionId}/thumbnails/${page.id}`);
    }
    const pagesDir = await sessions.pagesDir(analysis.sessionId);
    expect(readFileSync(path.join(pagesDir, 'kit/assets/shared.css'), 'utf8')).toBe('h1{color:#0a0a0a}');
    await sessions.whenIdle(analysis.sessionId);
    expect(await listSkills([root])).toEqual([]);
    expect(readdirSync(root).filter((name) => !name.startsWith('.'))).toEqual([]);
  });

  it('renders every page and attaches a zip thumbnail only to the suggested cover', async () => {
    const analysis = await analyse([...kitTemplateEntries(), { name: 'thumbnail.png', body: PNG_1PX }]);
    await sessions.whenIdle(analysis.sessionId);
    const coverId = pageId(analysis, 'kit/cover.html');
    expect(render.mock.calls.map((c) => c[0])).toEqual([
      `${ORIGIN}/api/design-template-uploads/${analysis.sessionId}/pages/kit/report.htm`,
      `${ORIGIN}/api/design-template-uploads/${analysis.sessionId}/pages/kit/nested/detail.html`,
    ]);
    const current = await sessions.get(analysis.sessionId);
    expect(current.pages.map((p) => [p.file, p.thumbnail.status, p.thumbnail.source])).toEqual([
      ['kit/cover.html', 'ready', 'zip'],
      ['kit/report.htm', 'ready', 'rendered'],
      ['kit/nested/detail.html', 'ready', 'rendered'],
    ]);
    expect(readFileSync((await sessions.thumbnailFile(analysis.sessionId, coverId))!).equals(PNG_1PX)).toBe(true);
    expect(readFileSync((await sessions.thumbnailFile(analysis.sessionId, pageId(analysis, 'kit/report.htm')))!).equals(WEBP)).toBe(true);
  });

  it('keeps pages pending without a desktop and isolates one failed page', async () => {
    render.mockResolvedValue({ ok: false, code: 'desktop-unavailable', error: 'offline' });
    const offline = await analyse();
    await sessions.whenIdle(offline.sessionId);
    expect((await sessions.get(offline.sessionId)).pages.every((p) => p.thumbnail.status === 'pending')).toBe(true);
    expect(render).toHaveBeenCalledTimes(1);
    expect(await sessions.thumbnailFile(offline.sessionId, offline.pages[0]!.id)).toBeNull();

    render.mockReset()
      .mockResolvedValueOnce({ ok: false, code: 'THUMBNAIL_RENDER_FAILED', error: 'boom' })
      .mockResolvedValue(WEBP);
    const mixed = await analyse();
    await sessions.whenIdle(mixed.sessionId);
    expect((await sessions.get(mixed.sessionId)).pages.map((p) => p.thumbnail.status)).toEqual(['failed', 'ready', 'ready']);
  });

  it.each([
    ['no PROMPT.md', kitTemplateEntries().slice(1)],
    ['no html', [{ name: 'PROMPT.md', body: 'x' }, { name: 'a.css', body: 'x' }]],
    ['traversal', [...kitTemplateEntries(), { name: '../evil.html', body: 'x' }]],
    ['bad extension', [...kitTemplateEntries(), { name: 'run.exe', body: 'MZ' }]],
  ])('rejects %s with 400 and leaves no session behind', async (_label, entries) => {
    await expectStatus(analyse(entries as { name: string; body: string }[]), 400);
    expect(existsSync(uploadsDir()) ? readdirSync(uploadsDir()) : []).toEqual([]);
  });

  it('rejects a corrupt zip with 400', async () => {
    await expectStatus(sessions.analyse({ zip: Buffer.from('not a zip'), originalFileName: 'x.zip' }), 400);
  });
});

describe('design template upload finalize', () => {
  it('registers a report with the chosen name and cover image; rename keeps the type', async () => {
    render.mockImplementation(async (url: string) => (url.endsWith('report.htm') ? PNG_1PX : WEBP));
    const analysis = await analyse();
    await sessions.whenIdle(analysis.sessionId);
    const result = await sessions.finalize(analysis.sessionId, {
      type: 'report', name: '  Board Report  ', coverPageId: pageId(analysis, 'kit/report.htm'),
    });
    expect(result.id).toBe('user-board-report');
    expect(result.manifest).toMatchObject({
      type: 'report', name: 'Board Report', cover: 'kit/report.htm',
      thumbnail: { status: 'ready', source: 'rendered' },
    });
    expect(result.manifest.pages.map((p) => p.file)).toEqual(['kit/cover.html', 'kit/report.htm', 'kit/nested/detail.html']);
    expect(readFileSync(path.join(result.dir, 'thumbnails/cover.png')).equals(PNG_1PX)).toBe(true);
    expect(existsSync(path.join(result.dir, 'pages/kit/nested/detail.html'))).toBe(true);
    const skillMd = readFileSync(path.join(result.dir, 'SKILL.md'), 'utf8');
    expect(skillMd).toContain('hubType: report');
    expect(skillMd).toContain('entry: "pages/kit/report.htm"');
    expect(skillMd).toContain('KIT_PROMPT_MARKER_902');
    expect(skillMd).not.toMatch(/\bslides?\b|\bdeck\b/i);
    expect(existsSync(path.join(uploadsDir(), analysis.sessionId))).toBe(false);
    expect((await listSkills([root])).map((s) => s.id)).toEqual(['user-board-report']);
    expect(requestTemplateThumbnails).not.toHaveBeenCalled();

    await renameUserDesignTemplate(result.dir, result.manifest, 'Annual Report');
    expect(JSON.parse(readFileSync(path.join(result.dir, 'import.json'), 'utf8'))).toMatchObject({ type: 'report', name: 'Annual Report' });
    expect(readFileSync(path.join(result.dir, 'SKILL.md'), 'utf8')).toContain('hubType: report');
  });

  it('maps a website to prototype mode and website hub type', async () => {
    const analysis = await analyse();
    await sessions.whenIdle(analysis.sessionId);
    const result = await sessions.finalize(analysis.sessionId, {
      type: 'website', name: 'Kit Site', coverPageId: analysis.suggestedCoverPageId,
    });
    const skillMd = readFileSync(path.join(result.dir, 'SKILL.md'), 'utf8');
    expect(skillMd).toContain('mode: prototype');
    expect(skillMd).toContain('hubType: website');
    expect(result.manifest.type).toBe('website');
    const [listed] = await listSkills([root]);
    expect(listed).toMatchObject({ id: 'user-kit-site', mode: 'prototype' });
  });

  it('does not reuse the zip thumbnail when another cover is chosen', async () => {
    render.mockResolvedValue({ ok: false, code: 'desktop-unavailable', error: 'offline' });
    const analysis = await analyse([...kitTemplateEntries(), { name: 'thumbnail.png', body: PNG_1PX }]);
    await sessions.whenIdle(analysis.sessionId);
    const result = await sessions.finalize(analysis.sessionId, {
      type: 'deck', name: 'Kit Deck', coverPageId: pageId(analysis, 'kit/nested/detail.html'),
    });
    expect(result.manifest).toMatchObject({ type: 'deck', cover: 'kit/nested/detail.html', thumbnail: { status: 'pending' } });
    expect(existsSync(path.join(result.dir, 'thumbnails'))).toBe(false);
    expect(requestTemplateThumbnails).toHaveBeenCalledWith({ templateDir: result.dir, id: result.id });
  });

  it('validates type, name length and cover membership', async () => {
    const analysis = await analyse();
    const cover = analysis.suggestedCoverPageId;
    await expectStatus(sessions.finalize(analysis.sessionId, { type: 'slides', name: 'x', coverPageId: cover }), 400);
    await expectStatus(sessions.finalize(analysis.sessionId, { type: 'deck', name: '   ', coverPageId: cover }), 400);
    await expectStatus(sessions.finalize(analysis.sessionId, { type: 'deck', name: 'a'.repeat(121), coverPageId: cover }), 400);
    await expectStatus(sessions.finalize(analysis.sessionId, { type: 'deck', name: 'x', coverPageId: 'kit/cover.html' }), 400);
    await expectStatus(sessions.finalize('f'.repeat(32), { type: 'deck', name: 'x', coverPageId: cover }), 404);
    const ok = await sessions.finalize(analysis.sessionId, { type: 'deck', name: 'a'.repeat(120), coverPageId: cover });
    expect(ok.manifest.name).toHaveLength(120);
  });

  it('is idempotent for the same selection, serialises concurrent calls and 409s a different one', async () => {
    const analysis = await analyse();
    const body = { type: 'deck', name: 'Once', coverPageId: analysis.suggestedCoverPageId };
    const [a, b] = await Promise.all([sessions.finalize(analysis.sessionId, body), sessions.finalize(analysis.sessionId, body)]);
    const c = await sessions.finalize(analysis.sessionId, { ...body });
    expect(a.id).toBe('user-once');
    expect(b.id).toBe(a.id);
    expect(c.id).toBe(a.id);
    expect((await listSkills([root])).map((s) => s.id)).toEqual(['user-once']);
    await expectStatus(sessions.finalize(analysis.sessionId, { ...body, name: 'Other' }), 409);
    await sessions.cancel(analysis.sessionId);
    expect(existsSync(a.dir)).toBe(true);
  });

  it('settles an in-flight render before moving the session into place', async () => {
    let release!: (value: Buffer) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    render.mockImplementation(() => { entered(); return new Promise<Buffer>((resolve) => { release = resolve; }); });
    const analysis = await analyse();
    await started;
    const finalizing = sessions.finalize(analysis.sessionId, {
      type: 'deck', name: 'Raced', coverPageId: analysis.suggestedCoverPageId,
    });
    release(WEBP);
    const result = await finalizing;
    await sessions.whenIdle(analysis.sessionId);
    expect(render).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(uploadsDir(), analysis.sessionId))).toBe(false);
    expect(existsSync(result.dir)).toBe(true);
  });
});

describe('design template upload lifecycle', () => {
  it('cancel removes the session, is repeatable, and a late render does not resurrect it', async () => {
    let release!: (value: Buffer) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    render.mockImplementation(() => { entered(); return new Promise<Buffer>((resolve) => { release = resolve; }); });
    const analysis = await analyse();
    await started;
    const cancelling = sessions.cancel(analysis.sessionId);
    release(WEBP);
    await cancelling;
    await sessions.whenIdle(analysis.sessionId);
    expect(existsSync(path.join(uploadsDir(), analysis.sessionId))).toBe(false);
    await expectStatus(sessions.get(analysis.sessionId), 404);
    await expect(sessions.cancel(analysis.sessionId)).resolves.toBeUndefined();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('expires sessions after 60 minutes and sweeps them from disk', async () => {
    const analysis = await analyse();
    await sessions.whenIdle(analysis.sessionId);
    clock += 59 * 60_000;
    await expect(sessions.get(analysis.sessionId)).resolves.toMatchObject({ sessionId: analysis.sessionId });
    clock += 2 * 60_000;
    await expectStatus(sessions.get(analysis.sessionId), 404);
    await sessions.sweepExpired();
    expect(existsSync(path.join(uploadsDir(), analysis.sessionId))).toBe(false);
  });

  it('a restarted daemon rehydrates live sessions and its startup sweep removes expired ones', async () => {
    const live = await analyse();
    await sessions.whenIdle(live.sessionId);
    clock += 30 * 60_000;
    const stale = await analyse();
    await sessions.whenIdle(stale.sessionId);
    sessions.dispose();

    clock += 45 * 60_000; // live is 75 minutes old, stale 45 minutes
    const restarted = new DesignTemplateUploadSessions({ root, now: () => clock });
    try {
      await restarted.sweepExpired();
      expect(existsSync(path.join(uploadsDir(), live.sessionId))).toBe(false);
      const rehydrated = await restarted.get(stale.sessionId);
      expect(rehydrated.pages.map((p) => p.file)).toEqual(stale.pages.map((p) => p.file));
      const result = await restarted.finalize(stale.sessionId, {
        type: 'deck', name: 'After Restart', coverPageId: stale.suggestedCoverPageId,
      });
      expect(result.id).toBe('user-after-restart');
    } finally {
      restarted.dispose();
    }
  });
});
