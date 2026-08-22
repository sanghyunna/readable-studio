import path from 'node:path';

import { MAX_STANDALONE_HTML_SOURCE_BYTES, StandaloneHtmlLimitError, StandaloneHtmlResolutionError } from './standalone-html.js';

export async function resolveHtmlExportSource({
  projectId,
  projectsRoot,
  relPath,
  html,
  metadata,
  readProjectFile,
  resolveProjectFilePath,
}: {
  projectId: string;
  projectsRoot: string;
  relPath: string;
  html: string;
  metadata: unknown;
  readProjectFile: (projectsRoot: string, projectId: string, relPath: string, metadata?: unknown) => Promise<{ buffer: Buffer }>;
  resolveProjectFilePath: (projectsRoot: string, projectId: string, relPath: string, metadata?: unknown) => Promise<{ size: number; mime: string }>;
}): Promise<{ html: string; relPath: string }> {
  const viteModule = [...html.matchAll(/<script\b[^>]*>/gi)].some(([tag]) =>
    /\btype\s*=\s*["']module["']/i.test(tag) && /\bsrc\s*=\s*["']\/src\/[^"']+["']/i.test(tag));
  if (!viteModule) return { html, relPath };
  const ownerDir = path.posix.dirname(relPath);
  const distRelPath = ownerDir === '.' ? 'dist/index.html' : `${ownerDir}/dist/index.html`;
  try {
    const meta = await resolveProjectFilePath(projectsRoot, projectId, distRelPath, metadata);
    if (meta.size > MAX_STANDALONE_HTML_SOURCE_BYTES) throw new StandaloneHtmlLimitError('Vite dist HTML is too large');
    if (!meta.mime.startsWith('text/html')) return { html, relPath };
    const file = await readProjectFile(projectsRoot, projectId, distRelPath, metadata);
    return {
      html: file.buffer.toString('utf8').replace(/\b(href|src)\s*=\s*(["'])\/assets\//gi, (_match, attr: string, quote: string) => `${attr}=${quote}assets/`),
      relPath: distRelPath,
    };
  } catch (error) {
    if (error instanceof StandaloneHtmlLimitError || error instanceof StandaloneHtmlResolutionError) throw error;
    return { html, relPath };
  }
}
