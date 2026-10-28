// Bundle uploads: one ZIP of template ZIPs becomes one parent bundle plus one
// child session per valid inner template; children reuse the single-session
// finalize/cancel machinery, share a sliding 60-minute expiry and render
// thumbnails only while focused. Also covers deterministic type detection on
// every upload path.
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DesignTemplateUploadAnalyseResponse,
  DesignTemplateUploadAnalysisResponse,
  DesignTemplateUploadBundleAnalysisResponse,
} from '@readable-studio/contracts';

vi.mock('../src/design-template-thumbnails.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/design-template-thumbnails.js')>()),
  requestTemplateThumbnails: vi.fn(async () => undefined),
}));

import { configureTemplateThumbnails } from '../src/design-template-thumbnails.js';
import { DesignTemplateImportError, importDesignTemplateZip } from '../src/design-template-import.js';
import { registerDesignTemplateUploadRoutes } from '../src/design-template-upload-routes.js';
import { DesignTemplateUploadSessions } from '../src/design-template-uploads.js';
import { invalidateSkillListCache, listSkills } from '../src/skills.js';
import {
  buildBundleZip,
  buildTemplateZip,
  buildZip,
  kitTemplateEntries,
  validTemplateEntries,
  type ZipEntryInput,
} from './helpers/template-zip.js';

const WEBP = Buffer.from('524946460400000057454250', 'hex');
const ORIGIN = 'http://127.0.0.1:12345';
const MINUTE = 60_000;
let root: string;
let clock: number;
let sessions: DesignTemplateUploadSessions;
const render = vi.fn();

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'rs-template-bundles-'));
  clock = Date.parse('2026-10-28T00:00:00.000Z');
  render.mockReset().mockResolvedValue(WEBP);
  configureTemplateThumbnails({ root, origin: () => ORIGIN, render, ready: async () => true });
  sessions = new DesignTemplateUploadSessions({ root, now: () => clock });
});
afterEach(async () => {
  sessions.dispose();
  invalidateSkillListCache();
  rmSync(root, { recursive: true, force: true });
});

const uploadsDir = () => path.join(root, '.uploads');
const uploadDirs = () => (existsSync(uploadsDir()) ? readdirSync(uploadsDir()) : []);
const deck = () => validTemplateEntries();
const report = () => kitTemplateEntries();
const broken = () => kitTemplateEntries().slice(1);

async function analyseBundle(templates: { name: string; entries: ZipEntryInput[] }[], originalFileName = 'pack.zip') {
  const result = await sessions.analyse({ zip: buildBundleZip(templates), originalFileName });
  if (result.kind !== 'bundle') throw new Error(`expected a bundle response, got ${result.kind}`);
  return result;
}
const okAnalyses = (bundle: DesignTemplateUploadBundleAnalysisResponse) =>
  bundle.templates.flatMap((item) => (item.ok ? [item.analysis] : []));

async function rejection(promise: Promise<unknown>, status: number): Promise<string> {
  const err = await promise.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(DesignTemplateImportError);
  expect((err as DesignTemplateImportError).status).toBe(status);
  return (err as Error).message;
}

