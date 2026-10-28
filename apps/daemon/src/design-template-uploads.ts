// Upload-wizard sessions for user design templates. `analyse` validates and
// extracts a template ZIP (same parser as the one-shot import) into
// `<user templates root>/.uploads/<sessionId>/`, which the template listing
// never reads, detects its type (deck/report) and renders every HTML page in
// the background through the serial desktop renderer. A bundle ZIP (only
// template ZIPs at its top level) becomes a parent `.uploads/<bundleId>/`
// plus one child session per valid inner template; children share the
// bundle's sliding expiry and render thumbnails only while focused.
// `finalize` registers exactly one template with the chosen (or detected)
// type, name and cover by renaming the extracted folder into place;
// `cancel`, expiry (60 minutes) and the startup/periodic sweep remove the
// session. Session metadata lives in session.json (bundle.json for a bundle)
// so a restarted daemon can still finalize a live session; render, focus and
// lock state is in memory only.
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  DesignTemplateThumbnailState,
  DesignTemplateTypeDetection,
  DesignTemplateUploadAnalyseResponse,
  DesignTemplateUploadAnalysisResponse,
  DesignTemplateUploadBundleAnalysisResponse,
  UploadableDesignTemplateType,
} from '@readable-studio/contracts';
import { classifyDesignTemplate } from './design-template-classifier.js';
import {
  DesignTemplateImportError,
  LOCK_RETRY,
  createDesignTemplateBundleBudget,
  finalizeDesignTemplateDir,
  inspectDesignTemplateArchive,
  prepareDesignTemplateZip,
  readDesignTemplateBundleEntry,
  writePreparedTemplateFiles,
  type DesignTemplateBundleEntry,
  type ImportDesignTemplateZipResult,
  type PreparedDesignTemplate,
} from './design-template-import.js';
import { renderTemplatePageThumbnail } from './design-template-thumbnails.js';
import {
  DEFAULT_TEMPLATE_VIEWPORT,
  readTemplatePageViewport,
  readTemplatePageViewportWithSource,
  type SourcedTemplateViewport,
  type TemplateViewport,
} from './design-template-viewport.js';

export const UPLOAD_SESSION_TTL_MS = 60 * 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;
const SESSION_FILE = 'session.json';
const BUNDLE_FILE = 'bundle.json';
const SESSION_ID = /^[a-f0-9]{32}$/;
const MAX_NAME_LENGTH = 120;
const MAX_LISTED_BUNDLE_FAILURES = 5;
// bundle.json is rewritten only once the sliding expiry moved this far (a
// write throttle for the wizard's polling, not a timeout).
const BUNDLE_PERSIST_STEP_MS = 60_000;

type StoredThumbnail = DesignTemplateThumbnailState & { error?: string };

interface StoredPage {
  id: string;
  file: string;
  use?: string;
  viewport?: TemplateViewport;
  thumbnail: StoredThumbnail;
  /** Extension of thumbnails/<id>.<ext> once ready. */
  image?: 'png' | 'webp';
}

interface StoredSession {
  schemaVersion: 1;
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  originalFileName: string;
  sha256: string;
  promptFile: string;
  suggestedName: string;
  suggestedCoverPageId: string;
  pages: StoredPage[];
  /** Absent on sessions written before type detection; filled on rehydrate. */
  detection?: DesignTemplateTypeDetection;
  /** Parent bundle of a child session. */
  bundleId?: string;
}

type StoredBundleTemplate =
  | { index: number; entryName: string; ok: true; sessionId: string }
  | { index: number; entryName: string; ok: false; reason: string };

interface StoredBundle {
  schemaVersion: 1;
  bundleId: string;
  createdAt: string;
  /** Last persisted sliding expiry (may trail the in-memory one by < 60 s). */
  expiresAt: string;
  originalFileName: string;
  templates: StoredBundleTemplate[];
}

interface LiveSession {
  meta: StoredSession;
  dir: string;
  cancelled: boolean;
}

interface LiveBundle {
  meta: StoredBundle;
  /** Sliding expiry (ms); bumped by every request touching the bundle or a child. */
  expiresAt: number;
  /** The one child whose thumbnails render; the others wait until requested. */
  focused: string | null;
}

