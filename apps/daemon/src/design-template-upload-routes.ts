// Upload-wizard endpoints for user design templates (see
// DesignTemplateUploadSessions). Writes keep the local-origin check of the
// one-shot import; reads serve session pages/thumbnails by server-side ids.
import type { Express, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertSafeTemplatePagePath,
  resolveTemplatePageFile,
} from './design-template-import.js';
import type { DesignTemplateUploadSessions } from './design-template-uploads.js';

export interface DesignTemplateUploadRouteDeps {
  sessions: DesignTemplateUploadSessions;
  importUpload?: any;
  requireLocalOrigin: (req: Request, res: Response) => boolean;
  sendApiError: (res: Response, status: number, code: string, message: string) => unknown;
  sendTemplateError: (res: Response, err: unknown) => unknown;
  /** Catalog summary of a registered user template (same as POST /api/design-templates/import). */
  userTemplateSummary: (id: string) => Promise<unknown>;
  mimeFor: (file: string) => string;
}

const sessionParam = (req: Request) => String(req.params.sessionId ?? '');

export function registerDesignTemplateUploadRoutes(app: Express, deps: DesignTemplateUploadRouteDeps): void {
  const { sessions, importUpload, requireLocalOrigin, sendApiError, sendTemplateError } = deps;
  sessions.start();

  app.post(
    '/api/design-template-uploads/analyse',
    (req, res, next) => {
      if (!requireLocalOrigin(req, res)) return;
      if (!importUpload) return sendApiError(res, 500, 'INTERNAL_ERROR', 'upload middleware unavailable');
      importUpload.single('file')(req, res, (err: unknown) => {
        if (err) return sendApiError(res, 400, 'BAD_REQUEST', err instanceof Error ? err.message : String(err));
        next();
      });
    },
    async (req, res) => {
      const file = (req as Request & { file?: { path: string; originalname: string } }).file;
      try {
        if (!file) return sendApiError(res, 400, 'BAD_REQUEST', 'zip file required (multipart field "file")');
        if (!/\.zip$/i.test(file.originalname)) {
          return sendApiError(res, 400, 'BAD_REQUEST', 'design template upload expects a .zip file');
        }
        const analysis = await sessions.analyse({
          zip: await fs.promises.readFile(file.path),
          originalFileName: file.originalname,
        });
        // The client went away (upload aborted / wizard closed) before it
        // could learn the session id: nobody can cancel it, so do it here.
        // (req.destroyed is no signal: a fully read request auto-destroys.)
        if (res.destroyed) {
          await sessions.cancel(analysis.sessionId);
          return;
        }
        res.on('close', () => {
          if (!res.writableFinished) void sessions.cancel(analysis.sessionId);
        });
        res.status(201).json(analysis);
      } catch (err) {
        sendTemplateError(res, err);
      } finally {
        if (file) await fs.promises.rm(file.path, { force: true });
      }
    },
  );

  app.get('/api/design-template-uploads/:sessionId', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await sessions.get(sessionParam(req)));
    } catch (err) {
      sendTemplateError(res, err);
    }
  });

  app.get('/api/design-template-uploads/:sessionId/pages/*splat', async (req, res) => {
    try {
      const relative = assertSafeTemplatePagePath(req.params.splat);
      const { root, within, file } = await resolveTemplatePageFile(await sessions.pagesDir(sessionParam(req)), relative);
      res.type(deps.mimeFor(file)).setHeader('Cache-Control', 'no-cache');
      res.sendFile(within, { root });
    } catch (err) {
      sendTemplateError(res, err);
    }
  });

  app.get('/api/design-template-uploads/:sessionId/thumbnails/:pageId', async (req, res) => {
    try {
      const image = await sessions.thumbnailFile(sessionParam(req), String(req.params.pageId ?? ''));
      if (!image) return sendApiError(res, 404, 'NOT_FOUND', 'thumbnail not available');
      res.type(path.extname(image)).setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.basename(image), { root: path.dirname(image) });
    } catch (err) {
      sendTemplateError(res, err);
    }
  });

  app.post('/api/design-template-uploads/:sessionId/finalize', async (req, res) => {
    if (!requireLocalOrigin(req, res)) return;
    try {
      const result = await sessions.finalize(sessionParam(req), req.body);
      res.status(201).json({ template: await deps.userTemplateSummary(result.id) });
    } catch (err) {
      sendTemplateError(res, err);
    }
  });

  app.delete('/api/design-template-uploads/:sessionId', async (req, res) => {
    if (!requireLocalOrigin(req, res)) return;
    try {
      await sessions.cancel(sessionParam(req));
      res.json({ ok: true });
    } catch (err) {
      sendTemplateError(res, err);
    }
  });
}
