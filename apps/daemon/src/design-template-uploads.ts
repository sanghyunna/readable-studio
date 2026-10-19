// Upload-wizard sessions for user design templates. `analyse` validates and
// extracts a template ZIP (same parser as the one-shot import) into
// `<user templates root>/.uploads/<sessionId>/`, which the template listing
// never reads, and renders every HTML page in the background through the
// serial desktop renderer. `finalize` registers exactly one template with the
// chosen type/name/cover by renaming the extracted folder into place;
// `cancel`, expiry (60 minutes) and the startup/periodic sweep remove the
// session. Session metadata lives in session.json so a restarted daemon can
// still finalize a live session; render/lock state is in memory only.
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  DesignTemplateThumbnailState,
  DesignTemplateType,
  DesignTemplateUploadAnalysisResponse,
} from '@readable-studio/contracts';
import {
  DesignTemplateImportError,
  finalizeDesignTemplateDir,
  isDesignTemplateType,
  prepareDesignTemplateZip,
  writePreparedTemplateFiles,
  type ImportDesignTemplateZipResult,
} from './design-template-import.js';
import { renderTemplatePageThumbnail } from './design-template-thumbnails.js';

export const UPLOAD_SESSION_TTL_MS = 60 * 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;
const SESSION_FILE = 'session.json';
const SESSION_ID = /^[a-f0-9]{32}$/;
const MAX_NAME_LENGTH = 120;

type StoredThumbnail = DesignTemplateThumbnailState & { error?: string };

interface StoredPage {
  id: string;
  file: string;
  use?: string;
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
}

interface LiveSession {
  meta: StoredSession;
  dir: string;
  cancelled: boolean;
}

interface FinalizedSession {
  key: string;
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

export function uploadPreviewUrl(sessionId: string, file: string): string {
  return `/api/design-template-uploads/${sessionId}/pages/${file.split('/').map(encodeURIComponent).join('/')}`;
}

export class DesignTemplateUploadSessions {
  readonly uploadsRoot: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly live = new Map<string, LiveSession>();
  private readonly loading = new Map<string, Promise<LiveSession | null>>();
  private readonly creating = new Set<string>();
  /** Cancelled/finalized/expired ids (with their expiry) that must never rehydrate. */
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

  async analyse(input: { zip: Buffer; originalFileName: string }): Promise<DesignTemplateUploadAnalysisResponse> {
    const prepared = prepareDesignTemplateZip(input.zip, input.originalFileName);
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
      originalFileName: input.originalFileName,
      sha256: prepared.sha256,
      promptFile: prepared.prompt.path,
      suggestedName: prepared.suggestedName,
      suggestedCoverPageId: cover.id,
      pages,
    };
    this.creating.add(sessionId);
    try {
      await writePreparedTemplateFiles(path.join(dir, 'template'), prepared);
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
    this.startRenderer(session);
    return this.toResponse(meta);
  }

