import type { Express } from 'express';
import { STANDALONE_HTML_EXPORT_HEADERS } from '@readable-studio/contracts';
import { buildProjectExportManifestResponse } from './project-export-manifest.js';
import type { RouteDeps } from './server-context.js';
import { isSandboxModeEnabled } from './sandbox-mode.js';
import { StandaloneHtmlBundleError, StandaloneHtmlLimitError, StandaloneHtmlResolutionError } from './standalone-html.js';
import { bundleProjectStandaloneHtml, StandaloneHtmlSourceError } from './routes/standalone-html.js';

export interface RegisterImportRoutesDeps extends RouteDeps<'db' | 'http' | 'uploads' | 'node' | 'ids' | 'paths' | 'imports' | 'auth' | 'projectStore' | 'conversations' | 'projectFiles' | 'validation'> {}

export function registerImportRoutes(app: Express, ctx: RegisterImportRoutesDeps) {
  const { db } = ctx;
  const { sendApiError } = ctx.http;
  const { importUpload } = ctx.uploads;
  const { fs, path } = ctx.node;
  const { randomUUID } = ctx.ids;
  const { PROJECTS_DIR, RUNTIME_DATA_DIR_CANONICAL } = ctx.paths;
  const { importClaudeDesignZip, projectDir, detectEntryFile } = ctx.imports;
  const {
    consumedImportNonces,
    desktopAuthSecret,
    isDesktopAuthGateActive,
    pruneExpiredImportNonces,
    verifyDesktopImportToken,
  } = ctx.auth;
  const { getProject, insertProject, updateProject } = ctx.projectStore;
  const { insertConversation } = ctx.conversations;
  const { setTabs } = ctx.projectFiles;
  const { validateProjectDesignSystemId } = ctx.validation;
  const rejectSandboxFolderImport = () =>
    isSandboxModeEnabled(process.env)
      ? 'folder imports are disabled when READABLE_SANDBOX_MODE is enabled'
      : null;

  app.post(
    '/api/import/claude-design',
    importUpload.single('file'),
    async (req, res) => {
      try {
        if (!req.file)
          return res.status(400).json({ error: 'zip file required' });
        const originalName =
          req.file.originalname || 'Claude Design export.zip';
        if (!/\.zip$/i.test(originalName)) {
          fs.promises.unlink(req.file.path).catch(() => {});
          return res.status(400).json({ error: 'expected a .zip file' });
        }
        const id = randomUUID();
        const now = Date.now();
        const baseName =
          originalName.replace(/\.zip$/i, '').trim() || 'Claude Design import';
        const imported = await importClaudeDesignZip(
          req.file.path,
          projectDir(PROJECTS_DIR, id),
        );
        fs.promises.unlink(req.file.path).catch(() => {});

        const project = insertProject(db, {
          id,
          name: baseName,
          skillId: null,
          designSystemId: null,
          pendingPrompt: `Imported from Claude Design ZIP: ${originalName}. Continue editing ${imported.entryFile}.`,
          metadata: {
            kind: 'prototype',
            importedFrom: 'claude-design',
            entryFile: imported.entryFile,
            sourceFileName: originalName,
          },
          createdAt: now,
          updatedAt: now,
        });
        const cid = randomUUID();
        insertConversation(db, {
          id: cid,
          projectId: id,
          title: 'Imported Claude Design project',
          createdAt: now,
          updatedAt: now,
        });
        setTabs(db, id, [imported.entryFile], imported.entryFile);
        res.json({
          project,
          conversationId: cid,
          entryFile: imported.entryFile,
          files: imported.files,
        });
      } catch (err: any) {
        if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {});
        res.status(400).json({ error: String(err) });
      }
    },
  );

  // Import an existing local folder as a project. The user picks a folder
  // and Readable Studio works inside it directly: every write goes to metadata.baseDir.
  // No copy, no shadow tree — the user owns the workspace and is
  // responsible for their own version control (git, time machine, etc.),
  // mirroring how Cursor / Claude Code / Aider behave.
  // Replace an existing project's working directory in-place. Mirrors
  // the same trust-gate, realpath, and data-dir checks as folder import,
  // but updates metadata.baseDir on an existing project record.
  app.post('/api/projects/:id/working-dir', async (req, res) => {
    try {
      const projectId = req.params.id;
      const existing = getProject(db, projectId);
      if (!existing) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      const { baseDir } = req.body || {};
      if (typeof baseDir !== 'string' || !baseDir.trim()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'baseDir required');
      }
      const sandboxReason = rejectSandboxFolderImport();
      if (sandboxReason) {
        return sendApiError(res, 400, 'BAD_REQUEST', sandboxReason);
      }
      let trustedPickerImport = false;
      if (isDesktopAuthGateActive()) {
        const secret = desktopAuthSecret();
        if (secret == null) {
          return sendApiError(
            res,
            503,
            'DESKTOP_AUTH_PENDING',
            'desktop auth required but secret not yet registered',
            {
              details: { hint: 'restart desktop or wait for sidecar registration' },
              retryable: true,
            },
          );
        }
        const headerValue = req.get('x-readable-studio-desktop-import-token');
        const token = typeof headerValue === 'string' ? headerValue : '';
        const now = Date.now();
        pruneExpiredImportNonces(now);
        const verification = verifyDesktopImportToken(
          secret,
          baseDir,
          token,
          now,
          consumedImportNonces,
        );
        if (!verification.ok) {
          return sendApiError(
            res,
            403,
            'FORBIDDEN',
            'desktop import token rejected',
            { details: { reason: verification.reason } },
          );
        }
        consumedImportNonces.set(verification.nonce, verification.exp);
        trustedPickerImport = true;
      }

      const trimmedInput = baseDir.trim();
      if (!path.isAbsolute(path.normalize(trimmedInput))) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'baseDir must be absolute');
      }
      let normalizedPath: string;
      try {
        normalizedPath = await fs.promises.realpath(trimmedInput);
      } catch {
        return sendApiError(res, 400, 'BAD_REQUEST', 'folder not found');
      }
      let dirStat;
      try {
        dirStat = await fs.promises.lstat(normalizedPath);
      } catch {
        return sendApiError(res, 400, 'BAD_REQUEST', 'folder not found');
      }
      if (!dirStat.isDirectory()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'path must be a directory');
      }
      if (path.parse(normalizedPath).root === normalizedPath) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'cannot point at the filesystem root');
      }
      if (
        normalizedPath === RUNTIME_DATA_DIR_CANONICAL ||
        normalizedPath.startsWith(RUNTIME_DATA_DIR_CANONICAL + path.sep)
      ) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'cannot point at the data directory');
      }

      const entryFile = await detectEntryFile(normalizedPath);
      const existingMeta = existing.metadata ?? {};
      const nextMeta = {
        ...existingMeta,
        kind: existingMeta.kind ?? 'prototype',
        baseDir: normalizedPath,
        importedFrom: 'folder' as const,
        entryFile,
        ...(trustedPickerImport ? { fromTrustedPicker: true as const } : {}),
      };
      const updated = updateProject(db, projectId, { metadata: nextMeta });
      if (!updated) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      // Folder imports should land on Design Files so users can choose from
      // the imported folder's artifacts. Persist an empty saved tab state so
      // ProjectView does not auto-open the detected primary file on hydration.
      setTabs(db, projectId, [], null);
      /** @type {import('@readable-studio/contracts').ReplaceProjectWorkingDirResponse} */
      const body = { project: updated, baseDir: normalizedPath, entryFile };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  app.post('/api/import/folder', async (req, res) => {
    try {
      const { baseDir, name, skillId, designSystemId } = req.body || {};
      if (typeof baseDir !== 'string' || !baseDir.trim()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'baseDir required');
      }
      const sandboxReason = rejectSandboxFolderImport();
      if (sandboxReason) {
        return sendApiError(res, 400, 'BAD_REQUEST', sandboxReason);
      }
      let trustedPickerImport = false;
      if (isDesktopAuthGateActive()) {
        const secret = desktopAuthSecret();
        if (secret == null) {
          return sendApiError(
            res,
            503,
            'DESKTOP_AUTH_PENDING',
            'desktop auth required but secret not yet registered',
            {
              details: { hint: 'restart desktop or wait for sidecar registration' },
              retryable: true,
            },
          );
        }
        const headerValue = req.get('x-readable-studio-desktop-import-token');
        const token = typeof headerValue === 'string' ? headerValue : '';
        const now = Date.now();
        pruneExpiredImportNonces(now);
        const verification = verifyDesktopImportToken(
          secret,
          baseDir,
          token,
          now,
          consumedImportNonces,
        );
        if (!verification.ok) {
          return sendApiError(
            res,
            403,
            'FORBIDDEN',
            'desktop import token rejected',
            { details: { reason: verification.reason } },
          );
        }
        consumedImportNonces.set(verification.nonce, verification.exp);
        trustedPickerImport = true;
      }
      const trimmedInput = baseDir.trim();
      if (!path.isAbsolute(path.normalize(trimmedInput))) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'baseDir must be absolute');
      }
      // Resolve symlinks once at import and persist the canonical path.
      // Without this, a user-controlled symlink (e.g. ~/sneaky → /etc) at
      // baseDir would let writeProjectFile escape the project sandbox at
      // every later call: resolveSafe checks the *literal* baseDir, but
      // the OS follows the symlink at write time. realpath() collapses
      // the chain so the stored baseDir == what the kernel will write to.
      let normalizedPath: string;
      try {
        normalizedPath = await fs.promises.realpath(trimmedInput);
      } catch {
        return sendApiError(res, 400, 'BAD_REQUEST', 'folder not found');
      }
      // realpath resolved → lstat the canonical path to ensure it's a
      // real directory, not another symlink (defense-in-depth).
      let dirStat;
      try {
        dirStat = await fs.promises.lstat(normalizedPath);
      } catch {
        return sendApiError(res, 400, 'BAD_REQUEST', 'folder not found');
      }
      if (!dirStat.isDirectory()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'path must be a directory');
      }
      if (path.parse(normalizedPath).root === normalizedPath) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'cannot import the filesystem root');
      }
      // Prevent importing the data directory into itself (post-realpath so
      // a symlink pointing into RUNTIME_DATA_DIR is also caught). Compare
      // against the canonical alias because `normalizedPath` is the import
      // folder's realpath; on macOS the data dir at /var/... resolves to
      // /private/var/... and would never start-with the user-shaped path.
      if (
        normalizedPath === RUNTIME_DATA_DIR_CANONICAL ||
        normalizedPath.startsWith(RUNTIME_DATA_DIR_CANONICAL + path.sep)
      ) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'cannot import the data directory');
      }

      const id = randomUUID();
      const now = Date.now();
      const projectName =
        typeof name === 'string' && name.trim()
          ? name.trim()
          : path.basename(normalizedPath);
      const entryFile = await detectEntryFile(normalizedPath);
      const designSystemValidation = await validateProjectDesignSystemId(designSystemId);
      if (!designSystemValidation.ok) {
        return sendApiError(
          res,
          400,
          designSystemValidation.code,
          designSystemValidation.message,
        );
      }

      const project = insertProject(db, {
        id,
        name: projectName,
        skillId: skillId ?? null,
        designSystemId: designSystemValidation.id,
        pendingPrompt: null,
        metadata: {
          kind: 'prototype',
          baseDir: normalizedPath,
          importedFrom: 'folder',
          entryFile,
          ...(trustedPickerImport ? { fromTrustedPicker: true as const } : {}),
        },
        createdAt: now,
        updatedAt: now,
      });

      const cid = randomUUID();
      insertConversation(db, {
        id: cid,
        projectId: id,
        title: `Imported from ${projectName}`,
        createdAt: now,
        updatedAt: now,
      });
      // Folder imports should land on Design Files so users can choose from
      // the imported folder's artifacts. Persist an empty saved tab state so
      // ProjectView does not auto-open the detected primary file on hydration.
      setTabs(db, id, [], null);
      /** @type {import('@readable-studio/contracts').ImportFolderResponse} */
      const body = { project, conversationId: cid, entryFile };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

}