describe('single analyse detection', () => {
  it('answers kind single with the detected type', async () => {
    const analysis = await sessions.analyse({ zip: buildTemplateZip(report()), originalFileName: 'kit.zip' }) as DesignTemplateUploadAnalysisResponse;
    expect(analysis.kind).toBe('single');
    expect(analysis.detectedType).toBe('report');
    expect(analysis.detection).toMatchObject({ type: 'report' });
    expect(analysis.bundleId).toBeUndefined();
    expect(await sessions.get(analysis.sessionId)).toMatchObject({ kind: 'single', detectedType: 'report' });
  });

  it('finalize without a type registers the detected type; null counts as omitted', async () => {
    const kit = await sessions.analyse({ zip: buildTemplateZip(report()), originalFileName: 'kit.zip' }) as DesignTemplateUploadAnalysisResponse;
    const quarterly = await sessions.analyse({ zip: buildTemplateZip(deck()), originalFileName: 'q.zip' }) as DesignTemplateUploadAnalysisResponse;
    const a = await sessions.finalize(kit.sessionId, { name: 'Kit', coverPageId: kit.suggestedCoverPageId });
    const b = await sessions.finalize(quarterly.sessionId, { type: null, name: 'Quarterly', coverPageId: quarterly.suggestedCoverPageId });
    expect(a.manifest.type).toBe('report');
    expect(readFileSync(path.join(a.dir, 'SKILL.md'), 'utf8')).toContain('hubType: report');
    expect(b.manifest.type).toBe('deck');
  });

  it('an explicit type overrides the detection', async () => {
    const kit = await sessions.analyse({ zip: buildTemplateZip(report()), originalFileName: 'kit.zip' }) as DesignTemplateUploadAnalysisResponse;
    const result = await sessions.finalize(kit.sessionId, { type: 'deck', name: 'Kit Deck', coverPageId: kit.suggestedCoverPageId });
    expect(result.manifest.type).toBe('deck');
  });

  it('rejects website and unknown types with 400, also on the replay path', async () => {
    const kit = await sessions.analyse({ zip: buildTemplateZip(report()), originalFileName: 'kit.zip' }) as DesignTemplateUploadAnalysisResponse;
    const selection = { name: 'Kit', coverPageId: kit.suggestedCoverPageId };
    expect(await rejection(sessions.finalize(kit.sessionId, { ...selection, type: 'website' }), 400))
      .toBe('website templates can no longer be uploaded; use deck or report');
    expect(await rejection(sessions.finalize(kit.sessionId, { ...selection, type: 'slides' }), 400)).toBe('type must be deck or report');
    await sessions.finalize(kit.sessionId, selection);
    expect(await rejection(sessions.finalize(kit.sessionId, { ...selection, type: 'website' }), 400))
      .toBe('website templates can no longer be uploaded; use deck or report');
  });

  it('keys idempotency on the resolved type: omit-then-explicit is a replay, another type 409s', async () => {
    const kit = await sessions.analyse({ zip: buildTemplateZip(report()), originalFileName: 'kit.zip' }) as DesignTemplateUploadAnalysisResponse;
    const selection = { name: 'Kit', coverPageId: kit.suggestedCoverPageId };
    const first = await sessions.finalize(kit.sessionId, selection);
    const replay = await sessions.finalize(kit.sessionId, { ...selection, type: 'report' });
    const omitted = await sessions.finalize(kit.sessionId, selection);
    expect(replay.id).toBe(first.id);
    expect(omitted.id).toBe(first.id);
    await rejection(sessions.finalize(kit.sessionId, { ...selection, type: 'deck' }), 409);
    expect((await listSkills([root])).map((s) => s.id)).toEqual([first.id]);
  });

  it('lazily detects a pre-1.3.9 session on rehydrate and stores it without a schema bump', async () => {
    const kit = await sessions.analyse({ zip: buildTemplateZip(report()), originalFileName: 'kit.zip' }) as DesignTemplateUploadAnalysisResponse;
    await sessions.whenIdle(kit.sessionId);
    sessions.dispose();
    const metaPath = path.join(uploadsDir(), kit.sessionId, 'session.json');
    const { detection: _detection, ...legacy } = JSON.parse(readFileSync(metaPath, 'utf8'));
    writeFileSync(metaPath, JSON.stringify(legacy));

    const restarted = new DesignTemplateUploadSessions({ root, now: () => clock });
    try {
      expect(await restarted.get(kit.sessionId)).toMatchObject({ kind: 'single', detectedType: 'report', detection: { type: 'report' } });
      const stored = JSON.parse(readFileSync(metaPath, 'utf8'));
      expect(stored).toMatchObject({ schemaVersion: 1, detection: { type: 'report' } });
      const result = await restarted.finalize(kit.sessionId, { name: 'Legacy', coverPageId: kit.suggestedCoverPageId });
      expect(result.manifest.type).toBe('report');
    } finally {
      restarted.dispose();
    }
  });
});