interface FinalizedSession {
  key: string;
  /** What an omitted `type` resolves to on a replay. */
  detectedType: UploadableDesignTemplateType;
  result: ImportDesignTemplateZipResult;
  expiresAt: number;
}

export interface DesignTemplateUploadSessionsOptions {
  /** User design-templates root; sessions live in `<root>/.uploads`. */
  root: string;
  now?: () => number;
  ttlMs?: number;
}

const notFound = () => new DesignTemplateImportError(404, 'NOT_FOUND', 'upload session not found or expired');
const bad = (message: string) => new DesignTemplateImportError(400, 'BAD_REQUEST', message);
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function uploadPreviewUrl(sessionId: string, file: string): string {
  return `/api/design-template-uploads/${sessionId}/pages/${file.split('/').map(encodeURIComponent).join('/')}`;
}

export class DesignTemplateUploadSessions {
  readonly uploadsRoot: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly live = new Map<string, LiveSession>();
  private readonly bundles = new Map<string, LiveBundle>();
  private readonly loading = new Map<string, Promise<LiveSession | null>>();
  private readonly creating = new Set<string>();
  /** Cancelled/finalized/expired session and bundle ids (with their expiry) that must never rehydrate. */
  private readonly closed = new Map<string, number>();
  private readonly finalized = new Map<string, FinalizedSession>();
  private readonly runners = new Map<string, Promise<void>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: DesignTemplateUploadSessionsOptions) {
    this.uploadsRoot = path.join(options.root, '.uploads');
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? UPLOAD_SESSION_TTL_MS;
  }

  /** Startup sweep plus a periodic one; the timer never keeps the process alive. */
  start(): void {
    void this.sweepExpired();
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweepExpired(); }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const session of this.live.values()) session.cancelled = true;
  }

  async analyse(input: { zip: Buffer; originalFileName: string }): Promise<DesignTemplateUploadAnalyseResponse> {
    const layout = inspectDesignTemplateArchive(input.zip);
    if (layout.kind === 'bundle') return this.analyseBundle(input, layout.entries);
    const session = await this.create(prepareDesignTemplateZip(input.zip, input.originalFileName), input.originalFileName);
    this.startRenderer(session);
    return this.toResponse(session.meta);
  }

  // Inner templates are read, validated and extracted strictly one at a time
  // against one shared budget; a failing one becomes an item reason.
  private async analyseBundle(
    input: { zip: Buffer; originalFileName: string },
    entries: DesignTemplateBundleEntry[],
  ): Promise<DesignTemplateUploadBundleAnalysisResponse> {
    const bundleId = randomBytes(16).toString('hex');
    const dir = path.join(this.uploadsRoot, bundleId);
    const budget = createDesignTemplateBundleBudget();
    const templates: StoredBundleTemplate[] = [];
    const children = new Map<string, LiveSession>();
    this.creating.add(bundleId);
    try {
      for (const entry of entries) {
        const { index, entryName } = entry;
        try {
          const fileName = path.posix.basename(entryName);
          // A spent budget fails the item before its inner zip is inflated.
          const inner = readDesignTemplateBundleEntry(input.zip, entry, budget);
          const prepared = prepareDesignTemplateZip(inner, fileName, { budget, nested: true });
          const child = await this.create(prepared, fileName, bundleId);
          children.set(child.meta.sessionId, child);
          templates.push({ index, entryName, ok: true, sessionId: child.meta.sessionId });
        } catch (err) {
          const reason = err instanceof DesignTemplateImportError ? err.message : `could not read template: ${messageOf(err)}`;
          templates.push({ index, entryName, ok: false, reason });
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (children.size === 0) {
        const failures = templates.map((t) => `${t.entryName}: ${t.ok ? '' : t.reason}`);
        const more = failures.length > MAX_LISTED_BUNDLE_FAILURES ? '; …' : '';
        throw bad(`bundle contains no valid templates: ${failures.slice(0, MAX_LISTED_BUNDLE_FAILURES).join('; ')}${more}`);
      }
      const now = this.now();
      const meta: StoredBundle = {
        schemaVersion: 1,
        bundleId,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.ttlMs).toISOString(),
        originalFileName: input.originalFileName,
        templates,
      };
      await mkdir(dir, { recursive: true });
      await this.persistBundle(meta);
      this.bundles.set(bundleId, { meta, expiresAt: now + this.ttlMs, focused: null });
      const [first] = children.values();
      this.focus(first!);
      return {
        kind: 'bundle',
        bundleId,
        expiresAt: meta.expiresAt,
        originalFileName: meta.originalFileName,
        templates: templates.map((item) => (item.ok
          ? { index: item.index, entryName: item.entryName, ok: true as const, analysis: this.toResponse(children.get(item.sessionId)!.meta) }
          : item)),
      };
    } catch (err) {
      for (const id of children.keys()) await this.discard(id);
      await rm(dir, { recursive: true, force: true });
      throw err;
    } finally {
      this.creating.delete(bundleId);
    }
  }

  // Extracts one prepared template into a new session dir and detects its
  // type. The caller decides when its renderer starts.
  private async create(prepared: PreparedDesignTemplate, originalFileName: string, bundleId?: string): Promise<LiveSession> {
    const sessionId = randomBytes(16).toString('hex');
    const dir = path.join(this.uploadsRoot, sessionId);
    const created = this.now();
    const pages: StoredPage[] = prepared.pages.map((page, index) => ({
      id: `page-${index + 1}`,
      file: page.file,
      ...(page.use ? { use: page.use } : {}),
      thumbnail: { status: 'pending', source: null, updatedAt: new Date(created).toISOString() },
    }));
    const cover = pages.find((page) => page.file === prepared.suggestedCover)!;
    const meta: StoredSession = {
      schemaVersion: 1,
      sessionId,
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + this.ttlMs).toISOString(),
      originalFileName,
      sha256: prepared.sha256,
      promptFile: prepared.prompt.path,
      suggestedName: prepared.suggestedName,
      suggestedCoverPageId: cover.id,
      pages,
      ...(bundleId ? { bundleId } : {}),
    };
    this.creating.add(sessionId);
    try {
      await writePreparedTemplateFiles(path.join(dir, 'template'), prepared);
      const pagesDir = path.join(dir, 'template', 'pages');
      // One viewport parse per page feeds both the renderer and the classifier.
      const classified: { file: string; viewport: SourcedTemplateViewport }[] = [];
      for (const page of pages) {
        const viewport = await readTemplatePageViewportWithSource(pagesDir, page.file);
        page.viewport = { width: viewport.width, height: viewport.height };
        classified.push({ file: page.file, viewport });
      }
      meta.detection = await classifyDesignTemplate({ pagesDir, prompt: prepared.prompt.body.toString('utf8'), pages: classified });
      await mkdir(path.join(dir, 'thumbnails'), { recursive: true });
      // A ZIP thumbnail illustrates the suggested cover only; every other
      // page still gets its own rendered image.
      if (prepared.thumbnail) {
        const ext = path.extname(prepared.thumbnail.path).slice(1).toLowerCase() as 'png' | 'webp';
        await writeFile(path.join(dir, 'thumbnails', `${cover.id}.${ext}`), prepared.thumbnail.body);
        cover.image = ext;
        cover.thumbnail = { status: 'ready', source: 'zip', updatedAt: meta.createdAt };
      }
      await this.persist(dir, meta);
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    } finally {
      this.creating.delete(sessionId);
    }
    const session: LiveSession = { meta, dir, cancelled: false };
    this.live.set(sessionId, session);
    return session;
  }

  /** The session as the wizard sees it; a bundle child also becomes the one that renders. */
  async get(sessionId: string): Promise<DesignTemplateUploadAnalysisResponse> {
    const session = await this.session(sessionId);
    this.focus(session);
    return this.toResponse(session.meta);
  }

  async pagesDir(sessionId: string): Promise<string> {
    return path.join((await this.session(sessionId)).dir, 'template', 'pages');
  }

  /** Ready page image path, or null while pending/failed. 404 for unknown ids. */
  async thumbnailFile(sessionId: string, pageId: string): Promise<string | null> {
    const session = await this.session(sessionId);
    const page = session.meta.pages.find((p) => p.id === pageId);
    if (!page) throw new DesignTemplateImportError(404, 'NOT_FOUND', 'page not found');
    return page.thumbnail.status === 'ready' && page.image
      ? path.join(session.dir, 'thumbnails', `${page.id}.${page.image}`)
      : null;
  }

  /** Resolves once the session's background renders have settled. */
  async whenIdle(sessionId: string): Promise<void> {
    await this.runners.get(sessionId);
  }

  finalize(sessionId: string, body: unknown): Promise<ImportDesignTemplateZipResult> {
    if (!SESSION_ID.test(sessionId)) return Promise.reject(notFound());
    return this.withLock(sessionId, async () => {
      const request = body && typeof body === 'object' ? body as Record<string, unknown> : {};
      const requested = requestedType(request.type);
      const done = this.finalized.get(sessionId);
      if (done) {
        if (done.key === selectionKey(requested ?? done.detectedType, request)) return done.result;
        throw new DesignTemplateImportError(409, 'CONFLICT', 'upload session was already finalized with a different selection');
      }
      const session = await this.session(sessionId);
      const detectedType = session.meta.detection?.type ?? 'deck';
      const type = requested ?? detectedType;
      const { name, coverPageId } = validateSelection(request, session.meta);
      const coverPage = session.meta.pages.find((p) => p.id === coverPageId)!;

      // Settle the renderer before the folder moves so no late write lands
      // in (or recreates) the session directory.
      session.cancelled = true;
      await this.runners.get(sessionId);

      const templateDir = path.join(session.dir, 'template');
      let thumbnail: DesignTemplateThumbnailState = { status: 'pending', source: null, updatedAt: new Date(this.now()).toISOString() };
      let result: ImportDesignTemplateZipResult;
      try {
        if (coverPage.thumbnail.status === 'ready' && coverPage.image) {
          await mkdir(path.join(templateDir, 'thumbnails'), { recursive: true });
          await copyFile(
            path.join(session.dir, 'thumbnails', `${coverPage.id}.${coverPage.image}`),
            path.join(templateDir, 'thumbnails', `cover.${coverPage.image}`),
          );
          thumbnail = { status: 'ready', source: coverPage.thumbnail.source, updatedAt: thumbnail.updatedAt };
        }
        result = await finalizeDesignTemplateDir({
          root: this.options.root,
          stagingDir: templateDir,
          type,
          name,
          cover: coverPage.file,
          pages: session.meta.pages.map(({ file, use }) => (use ? { file, use } : { file })),
          originalFileName: session.meta.originalFileName,
          sha256: session.meta.sha256,
          thumbnail,
        });
      } catch (err) {
        // The lock that blocked the move (e.g. a scan of the copied cover) can
        // still hold thumbnails/; a throw here would mask err and skip the restart.
        await rm(path.join(templateDir, 'thumbnails'), { recursive: true, force: true, ...LOCK_RETRY });
        session.cancelled = false;
        this.startRenderer(session);
        if (err instanceof DesignTemplateImportError) throw err;
        throw new DesignTemplateImportError(500, 'INTERNAL_ERROR', `could not save template: ${messageOf(err)}`);
      }
      this.finalized.set(sessionId, { key: selectionKey(type, request), detectedType, result, expiresAt: this.expiryOf(session.meta) });
      this.close(session);
      await rm(session.dir, { recursive: true, force: true }).catch((err) => {
        console.warn(`[design-template-uploads] could not remove finalized session ${sessionId}`, err);
      });
      return result;
    });
  }

  /** Idempotent: unknown, expired and already finalized sessions succeed too. */
  async cancel(sessionId: string): Promise<void> {
    if (!SESSION_ID.test(sessionId)) return;
    await this.withLock(sessionId, () => this.discard(sessionId));
  }

  /**
   * Discards every child of a bundle that is still unfinalized, then the
   * bundle itself. Idempotent; finalized templates stay registered, and
   * unknown, malformed or expired ids report nothing cancelled.
   */
  async cancelBundle(bundleId: string): Promise<{ cancelledSessionIds: string[] }> {
    const bundle = await this.loadBundle(bundleId);
    if (!bundle) return { cancelledSessionIds: [] };
    const expired = bundle.expiresAt <= this.now();
    const cancelledSessionIds: string[] = [];
    for (const item of bundle.meta.templates) {
      if (!item.ok) continue;
      const { sessionId } = item;
      const discarded = await this.withLock(sessionId, async () => {
        if (this.closed.has(sessionId) || (!this.live.has(sessionId) && !(await this.readMeta(sessionId)))) return false;
        await this.discard(sessionId);
        return true;
      });
      if (discarded && !expired) cancelledSessionIds.push(sessionId);
    }
    this.bundles.delete(bundleId);
    this.closed.set(bundleId, Math.max(bundle.expiresAt, this.now()));
    await rm(path.join(this.uploadsRoot, bundleId), { recursive: true, force: true });
    return { cancelledSessionIds };
  }

  // Lock-free removal, also used for an expired session found inside a lock.
  private async discard(sessionId: string): Promise<void> {
    const session = this.live.get(sessionId);
    if (session) this.close(session);
    else this.closed.set(sessionId, this.now() + this.ttlMs);
    await this.runners.get(sessionId);
    await rm(path.join(this.uploadsRoot, sessionId), { recursive: true, force: true });
  }

  /** Removes expired sessions and bundles (memory and disk) and forgets stale bookkeeping. */
  async sweepExpired(): Promise<void> {
    const now = this.now();
    // Callers do not await the sweep, and an unhandled rejection is fatal to
    // the daemon: a dir still locked (EBUSY/EPERM) is retried next sweep.
    for (const [id, session] of this.live) {
      if (this.expiryOf(session.meta) <= now) {
        await this.cancel(id).catch((err) => {
          console.warn(`[design-template-uploads] could not remove expired session ${id}`, err);
        });
      }
    }
    for (const [id, entry] of this.finalized) if (entry.expiresAt <= now) this.finalized.delete(id);
    for (const [id, expiresAt] of this.closed) if (expiresAt <= now) this.closed.delete(id);
    let names: string[];
    try {
      names = await readdir(this.uploadsRoot);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[design-template-uploads] sweep failed', err);
      return;
    }
    for (const name of names) {
      if (this.live.has(name) || this.creating.has(name)) continue;
      if (await this.storedExpiry(name) > now) continue;
      this.bundles.delete(name);
      await rm(path.join(this.uploadsRoot, name), { recursive: true, force: true }).catch((err) => {
        console.warn(`[design-template-uploads] could not remove expired session ${name}`, err);
      });
    }
  }

  // Expiry of a session or bundle dir on disk: a child follows its bundle
  // while that exists; anything unreadable counts as expired.
  private async storedExpiry(id: string): Promise<number> {
    const meta = await this.readMeta(id);
    if (!meta) return (await this.loadBundle(id))?.expiresAt ?? 0;
    const bundle = meta.bundleId ? await this.loadBundle(meta.bundleId) : null;
    return bundle?.expiresAt ?? Date.parse(meta.expiresAt);
  }

  private async session(sessionId: string): Promise<LiveSession> {
    if (!SESSION_ID.test(sessionId) || this.closed.has(sessionId)) throw notFound();
    let session = this.live.get(sessionId) ?? null;
    if (!session) {
      let pending = this.loading.get(sessionId);
      if (!pending) {
        pending = this.rehydrate(sessionId).finally(() => this.loading.delete(sessionId));
        this.loading.set(sessionId, pending);
      }
      session = await pending;
    }
    if (!session) throw notFound();
    // A child lives as long as its bundle; without one, its own expiry applies.
    const bundle = session.meta.bundleId ? await this.loadBundle(session.meta.bundleId) : null;
    if ((bundle?.expiresAt ?? Date.parse(session.meta.expiresAt)) <= this.now()) {
      await this.discard(sessionId);
      throw notFound();
    }
    if (bundle) await this.touch(bundle);
    return session;
  }

  private async rehydrate(sessionId: string): Promise<LiveSession | null> {
    const meta = await this.readMeta(sessionId);
    if (!meta || this.closed.has(sessionId)) return null;
    const existing = this.live.get(sessionId);
    if (existing) return existing;
    const dir = path.join(this.uploadsRoot, sessionId);
    if (!meta.detection) {
      // Written before type detection: classify once and keep it (same schemaVersion).
      meta.detection = await classifyDesignTemplate({
        pagesDir: path.join(dir, 'template', 'pages'),
        prompt: await readFile(path.join(dir, 'template', 'PROMPT.md'), 'utf8').catch(() => ''),
        pages: meta.pages.map(({ file }) => ({ file })),
      });
      if (this.closed.has(sessionId)) return null;
      await this.persist(dir, meta);
    }
    const session: LiveSession = { meta, dir, cancelled: false };
    this.live.set(sessionId, session);
    // Bundle children render once the wizard requests them (focus).
    if (!meta.bundleId) this.startRenderer(session);
    return session;
  }

  private async readMeta(sessionId: string): Promise<StoredSession | null> {
    if (!SESSION_ID.test(sessionId)) return null;
    try {
      const parsed = JSON.parse(await readFile(path.join(this.uploadsRoot, sessionId, SESSION_FILE), 'utf8')) as StoredSession;
      return parsed?.schemaVersion === 1 && parsed.sessionId === sessionId && Array.isArray(parsed.pages) ? parsed : null;
    } catch {
      return null;
    }
  }

  // Live bundle state, read back from bundle.json after a restart. Null for
  // malformed, unknown or closed ids.
  private async loadBundle(bundleId: string): Promise<LiveBundle | null> {
    if (!SESSION_ID.test(bundleId) || this.closed.has(bundleId)) return null;
    const live = this.bundles.get(bundleId);
    if (live) return live;
    let meta: StoredBundle;
    try {
      meta = JSON.parse(await readFile(path.join(this.uploadsRoot, bundleId, BUNDLE_FILE), 'utf8')) as StoredBundle;
    } catch {
      return null;
    }
    if (meta?.schemaVersion !== 1 || meta.bundleId !== bundleId || !Array.isArray(meta.templates)) return null;
    if (this.closed.has(bundleId)) return null;
    const bundle = this.bundles.get(bundleId) ?? { meta, expiresAt: Date.parse(meta.expiresAt), focused: null };
    this.bundles.set(bundleId, bundle);
    return bundle;
  }

  // Slides the bundle expiry to now + TTL. bundle.json follows only once the
  // stored value would advance by BUNDLE_PERSIST_STEP_MS, so polling does not
  // rewrite it on every request.
  private async touch(bundle: LiveBundle): Promise<void> {
    const expiresAt = this.now() + this.ttlMs;
    if (expiresAt <= bundle.expiresAt) return;
    bundle.expiresAt = expiresAt;
    if (expiresAt - Date.parse(bundle.meta.expiresAt) < BUNDLE_PERSIST_STEP_MS) return;
    bundle.meta = { ...bundle.meta, expiresAt: new Date(expiresAt).toISOString() };
    await this.persistBundle(bundle.meta).catch((err) => {
      console.warn(`[design-template-uploads] could not extend bundle ${bundle.meta.bundleId}`, err);
    });
  }

  // Moves a bundle's rendering to this child: its renderer starts, and the
  // previously focused child stops after its in-flight page. So a bundle
  // never queues all N x pages at once. No-op for single sessions.
  private focus(session: LiveSession): void {
    const { bundleId, sessionId } = session.meta;
    const bundle = bundleId ? this.bundles.get(bundleId) : undefined;
    if (!bundle || bundle.focused === sessionId) return;
    bundle.focused = sessionId;
    this.startRenderer(session);
  }

  private mayRender(session: LiveSession): boolean {
    const { bundleId, sessionId } = session.meta;
    return !bundleId || this.bundles.get(bundleId)?.focused === sessionId;
  }

  private expiryOf(meta: StoredSession): number {
    const bundle = meta.bundleId ? this.bundles.get(meta.bundleId) : undefined;
    return bundle ? bundle.expiresAt : Date.parse(meta.expiresAt);
  }

  private close(session: LiveSession): void {
    const { bundleId, sessionId } = session.meta;
    const bundle = bundleId ? this.bundles.get(bundleId) : undefined;
    if (bundle?.focused === sessionId) bundle.focused = null;
    session.cancelled = true;
    this.live.delete(sessionId);
    this.closed.set(sessionId, Math.max(this.expiryOf(session.meta), this.now()));
  }

  private withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.then(() => undefined, () => undefined);
    this.locks.set(sessionId, settled);
    void settled.then(() => { if (this.locks.get(sessionId) === settled) this.locks.delete(sessionId); });
    return next;
  }

  private persist(dir: string, meta: StoredSession): Promise<void> {
    return writeFile(path.join(dir, SESSION_FILE), `${JSON.stringify(meta, null, 2)}\n`);
  }

  private persistBundle(meta: StoredBundle): Promise<void> {
    return writeFile(path.join(this.uploadsRoot, meta.bundleId, BUNDLE_FILE), `${JSON.stringify(meta, null, 2)}\n`);
  }

  // Renders pending pages one at a time through the shared serial renderer.
  // A missing desktop leaves the rest pending (the UI falls back to live
  // previews); a failed page is recorded and the next page still renders.
  // An unfocused bundle child stops before its next page.
  private startRenderer(session: LiveSession): void {
    const { sessionId } = session.meta;
    const run = async () => {
      for (const page of session.meta.pages) {
        if (session.cancelled || !this.mayRender(session)) return;
        if (page.thumbnail.status !== 'pending') continue;
        page.viewport ??= await readTemplatePageViewport(path.join(session.dir, 'template', 'pages'), page.file);
        const result = await renderTemplatePageThumbnail(uploadPreviewUrl(sessionId, page.file), page.viewport);
        if (session.cancelled || result.status === 'pending') return;
        const updatedAt = new Date(this.now()).toISOString();
        if (result.status === 'ready') {
          await writeFile(path.join(session.dir, 'thumbnails', `${page.id}.${result.ext}`), result.image);
          page.image = result.ext;
          page.thumbnail = { status: 'ready', source: 'rendered', updatedAt };
        } else {
          page.thumbnail = { status: 'failed', source: null, updatedAt, error: result.error };
        }
        await this.persist(session.dir, session.meta);
      }
    };
    const previous = this.runners.get(sessionId) ?? Promise.resolve();
    const runner = previous.then(run).catch((err) => {
      console.warn(`[design-template-uploads] page thumbnails failed for session ${sessionId}`, err);
    });
    this.runners.set(sessionId, runner);
    void runner.then(() => { if (this.runners.get(sessionId) === runner) this.runners.delete(sessionId); });
  }

  private toResponse(meta: StoredSession): DesignTemplateUploadAnalysisResponse {
    return {
      kind: 'single',
      sessionId: meta.sessionId,
      expiresAt: new Date(this.expiryOf(meta)).toISOString(),
      originalFileName: meta.originalFileName,
      prompt: { file: meta.promptFile },
      suggestedName: meta.suggestedName,
      suggestedCoverPageId: meta.suggestedCoverPageId,
      pages: meta.pages.map((page) => ({
        id: page.id,
        file: page.file,
        ...(page.use ? { use: page.use } : {}),
        viewport: page.viewport ?? DEFAULT_TEMPLATE_VIEWPORT,
        previewUrl: uploadPreviewUrl(meta.sessionId, page.file),
        thumbnailUrl: `/api/design-template-uploads/${meta.sessionId}/thumbnails/${page.id}`,
        thumbnail: { status: page.thumbnail.status, source: page.thumbnail.source, updatedAt: page.thumbnail.updatedAt },
      })),
      ...(meta.detection ? { detectedType: meta.detection.type, detection: meta.detection } : {}),
      ...(meta.bundleId ? { bundleId: meta.bundleId } : {}),
    };
  }
}