export interface RegisterProjectExportRoutesDeps extends RouteDeps<'db' | 'http' | 'paths' | 'projectStore' | 'exports' | 'projectFiles' | 'validation'> {}

export function registerProjectExportRoutes(app: Express, ctx: RegisterProjectExportRoutesDeps) {
  const { db } = ctx;
  const { sendApiError } = ctx.http;
  const { PROJECTS_DIR } = ctx.paths;
  const { getProject } = ctx.projectStore;
  const { listFiles, readProjectFile, resolveProjectFilePath } = ctx.projectFiles;
  const { isSafeId } = ctx.validation;
  const {
    buildProjectArchive,
    buildBatchArchive,
    buildDesktopPdfExportInput,
    desktopPdfExporter,
    daemonUrlRef,
    sanitizeArchiveFilename,
  } = ctx.exports;
  // Streams a ZIP of the project's on-disk tree so the "Download as .zip"
  // share menu can hand the user the actual files they uploaded — e.g. the
  // imported `ui-design/` folder — instead of a one-file snapshot of the
  // rendered HTML. `root` scopes the archive to a subdirectory; without
  // it, the whole project is packed.
  app.get('/api/projects/:id/archive', async (req, res) => {
    try {
      const root = typeof req.query?.root === 'string' ? req.query.root : '';
      const project = getProject(db, req.params.id);
      const { buffer, baseName } = await buildProjectArchive(
        PROJECTS_DIR,
        req.params.id,
        root,
        project?.metadata,
      );
      const fallbackName = project?.name || req.params.id;
      const fileSlug = sanitizeArchiveFilename(baseName || fallbackName) || 'project';
      const filename = `${fileSlug}.zip`;
      // RFC 5987 dance: legacy `filename=` carries an ASCII fallback, while
      // `filename*=UTF-8''…` lets modern browsers pick up project names
      // with non-ASCII characters (accents, CJK, etc.) without mojibake.
      const asciiFallback =
        filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_') || 'project.zip';
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      res.send(buffer);
    } catch (err: any) {
      const code = err && err.code;
      const status = code === 'ENOENT' || code === 'ENOTDIR' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err?.message || err),
      );
    }
  });

  // Batch archive: accepts a list of file names and returns a ZIP of just
  // those files. Used by the Design Files panel multi-select download.
  app.post('/api/projects/:id/archive/batch', async (req, res) => {
    try {
      const { files } = req.body || {};
      if (!Array.isArray(files) || files.length === 0) {
        sendApiError(res, 400, 'BAD_REQUEST', 'files must be a non-empty array');
        return;
      }
      const project = getProject(db, req.params.id);
      const { buffer } = await buildBatchArchive(
        PROJECTS_DIR,
        req.params.id,
        files,
        project?.metadata,
      );
      const fileSlug = sanitizeArchiveFilename(project?.name || req.params.id) || 'project';
      const filename = `${fileSlug}.zip`;
      const asciiFallback =
        filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_') || 'project.zip';
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      res.send(buffer);
    } catch (err: any) {
      const code = err && err.code;
      const status = code === 'ENOENT' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err?.message || err),
      );
    }
  });

  app.get('/api/projects/:id/export/manifest', async (req, res) => {
    try {
      if (!isSafeId(req.params.id)) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'invalid project id');
      }
      const project = getProject(db, req.params.id);
      if (!project) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      const files = await listFiles(PROJECTS_DIR, req.params.id, {
        metadata: project.metadata,
      });
      /** @type {import('@readable-studio/contracts').ProjectExportManifestResponse} */
      const body = buildProjectExportManifestResponse({
        project,
        projectId: req.params.id,
        files,
      });
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.post('/api/projects/:id/export/pdf', async (req, res) => {
    if (typeof desktopPdfExporter !== 'function') {
      return sendApiError(
        res,
        501,
        'UPSTREAM_UNAVAILABLE',
        'desktop PDF export is only available in the desktop runtime',
      );
    }
    try {
      const { fileName, title, deck } = req.body || {};
      if (typeof fileName !== 'string' || fileName.length === 0) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'fileName required');
      }
      const input = await buildDesktopPdfExportInput({
        daemonUrl: daemonUrlRef.current,
        deck: deck === true,
        fileName,
        projectId: req.params.id,
        projectsRoot: PROJECTS_DIR,
        title: typeof title === 'string' ? title : undefined,
      });
      const result = await desktopPdfExporter(input);
      res.json(result);
    } catch (err: any) {
      const status = err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err?.message || err),
      );
    }
  });

  // Compatibility endpoint for older clients; the POST API and this GET share one bundler.
  app.get('/api/projects/:id/export/*splat', async (req, res) => {
    try {
      if (!isSafeId(req.params.id)) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'invalid project id');
      }

      const inlineRaw =
        typeof req.query.inline === 'string' ? req.query.inline.trim().toLowerCase() : '';
      if (!['1', 'true', 'yes', 'on'].includes(inlineRaw)) {
        return sendApiError(
          res,
          400,
          'BAD_REQUEST',
          "query parameter 'inline=1' is required",
        );
      }

      const project = getProject(db, req.params.id);
      const splatParam = (req.params as { splat?: string | string[] }).splat;
      const relPath = Array.isArray(splatParam) ? splatParam.join('/') : String(splatParam ?? '');
      const report = await bundleProjectStandaloneHtml(
        {
          db,
          http: ctx.http,
          paths: { PROJECTS_DIR },
          projectStore: ctx.projectStore,
          projectFiles: ctx.projectFiles,
          designSystems: { read: async () => null },
        },
        req.params.id,
        relPath,
      );
      res.setHeader('Content-Security-Policy', 'sandbox allow-scripts');
      res.setHeader(STANDALONE_HTML_EXPORT_HEADERS.externalReferenceCount, String(report.externalReferences.length));
      res.setHeader(STANDALONE_HTML_EXPORT_HEADERS.missingLocalReferenceCount, String(report.missingLocalReferences.length));
      res.setHeader(STANDALONE_HTML_EXPORT_HEADERS.skippedSystemFontCount, String(report.skippedSystemFonts.length));
      return res.type('text/html').send(report.html);
    } catch (err: any) {
      if (err instanceof StandaloneHtmlSourceError) {
        return sendApiError(res, err.status, err.code, err.message);
      }
      if (err instanceof StandaloneHtmlResolutionError) {
        return sendApiError(res, 400, 'BAD_REQUEST', err.message);
      }
      if (err instanceof StandaloneHtmlLimitError || err?.name === 'StandaloneHtmlLimitError') {
        return sendApiError(res, 413, 'PAYLOAD_TOO_LARGE', String(err));
      }
      if (err instanceof StandaloneHtmlBundleError || err?.name === 'StandaloneHtmlBundleError') {
        return sendApiError(res, 422, 'BUNDLE_FAILED', String(err));
      }
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

}