describe('bundle analyse', () => {
  it('creates one child session per valid inner template, in code-unit order, with per-item failures', async () => {
    const bundle = await analyseBundle([
      { name: 'b-report.zip', entries: report() },
      { name: 'c-broken.zip', entries: broken() },
      { name: 'a-deck.zip', entries: deck() },
    ]);
    expect(bundle.bundleId).toMatch(/^[a-f0-9]{32}$/);
    expect(bundle.originalFileName).toBe('pack.zip');
    expect(bundle.expiresAt).toBe(new Date(clock + 60 * MINUTE).toISOString());
    expect(bundle.templates.map((t) => [t.index, t.entryName, t.ok])).toEqual([
      [0, 'a-deck.zip', true], [1, 'b-report.zip', true], [2, 'c-broken.zip', false],
    ]);
    expect(bundle.templates[2]).toEqual({ index: 2, entryName: 'c-broken.zip', ok: false, reason: 'template zip must contain PROMPT.md at its root' });

    const [a, b] = okAnalyses(bundle);
    expect(a).toMatchObject({
      kind: 'single', bundleId: bundle.bundleId, originalFileName: 'a-deck.zip', suggestedName: 'Quarterly Review',
      detectedType: 'deck', detection: { type: 'deck' }, expiresAt: bundle.expiresAt,
    });
    expect(b).toMatchObject({ kind: 'single', bundleId: bundle.bundleId, originalFileName: 'b-report.zip', detectedType: 'report' });
    expect(new Set([a!.sessionId, b!.sessionId, bundle.bundleId]).size).toBe(3);
    expect(a!.pages[0]!.previewUrl).toBe(`/api/design-template-uploads/${a!.sessionId}/pages/two-column.html`);

    expect(JSON.parse(readFileSync(path.join(uploadsDir(), bundle.bundleId, 'bundle.json'), 'utf8'))).toMatchObject({
      schemaVersion: 1, bundleId: bundle.bundleId, originalFileName: 'pack.zip',
      templates: [
        { index: 0, entryName: 'a-deck.zip', ok: true, sessionId: a!.sessionId },
        { index: 1, entryName: 'b-report.zip', ok: true, sessionId: b!.sessionId },
        { index: 2, entryName: 'c-broken.zip', ok: false, reason: 'template zip must contain PROMPT.md at its root' },
      ],
    });
    expect(JSON.parse(readFileSync(path.join(uploadsDir(), b!.sessionId, 'session.json'), 'utf8')))
      .toMatchObject({ schemaVersion: 1, bundleId: bundle.bundleId, detection: { type: 'report' } });
    expect(await sessions.get(b!.sessionId)).toMatchObject({ kind: 'single', bundleId: bundle.bundleId, detectedType: 'report' });
    expect(await listSkills([root])).toEqual([]);
  });

  it('fails a nested inner bundle as one item and keeps the others', async () => {
    const bundle = await analyseBundle([
      { name: 'deck.zip', entries: deck() },
      { name: 'nested.zip', entries: [...report(), { name: 'inner.zip', body: buildZip(deck()) }] },
    ]);
    expect(bundle.templates.map((t) => (t.ok ? 'ok' : t.reason))).toEqual(['ok', 'nested bundles are not supported']);
  });

  it.each([
    ['mixed with loose files', () => buildBundleZip([{ name: 'a.zip', entries: deck() }], { extra: [{ name: 'README.md', body: 'x' }] }), /mixes template zips with other files: README\.md$/],
    ['a zip inside a folder', () => buildBundleZip([{ name: 'a.zip', entries: deck() }], { extra: [{ name: 'x/b.zip', body: buildZip(deck()) }] }), /inside folders are not supported.*: x\/b\.zip$/],
    ['more than 20 templates', () => buildBundleZip(Array.from({ length: 21 }, (_, i) => ({ name: `t${i}.zip`, entries: deck() }))), /^bundle contains 21 templates; the limit is 20$/],
    ['more than 200 entries', () => buildBundleZip([{ name: 'a.zip', entries: deck() }], { extra: Array.from({ length: 200 }, (_, i) => ({ name: `__MACOSX/._${i}`, body: 'x' })) }), /^bundle archive has too many entries \(201 > 200\)$/],
  ])('rejects a bundle %s with 400 and leaves nothing behind', async (_label, zip, message) => {
    expect(await rejection(sessions.analyse({ zip: zip(), originalFileName: 'pack.zip' }), 400)).toMatch(message);
    expect(uploadDirs()).toEqual([]);
  });

  it('rejects a bundle without valid templates, listing at most five reasons, and removes every dir', async () => {
    const message = await rejection(sessions.analyse({
      zip: buildBundleZip(['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ({ name: `${n}.zip`, entries: broken() }))),
      originalFileName: 'pack.zip',
    }), 400);
    const reason = 'template zip must contain PROMPT.md at its root';
    expect(message).toBe(`bundle contains no valid templates: ${['a', 'b', 'c', 'd', 'e'].map((n) => `${n}.zip: ${reason}`).join('; ')}; …`);
    expect(uploadDirs()).toEqual([]);
  });

  it('shares one budget across inner templates and fails every item after it runs out', async () => {
    const files = (n: number): ZipEntryInput[] => Array.from({ length: n }, (_, i) => ({ name: `f/${i}.txt`, body: 'x', method: 0 }));
    const bundle = await analyseBundle([
      { name: 'a.zip', entries: files(5000) }, // no PROMPT.md: fails, yet its 5000 files are charged
      { name: 'b.zip', entries: deck() },
      { name: 'c.zip', entries: files(5000) }, // runs out of the 10,000-file allowance
      { name: 'd.zip', entries: deck() },
    ]);
    const exhausted = 'bundle exceeds the combined limit of 200 MiB / 10,000 files';
    expect(bundle.templates.map((t) => (t.ok ? 'ok' : t.reason))).toEqual([
      'template zip must contain PROMPT.md at its root', 'ok', exhausted, exhausted,
    ]);
  });

  it('gives two same-named templates distinct ids', async () => {
    const bundle = await analyseBundle([{ name: 'one.zip', entries: deck() }, { name: 'two.zip', entries: deck() }]);
    const [a, b] = okAnalyses(bundle);
    const results = await Promise.all([a!, b!].map((child) =>
      sessions.finalize(child.sessionId, { name: child.suggestedName, coverPageId: child.suggestedCoverPageId })));
    expect(results.map((r) => r.id).sort()).toEqual(['user-quarterly-review', 'user-quarterly-review-2']);
    expect(results.every((r) => existsSync(path.join(r.dir, 'SKILL.md')))).toBe(true);
  });
});

describe('bundle children', () => {
  it('finalize without a type uses each child detection', async () => {
    const bundle = await analyseBundle([{ name: 'deck.zip', entries: deck() }, { name: 'report.zip', entries: report() }]);
    const [a, b] = okAnalyses(bundle);
    const deckResult = await sessions.finalize(a!.sessionId, { name: 'D', coverPageId: a!.suggestedCoverPageId });
    const reportResult = await sessions.finalize(b!.sessionId, { name: 'R', coverPageId: b!.suggestedCoverPageId });
    expect([deckResult.manifest.type, reportResult.manifest.type]).toEqual(['deck', 'report']);
    expect(deckResult.manifest.originalFileName).toBe('deck.zip');
  });

  it('cancel-all discards only unfinalized children and keeps finalized templates', async () => {
    const bundle = await analyseBundle([
      { name: 'a.zip', entries: deck() }, { name: 'b.zip', entries: report() }, { name: 'c.zip', entries: report() },
    ]);
    const [a, b, c] = okAnalyses(bundle);
    const saved = await sessions.finalize(a!.sessionId, { name: 'Saved', coverPageId: a!.suggestedCoverPageId });
    expect(await sessions.cancelBundle(bundle.bundleId)).toEqual({ cancelledSessionIds: [b!.sessionId, c!.sessionId] });
    expect(existsSync(saved.dir)).toBe(true);
    expect(uploadDirs()).toEqual([]);
    await rejection(sessions.get(b!.sessionId), 404);
    expect(await sessions.cancelBundle(bundle.bundleId)).toEqual({ cancelledSessionIds: [] });
    expect(await sessions.cancelBundle('f'.repeat(32))).toEqual({ cancelledSessionIds: [] });
    expect(await sessions.cancelBundle('../x')).toEqual({ cancelledSessionIds: [] });
  });

  it('a single child cancel keeps the bundle and its other children', async () => {
    const bundle = await analyseBundle([{ name: 'a.zip', entries: deck() }, { name: 'b.zip', entries: report() }]);
    const [a, b] = okAnalyses(bundle);
    await sessions.cancel(a!.sessionId);
    await rejection(sessions.get(a!.sessionId), 404);
    expect(await sessions.get(b!.sessionId)).toMatchObject({ bundleId: bundle.bundleId });
    expect(await sessions.cancelBundle(bundle.bundleId)).toEqual({ cancelledSessionIds: [b!.sessionId] });
  });

  it('slides the bundle expiry on any child request and expires after 60 idle minutes', async () => {
    const bundle = await analyseBundle([{ name: 'a.zip', entries: deck() }, { name: 'b.zip', entries: report() }]);
    const [a, b] = okAnalyses(bundle);
    const bundleJson = () => JSON.parse(readFileSync(path.join(uploadsDir(), bundle.bundleId, 'bundle.json'), 'utf8'));

    clock += 50 * MINUTE;
    expect((await sessions.get(a!.sessionId)).expiresAt).toBe(new Date(clock + 60 * MINUTE).toISOString());
    expect(bundleJson().expiresAt).toBe(new Date(clock + 60 * MINUTE).toISOString());
    clock += 10_000; // a later touch within 60 s is not written back
    await sessions.thumbnailFile(b!.sessionId, b!.pages[0]!.id);
    expect(bundleJson().expiresAt).toBe(new Date(clock - 10_000 + 60 * MINUTE).toISOString());

    clock += 50 * MINUTE; // 100 minutes after analyse, 50 after the last touch
    expect(await sessions.get(b!.sessionId)).toMatchObject({ sessionId: b!.sessionId, expiresAt: new Date(clock + 60 * MINUTE).toISOString() });
    clock += 61 * MINUTE;
    await rejection(sessions.get(a!.sessionId), 404);
    await rejection(sessions.pagesDir(b!.sessionId), 404);
    await sessions.sweepExpired();
    expect(uploadDirs()).toEqual([]);
  });

  it('a restarted daemon keeps live bundles, rehydrates children with the bundle expiry and sweeps expired ones', async () => {
    const expired = await analyseBundle([{ name: 'a.zip', entries: deck() }]);
    clock += 30 * MINUTE;
    const alive = await analyseBundle([{ name: 'b.zip', entries: deck() }]);
    const [child] = okAnalyses(alive);
    sessions.dispose();

    clock += 40 * MINUTE; // `expired`: 70 minutes idle; `alive`: 40
    const restarted = new DesignTemplateUploadSessions({ root, now: () => clock });
    try {
      await restarted.sweepExpired();
      expect(uploadDirs().sort()).toEqual([alive.bundleId, child!.sessionId].sort());
      expect(await restarted.get(child!.sessionId)).toMatchObject({
        bundleId: alive.bundleId, detectedType: 'deck', expiresAt: new Date(clock + 60 * MINUTE).toISOString(),
      });
      expect(await restarted.cancelBundle(expired.bundleId)).toEqual({ cancelledSessionIds: [] });
      expect(await restarted.cancelBundle(alive.bundleId)).toEqual({ cancelledSessionIds: [child!.sessionId] });
      expect(uploadDirs()).toEqual([]);
    } finally {
      restarted.dispose();
    }
  });
});

describe('bundle thumbnail focus', () => {
  const pages = (marker: string): ZipEntryInput[] => [
    { name: 'PROMPT.md', body: `---\nname: ${marker}\n---\nx` },
    { name: 'p1.html', body: `<!doctype html><h1>${marker} 1</h1>` },
    { name: 'p2.html', body: `<!doctype html><h1>${marker} 2</h1>` },
    { name: 'p3.html', body: `<!doctype html><h1>${marker} 3</h1>` },
  ];
  const renderedSessions = () => render.mock.calls.map((call) => /uploads\/([a-f0-9]{32})\/pages\/(p\d)/.exec(call[0] as string)!.slice(1).join(':'));

  it('renders only the focused child; a moved focus stops the previous one after its in-flight page', async () => {
    let release!: (image: Buffer) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    render.mockImplementationOnce(() => { entered(); return new Promise<Buffer>((resolve) => { release = resolve; }); });
    const bundle = await analyseBundle([
      { name: 'a.zip', entries: pages('A') }, { name: 'b.zip', entries: pages('B') }, { name: 'c.zip', entries: pages('C') },
    ]);
    const [a, b, c] = okAnalyses(bundle);
    await started;
    expect(renderedSessions()).toEqual([`${a!.sessionId}:p1`]);

    await sessions.get(b!.sessionId); // focus moves to b while a's first page is in flight
    await sessions.whenIdle(b!.sessionId);
    release(WEBP);
    await sessions.whenIdle(a!.sessionId);
    expect(renderedSessions()).toEqual([
      `${a!.sessionId}:p1`, `${b!.sessionId}:p1`, `${b!.sessionId}:p2`, `${b!.sessionId}:p3`,
    ]);
    expect((await sessions.thumbnailFile(a!.sessionId, a!.pages[0]!.id))).not.toBeNull();
    expect((await sessions.thumbnailFile(a!.sessionId, a!.pages[1]!.id))).toBeNull();
    expect((await sessions.pagesDir(c!.sessionId))).toBeTruthy(); // pages/thumbnails requests do not move focus
    await sessions.whenIdle(c!.sessionId);
    expect(renderedSessions()).toHaveLength(4);

    await sessions.get(a!.sessionId);
    await sessions.whenIdle(a!.sessionId);
    expect(renderedSessions().slice(4)).toEqual([`${a!.sessionId}:p2`, `${a!.sessionId}:p3`]);
  });

  it('a finalized or cancelled focused child leaves the others idle until requested', async () => {
    const bundle = await analyseBundle([{ name: 'a.zip', entries: pages('A') }, { name: 'b.zip', entries: pages('B') }]);
    const [a, b] = okAnalyses(bundle);
    await sessions.whenIdle(a!.sessionId);
    await sessions.finalize(a!.sessionId, { name: 'A', coverPageId: a!.suggestedCoverPageId });
    await sessions.whenIdle(b!.sessionId);
    expect(renderedSessions().every((entry) => entry.startsWith(a!.sessionId))).toBe(true);
    await sessions.get(b!.sessionId);
    await sessions.whenIdle(b!.sessionId);
    expect(renderedSessions().filter((entry) => entry.startsWith(b!.sessionId))).toHaveLength(3);
  });
});

describe('one-shot import detection', () => {
  it('registers the detected type instead of always deck', async () => {
    const reportResult = await importDesignTemplateZip({ root, zip: buildTemplateZip(report()), originalFileName: 'kit.zip' });
    const deckResult = await importDesignTemplateZip({ root, zip: buildTemplateZip(deck()), originalFileName: 'deck.zip' });
    expect(reportResult.manifest.type).toBe('report');
    expect(readFileSync(path.join(reportResult.dir, 'SKILL.md'), 'utf8')).toContain('hubType: report');
    expect(deckResult.manifest.type).toBe('deck');
  });
});

describe('analyse route abort', () => {
  type Handler = (req: unknown, res: unknown, next?: () => void) => unknown;
  function analyseHandlers() {
    const routes = new Map<string, Handler[]>();
    const app = Object.fromEntries(['get', 'post', 'delete'].map((method) => [
      method, (route: string, ...handlers: Handler[]) => { routes.set(`${method.toUpperCase()} ${route}`, handlers); },
    ])) as unknown as Express;
    registerDesignTemplateUploadRoutes(app, {
      sessions,
      importUpload: { single: () => (req: { file?: unknown }, _res: unknown, done: () => void) => done() },
      requireLocalOrigin: () => true,
      sendApiError: (_res, _status, _code, message) => { throw new Error(message); },
      sendTemplateError: (_res, err) => { throw err; },
      userTemplateSummary: async () => undefined,
      mimeFor: () => 'text/html',
    });
    return routes.get('POST /api/design-template-uploads/analyse')!;
  }

  it('cancels the whole bundle when the client went away before the response', async () => {
    const upload = path.join(root, 'upload.bin');
    writeFileSync(upload, buildBundleZip([{ name: 'a.zip', entries: deck() }, { name: 'b.zip', entries: report() }]));
    const req = { file: { path: upload, originalname: 'pack.zip' } };
    const res = Object.assign(new EventEmitter(), { destroyed: true });
    const [, handle] = analyseHandlers();
    await handle!(req, res);
    expect(uploadDirs()).toEqual([]);
  });

  it('cancels the whole bundle when the response closes unfinished', async () => {
    const upload = path.join(root, 'upload.bin');
    writeFileSync(upload, buildBundleZip([{ name: 'a.zip', entries: deck() }, { name: 'b.zip', entries: report() }]));
    let body: DesignTemplateUploadAnalyseResponse | undefined;
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableFinished: false,
      status() { return this; },
      json(value: DesignTemplateUploadAnalyseResponse) { body = value; },
    });
    const [, handle] = analyseHandlers();
    await handle!({ file: { path: upload, originalname: 'pack.zip' } }, res);
    if (body?.kind !== 'bundle') throw new Error('expected a bundle response');
    expect(uploadDirs()).toHaveLength(3);
    const cancelBundle = vi.spyOn(sessions, 'cancelBundle');
    res.emit('close');
    expect(cancelBundle).toHaveBeenCalledWith(body.bundleId);
    await cancelBundle.mock.results[0]!.value;
    expect(uploadDirs()).toEqual([]);
  });
});