const isUploadableDesignTemplateType = (value: unknown): value is UploadableDesignTemplateType =>
  value === 'deck' || value === 'report';

// Finalize `type` is an optional override of the detection; website
// templates stay readable but can no longer be uploaded.
function requestedType(value: unknown): UploadableDesignTemplateType | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'website') throw bad('website templates can no longer be uploaded; use deck or report');
  if (!isUploadableDesignTemplateType(value)) throw bad('type must be deck or report');
  return value;
}

// Keyed on the resolved type, so omitting the type and later sending the
// detected one explicitly is the same selection.
function selectionKey(type: UploadableDesignTemplateType, request: Record<string, unknown>): string {
  return JSON.stringify([
    type,
    typeof request.name === 'string' ? request.name.trim() : request.name,
    request.coverPageId,
  ]);
}

function validateSelection(
  request: Record<string, unknown>,
  meta: StoredSession,
): { name: string; coverPageId: string } {
  const name = typeof request.name === 'string' ? request.name.trim() : '';
  if (!name) throw bad('name is required');
  if (name.length > MAX_NAME_LENGTH) throw bad('name is too long');
  const coverPageId = request.coverPageId;
  if (typeof coverPageId !== 'string' || !meta.pages.some((p) => p.id === coverPageId)) {
    throw bad('coverPageId must be one of the session pages');
  }
  return { name, coverPageId };
}