export interface RegisterFinalizeRoutesDeps extends RouteDeps<'db' | 'http' | 'paths' | 'projectStore' | 'validation' | 'finalize'> {}

export function registerFinalizeRoutes(app: Express, ctx: RegisterFinalizeRoutesDeps) {
  const { db } = ctx;
  const { sendApiError } = ctx.http;
  const { PROJECTS_DIR, DESIGN_SYSTEMS_DIR } = ctx.paths;
  const { getProject } = ctx.projectStore;
  const { isSafeId, validateExternalApiBaseUrl } = ctx.validation;
  const {
    defaultBaseUrlForFinalizeProtocol,
    finalizeDesignPackage,
    FinalizePackageLockedError,
    FinalizeUpstreamError,
    isFinalizeProviderProtocol,
    redactSecrets,
  } = ctx.finalize;
  app.post('/api/projects/:id/finalize/:provider', async (req, res) => {
    const { apiKey, baseUrl, model, maxTokens, apiVersion, protocol: bodyProtocol } = req.body || {};
    try {
      // Centralized path-traversal guard. `isSafeId` (apps/daemon/src/projects.ts)
      // rejects pure-dot ids (`.`, `..`, etc.) which would otherwise pass
      // the char-class regex and resolve to the parent directory under
      // path.join. Express decodes percent-encoded `%2e%2e` to `..` before
      // we see it, so this check covers both URL-supplied and stored-row
      // attack vectors.
      if (!isSafeId(req.params.id)) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'invalid project id');
      }

      const protocol = req.params.provider;
      if (!isFinalizeProviderProtocol(protocol)) {
        return sendApiError(
          res,
          400,
          'BAD_REQUEST',
          'provider must be one of anthropic|openai|azure|google|ollama',
        );
      }
      if (bodyProtocol !== undefined && bodyProtocol !== protocol) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'body protocol must match route provider');
      }

      if (typeof apiKey !== 'string' || !apiKey.trim()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'apiKey is required');
      }
      if (typeof model !== 'string' || !model.trim()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'model is required');
      }
      let effectiveBaseUrl = defaultBaseUrlForFinalizeProtocol(protocol);
      if (baseUrl !== undefined) {
        if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
          return sendApiError(res, 400, 'BAD_REQUEST', 'baseUrl must be a non-empty string when provided');
        }
        effectiveBaseUrl = baseUrl.trim();
      }
      if (!effectiveBaseUrl) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'baseUrl is required for this provider');
      }
      const validated = await validateExternalApiBaseUrl(effectiveBaseUrl);
      if (validated.error) {
        return sendApiError(
          res,
          validated.forbidden ? 403 : 400,
          validated.forbidden ? 'FORBIDDEN' : 'BAD_REQUEST',
          validated.error,
        );
      }
      if (maxTokens !== undefined && (typeof maxTokens !== 'number' || maxTokens <= 0)) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'maxTokens must be a positive number when provided');
      }
      if (apiVersion !== undefined && typeof apiVersion !== 'string') {
        return sendApiError(res, 400, 'BAD_REQUEST', 'apiVersion must be a string when provided');
      }

      const project = getProject(db, req.params.id);
      if (!project) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }

      const finalizeAbort = new AbortController();
      const abortFromRequest = (): void => {
        if (!finalizeAbort.signal.aborted) finalizeAbort.abort();
      };
      res.on('close', abortFromRequest);

      let result;
      try {
        result = await finalizeDesignPackage(
          db,
          PROJECTS_DIR,
          DESIGN_SYSTEMS_DIR,
          req.params.id,
          {
            protocol,
            apiKey,
            baseUrl: effectiveBaseUrl,
            model,
            maxTokens,
            ...(typeof apiVersion === 'string' && apiVersion.trim()
              ? { apiVersion: apiVersion.trim() }
              : {}),
            signal: finalizeAbort.signal,
          },
        );
      } finally {
        res.off('close', abortFromRequest);
      }
      res.json(result);
    } catch (err: any) {
      // Concurrent finalize - the lockfile was already held by another
      // call. Caller can retry after a short wait; not a client error.
      // Maps to the shared CONFLICT code per @lefarcen P2 on PR #832.
      if (err instanceof FinalizePackageLockedError) {
        return sendApiError(res, 409, 'CONFLICT', err.message);
      }

      // Upstream provider error - status-aware mapping using shared
      // ApiErrorCode values. Run the raw upstream body through
      // redactSecrets so the API key cannot leak even if the provider
      // echoes the inbound headers. Codes per @lefarcen P2 on PR #832:
      // 401 -> UNAUTHORIZED, 429 -> RATE_LIMITED, others -> UPSTREAM_UNAVAILABLE.
      if (err instanceof FinalizeUpstreamError) {
        const safeDetails = redactSecrets(err.rawText || '', [apiKey]);
        const init = safeDetails ? { details: safeDetails } : {};
        if (err.status === 401) {
          return sendApiError(res, 401, 'UNAUTHORIZED', err.message, init);
        }
        if (err.status === 429) {
          return sendApiError(res, 429, 'RATE_LIMITED', err.message, init);
        }
        return sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', err.message, init);
      }

      // The blocking call hit our 120s AbortController timeout - or the
      // caller passed an already-aborted signal. Either way, surface as
      // 503 with the shared UPSTREAM_UNAVAILABLE code (no dedicated
      // TIMEOUT code in the contracts ApiErrorCode union).
      const errName =
        err && typeof err === 'object' && 'name' in err ? (err as { name?: unknown }).name : '';
      if (errName === 'AbortError') {
        return sendApiError(res, 503, 'UPSTREAM_UNAVAILABLE', 'finalize timed out');
      }

      // Unexpected runtime failure (file IO, db access, prompt build).
      // Log via console.error per the daemon convention; client sees a
      // generic 500 with the shared INTERNAL_ERROR code. Run the message
      // through redactSecrets defensively.
      console.error('[finalize]', err);
      const safeMsg = redactSecrets(String(err?.message || err), [apiKey]);
      return sendApiError(res, 500, 'INTERNAL_ERROR', safeMsg);
    }
  });

}
