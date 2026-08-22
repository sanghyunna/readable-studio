import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  STANDALONE_HTML_EXPORT_HEADERS,
  type ApiErrorCode,
  type StandaloneHtmlExportRequest,
  type StandaloneHtmlSource,
} from '@readable-studio/contracts';
import type { Express } from 'express';

import { renderDesignSystemPreview } from '../design-system-preview.js';
import { renderDesignSystemShowcase } from '../design-system-showcase.js';
import { resolveHtmlExportSource } from '../html-export-source.js';
import { PluginHtmlTooLargeError, resolvePluginHtml, resolvePluginSourceFile } from '../plugin-html-source.js';
import { getInstalledPlugin } from '../plugins/registry.js';
import { isSafeId, mimeFor, resolveProjectDir } from '../projects.js';
import {
  bundleStandaloneHtml,
  MAX_STANDALONE_HTML_SOURCE_BYTES,
  StandaloneHtmlBundleError,
  StandaloneHtmlLimitError,
  StandaloneHtmlResolutionError,
  type StandaloneBundleReport,
  type StandaloneSource,
  type StandaloneSourceFile,
} from '../standalone-html.js';

export class StandaloneHtmlSourceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface StandaloneRouteDeps {
  db: any;
  http: { sendApiError: (...args: any[]) => any };
  paths: { PROJECTS_DIR: string };
  projectStore: { getProject: (db: any, id: string) => any };
  projectFiles: {
    readProjectFile: (...args: any[]) => Promise<{ buffer: Buffer; mime: string; name: string; size: number }>;
    resolveProjectFilePath: (...args: any[]) => Promise<{ mime: string; name: string; size: number }>;
  };
  designSystems: { read: (id: string) => Promise<string | null> };
}

function isSafeResourceId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/^\.+$/.test(value) && /^[A-Za-z0-9._:@-]+$/.test(value);
}

function assertSource(value: unknown): StandaloneHtmlSource {
  if (!value || typeof value !== 'object') throw new StandaloneHtmlSourceError(400, 'BAD_REQUEST', 'source is required');
  const source = value as Record<string, unknown>;
  if (source.kind === 'project' && typeof source.projectId === 'string' && typeof source.filePath === 'string') {
    if (!isSafeId(source.projectId) || !source.filePath || Object.keys(source).some((key) => !['kind', 'projectId', 'filePath'].includes(key))) throw new StandaloneHtmlSourceError(400, 'BAD_REQUEST', 'invalid project source');
    return source as StandaloneHtmlSource;
  }
  if (source.kind === 'plugin' && typeof source.pluginId === 'string' && (source.exampleName === undefined || typeof source.exampleName === 'string')) {
    if (!isSafeResourceId(source.pluginId) || (typeof source.exampleName === 'string' && (/[\\/\0]/.test(source.exampleName) || source.exampleName.includes('..'))) || Object.keys(source).some((key) => !['kind', 'pluginId', 'exampleName'].includes(key))) throw new StandaloneHtmlSourceError(400, 'BAD_REQUEST', 'invalid plugin source');
    return source as StandaloneHtmlSource;
  }
  if (source.kind === 'design-system' && typeof source.designSystemId === 'string' && ['showcase', 'preview'].includes(String(source.view))) {
    if (!isSafeResourceId(source.designSystemId) || Object.keys(source).some((key) => !['kind', 'designSystemId', 'view'].includes(key))) throw new StandaloneHtmlSourceError(400, 'BAD_REQUEST', 'invalid design-system source');
    return source as StandaloneHtmlSource;
  }
  if (source.kind === 'inline' && typeof source.html === 'string' && Object.keys(source).every((key) => ['kind', 'html'].includes(key))) return source as StandaloneHtmlSource;
  throw new StandaloneHtmlSourceError(400, 'BAD_REQUEST', 'invalid standalone HTML source');
}

function referenceCandidates(reference: string, ownerPath: string): string[] {
  const normalized = reference.replace(/\\/g, '/');
  const base = normalized.startsWith('/')
    ? path.posix.normalize(normalized.slice(1))
    : path.posix.normalize(path.posix.join(path.posix.dirname(ownerPath), normalized));
  const candidates = [base];
  if (!path.posix.extname(base)) candidates.push(`${base}.js`, `${base}.ts`, `${base}.tsx`, `${base}.jsx`, `${base}.mjs`, `${base}.json`, `${base}/index.js`, `${base}/index.ts`);
  return candidates.filter((candidate) => candidate !== '..' && !candidate.startsWith('../') && !path.posix.isAbsolute(candidate));
}

function packageExportEntries(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(packageExportEntries);
  if (!value || typeof value !== 'object') return [];
  const map = value as Record<string, unknown>;
  const selected = map['.'] ?? map.browser ?? map.import ?? map.default;
  return selected === value ? [] : packageExportEntries(selected);
}