  async get(sessionId: string): Promise<DesignTemplateUploadAnalysisResponse> {
    return this.toResponse((await this.session(sessionId)).meta);
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
      const done = this.finalized.get(sessionId);
      if (done) {
        if (done.key === selectionKey(request)) return done.result;
        throw new DesignTemplateImportError(409, 'CONFLICT', 'upload session was already finalized with a different selection');
      }
      const session = await this.session(sessionId);
      const { type, name, coverPageId } = validateSelection(request, session.meta);
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
        await rm(path.join(templateDir, 'thumbnails'), { recursive: true, force: true });
        session.cancelled = false;
        this.startRenderer(session);
        if (err instanceof DesignTemplateImportError) throw err;
        throw new DesignTemplateImportError(500, 'INTERNAL_ERROR', `could not save template: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.finalized.set(sessionId, { key: selectionKey(request), result, expiresAt: Date.parse(session.meta.expiresAt) });
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

  // Lock-free removal, also used for an expired session found inside a lock.
  private async discard(sessionId: string): Promise<void> {
    const session = this.live.get(sessionId);
    if (session) this.close(session);
    else this.closed.set(sessionId, this.now() + this.ttlMs);
    await this.runners.get(sessionId);
    await rm(path.join(this.uploadsRoot, sessionId), { recursive: true, force: true });
  }

  /** Removes expired sessions (memory and disk) and forgets stale bookkeeping. */
  async sweepExpired(): Promise<void> {
    const now = this.now();
    for (const [id, session] of this.live) {
      if (Date.parse(session.meta.expiresAt) <= now) await this.cancel(id);
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
      const meta = await this.readMeta(name);
      if (meta && Date.parse(meta.expiresAt) > now) continue;
      await rm(path.join(this.uploadsRoot, name), { recursive: true, force: true }).catch((err) => {
        console.warn(`[design-template-uploads] could not remove expired session ${name}`, err);
      });
    }
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
    if (Date.parse(session.meta.expiresAt) <= this.now()) {
      await this.discard(sessionId);
      throw notFound();
    }
    return session;
  }

  private async rehydrate(sessionId: string): Promise<LiveSession | null> {
    const meta = await this.readMeta(sessionId);
    if (!meta || this.closed.has(sessionId)) return null;
    const existing = this.live.get(sessionId);
    if (existing) return existing;
    const session: LiveSession = { meta, dir: path.join(this.uploadsRoot, sessionId), cancelled: false };
    this.live.set(sessionId, session);
    this.startRenderer(session);
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

  private close(session: LiveSession): void {
    session.cancelled = true;
    this.live.delete(session.meta.sessionId);
    this.closed.set(session.meta.sessionId, Math.max(Date.parse(session.meta.expiresAt), this.now()));
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

  // Renders pending pages one at a time through the shared serial renderer.
  // A missing desktop leaves the rest pending (the UI falls back to live
  // previews); a failed page is recorded and the next page still renders.
  private startRenderer(session: LiveSession): void {
    const { sessionId } = session.meta;
    const run = async () => {
      for (const page of session.meta.pages) {
        if (session.cancelled) return;
        if (page.thumbnail.status !== 'pending') continue;
        const result = await renderTemplatePageThumbnail(uploadPreviewUrl(sessionId, page.file));
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
      sessionId: meta.sessionId,
      expiresAt: meta.expiresAt,
      originalFileName: meta.originalFileName,
      prompt: { file: meta.promptFile },
      suggestedName: meta.suggestedName,
      suggestedCoverPageId: meta.suggestedCoverPageId,
      pages: meta.pages.map((page) => ({
        id: page.id,
        file: page.file,
        ...(page.use ? { use: page.use } : {}),
        previewUrl: uploadPreviewUrl(meta.sessionId, page.file),
        thumbnailUrl: `/api/design-template-uploads/${meta.sessionId}/thumbnails/${page.id}`,
        thumbnail: { status: page.thumbnail.status, source: page.thumbnail.source, updatedAt: page.thumbnail.updatedAt },
      })),
    };
  }
}

function selectionKey(request: Record<string, unknown>): string {
  return JSON.stringify([
    request.type,
    typeof request.name === 'string' ? request.name.trim() : request.name,
    request.coverPageId,
  ]);
}

function validateSelection(
  request: Record<string, unknown>,
  meta: StoredSession,
): { type: DesignTemplateType; name: string; coverPageId: string } {
  if (!isDesignTemplateType(request.type)) throw bad('type must be one of deck, report, website');
  const name = typeof request.name === 'string' ? request.name.trim() : '';
  if (!name) throw bad('name is required');
  if (name.length > MAX_NAME_LENGTH) throw bad('name is too long');
  const coverPageId = request.coverPageId;
  if (typeof coverPageId !== 'string' || !meta.pages.some((p) => p.id === coverPageId)) {
    throw bad('coverPageId must be one of the session pages');
  }
  return { type: request.type, name, coverPageId };
}