async function assertNoProjectSymlinks(projectsRoot: string, projectId: string, metadata: unknown, relPath: string): Promise<void> {
  const root = resolveProjectDir(projectsRoot, projectId, metadata);
  let cursor = root;
  for (const segment of relPath.replace(/\\/g, '/').split('/').filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) {
        throw new StandaloneHtmlResolutionError('project symlinks cannot be exported');
      }
    } catch (error: any) {
      if (error instanceof StandaloneHtmlResolutionError) throw error;
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }
}

async function resolveProjectFile(
  deps: StandaloneRouteDeps,
  projectId: string,
  metadata: unknown,
  reference: string,
  ownerPath: string,
): Promise<StandaloneSourceFile | null> {
  const { PROJECTS_DIR } = deps.paths;
  let candidates = referenceCandidates(reference, ownerPath);
  const ownerIsModule = /\.[cm]?[jt]sx?$/i.test(ownerPath);
  const bare = ownerIsModule && /^[^./]/.test(reference) && !reference.startsWith('/');
  if (bare) {
    const parts = reference.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..') || reference.includes('\0')) return null;
    const packageName = reference.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
    if (!packageName || (reference.startsWith('@') && parts.length < 2)) return null;
    const subpath = parts.slice(reference.startsWith('@') ? 2 : 1).join('/');
    if (subpath) {
      candidates = referenceCandidates(`/node_modules/${reference}`, ownerPath);
    } else {
      try {
        const manifest = await deps.projectFiles.readProjectFile(PROJECTS_DIR, projectId, `node_modules/${packageName}/package.json`, metadata);
        const parsed = JSON.parse(manifest.buffer.toString('utf8')) as Record<string, unknown>;
        const entries = [...packageExportEntries(parsed.exports), parsed.browser, parsed.module, parsed.main, 'index.js']
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.replace(/^\.\//, ''))
          .filter((value) => value.length > 0 && !value.startsWith('/') && !value.includes('\0') && !value.split('/').includes('..'));
        candidates = [
          ...entries.flatMap((entry) => referenceCandidates(`/node_modules/${packageName}/${entry}`, ownerPath)),
        ];
      } catch {
        candidates = referenceCandidates(`/node_modules/${packageName}/index.js`, ownerPath);
      }
    }
  }
  for (const candidate of candidates) {
    try {
      await assertNoProjectSymlinks(PROJECTS_DIR, projectId, metadata, candidate);
      const meta = await deps.projectFiles.resolveProjectFilePath(PROJECTS_DIR, projectId, candidate, metadata);
      return {
        path: meta.name,
        mime: meta.mime,
        size: meta.size,
        read: async () => (await deps.projectFiles.readProjectFile(PROJECTS_DIR, projectId, meta.name, metadata)).buffer,
      };
    } catch (error) {
      if (error instanceof StandaloneHtmlResolutionError) throw error;
      // Try the next extension/index candidate.
    }
  }
  return null;
}

export async function createProjectStandaloneSource(
  deps: StandaloneRouteDeps,
  projectId: string,
  filePath: string,
): Promise<StandaloneSource> {
  if (!isSafeId(projectId) || !filePath) throw new StandaloneHtmlSourceError(400, 'BAD_REQUEST', 'invalid project source');
  const project = deps.projectStore.getProject(deps.db, projectId);
  if (!project) throw new StandaloneHtmlSourceError(404, 'FILE_NOT_FOUND', 'project not found');
  let meta;
  try {
    await assertNoProjectSymlinks(deps.paths.PROJECTS_DIR, projectId, project?.metadata, filePath);
    meta = await deps.projectFiles.resolveProjectFilePath(deps.paths.PROJECTS_DIR, projectId, filePath, project?.metadata);
  } catch (error: any) {
    throw new StandaloneHtmlSourceError(error?.code === 'ENOENT' ? 404 : 400, error?.code === 'ENOENT' ? 'FILE_NOT_FOUND' : 'BAD_REQUEST', String(error));
  }
  if (meta.size > MAX_STANDALONE_HTML_SOURCE_BYTES) throw new StandaloneHtmlLimitError('source HTML is too large');
  if (!meta.mime.startsWith('text/html')) throw new StandaloneHtmlSourceError(415, 'UNSUPPORTED_MEDIA_TYPE', 'standalone export requires an HTML file');
  const file = await deps.projectFiles.readProjectFile(deps.paths.PROJECTS_DIR, projectId, filePath, project?.metadata);
  const selected = await resolveHtmlExportSource({
    projectId,
    projectsRoot: deps.paths.PROJECTS_DIR,
    relPath: file.name,
    html: file.buffer.toString('utf8'),
    metadata: project?.metadata,
    readProjectFile: async (...args) => {
      await assertNoProjectSymlinks(args[0], args[1], args[3], args[2]);
      return deps.projectFiles.readProjectFile(...args);
    },
    resolveProjectFilePath: async (...args) => {
      await assertNoProjectSymlinks(args[0], args[1], args[3], args[2]);
      return deps.projectFiles.resolveProjectFilePath(...args);
    },
  });
  const selectedRoot = path.posix.dirname(selected.relPath);
  return {
    html: selected.html,
    entryPath: selected.relPath,
    resolve: (reference, ownerPath) => resolveProjectFile(
      deps,
      projectId,
      project?.metadata,
      selected.relPath !== file.name && reference.startsWith('/assets/')
        ? `/${path.posix.join(selectedRoot, reference.slice(1))}`
        : reference,
      ownerPath,
    ),
  };
}

async function createPluginSource(deps: StandaloneRouteDeps, pluginId: string, exampleName?: string): Promise<StandaloneSource> {
  const plugin = getInstalledPlugin(deps.db, pluginId);
  if (!plugin) throw new StandaloneHtmlSourceError(404, 'FILE_NOT_FOUND', 'plugin not found');
  let resolved;
  try {
    resolved = await resolvePluginHtml(plugin, exampleName);
  } catch (error) {
    if (error instanceof PluginHtmlTooLargeError) throw new StandaloneHtmlLimitError(error.message);
    throw error;
  }
  if (!resolved) throw new StandaloneHtmlSourceError(404, 'FILE_NOT_FOUND', 'plugin preview not found');
  return {
    html: resolved.html,
    entryPath: resolved.entryPath,
    resolve: async (reference, ownerPath) => {
      const file = await resolvePluginSourceFile(resolved.rootPath, reference, ownerPath);
      if (!file) return null;
      return { path: file.relPath, mime: mimeFor(file.relPath), size: file.size, read: () => readFile(file.filePath) };
    },
  };
}

async function createSource(deps: StandaloneRouteDeps, source: StandaloneHtmlSource): Promise<StandaloneSource> {
  if (source.kind === 'project') return createProjectStandaloneSource(deps, source.projectId, source.filePath);
  if (source.kind === 'plugin') return createPluginSource(deps, source.pluginId, source.exampleName);
  if (source.kind === 'design-system') {
    const body = await deps.designSystems.read(source.designSystemId);
    if (body === null) throw new StandaloneHtmlSourceError(404, 'FILE_NOT_FOUND', 'design system not found');
    return {
      html: source.view === 'showcase'
        ? renderDesignSystemShowcase(source.designSystemId, body)
        : renderDesignSystemPreview(source.designSystemId, body),
      entryPath: 'index.html',
      resolve: async () => null,
    };
  }
  return { html: source.html, entryPath: 'index.html', resolve: async () => null };
}

export async function bundleProjectStandaloneHtml(deps: StandaloneRouteDeps, projectId: string, filePath: string): Promise<StandaloneBundleReport> {
  return bundleStandaloneHtml(await createProjectStandaloneSource(deps, projectId, filePath));
}

function sendHtml(res: any, report: StandaloneBundleReport): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="standalone.html"');
  res.setHeader('Content-Security-Policy', 'sandbox allow-scripts');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(STANDALONE_HTML_EXPORT_HEADERS.externalReferenceCount, String(report.externalReferences.length));
  res.setHeader(STANDALONE_HTML_EXPORT_HEADERS.missingLocalReferenceCount, String(report.missingLocalReferences.length));
  res.setHeader(STANDALONE_HTML_EXPORT_HEADERS.skippedSystemFontCount, String(report.skippedSystemFonts.length));
  res.setHeader('Content-Length', String(report.outputBytes));
  res.end(report.html);
}

export function registerStandaloneHtmlRoutes(app: Express, deps: StandaloneRouteDeps): void {
  app.post('/api/exports/standalone-html', async (req, res) => {
    try {
      const request = req.body as StandaloneHtmlExportRequest | undefined;
      if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some((key) => key !== 'source')) {
        throw new StandaloneHtmlSourceError(400, 'BAD_REQUEST', 'request must contain only source');
      }
      const source = assertSource(request?.source);
      sendHtml(res, await bundleStandaloneHtml(await createSource(deps, source)));
    } catch (error) {
      if (error instanceof StandaloneHtmlSourceError) return deps.http.sendApiError(res, error.status, error.code, error.message);
      if (error instanceof StandaloneHtmlResolutionError) return deps.http.sendApiError(res, 400, 'BAD_REQUEST', error.message);
      if (error instanceof StandaloneHtmlLimitError) return deps.http.sendApiError(res, 413, 'PAYLOAD_TOO_LARGE', error.message);
      if (error instanceof StandaloneHtmlBundleError) return deps.http.sendApiError(res, 422, 'BUNDLE_FAILED', error.message);
      return deps.http.sendApiError(res, 500, 'INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
    }
  });
}
