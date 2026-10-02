import type { Express } from 'express';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isSafeOfflineCdnPath, resolveOfflineCdnUrl, type OfflineCdnManifest } from '../offline-cdn.js';

const MIME: Record<string, string> = { '.css': 'text/css', '.js': 'application/javascript', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject', '.svg': 'image/svg+xml' };

export function registerOfflineCdnRoutes(app: Express, resourceRoot: string): void {
  const root = path.resolve(resourceRoot, 'offline-cdn');
  let manifest: OfflineCdnManifest = { libraries: [] };
  try {
    manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as OfflineCdnManifest;
    if (!Array.isArray(manifest.libraries) || manifest.libraries.some(entry => !['fontawesome', 'chartjs'].includes(entry.lib) || !Number.isInteger(entry.major) || !Array.isArray(entry.files) || entry.files.some(file => typeof file !== 'string' || !isSafeOfflineCdnPath(file)))) throw new Error('Invalid offline CDN manifest');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    console.warn('Offline CDN manifest is absent; CDN requests will remain unchanged.');
  }
  app.get('/api/offline-cdn/resolve', (req, res) => {
    res.json(typeof req.query.url === 'string' ? resolveOfflineCdnUrl(req.query.url, manifest) : null);
  });
  app.get('/offline-cdn/:lib/:major/*asset', (req, res, next) => {
    const file = Array.isArray(req.params.asset) ? req.params.asset.join('/') : String(req.params.asset);
    const library = manifest.libraries.find(entry => entry.lib === req.params.lib && String(entry.major) === req.params.major);
    if (!isSafeOfflineCdnPath(file) || !library?.files.includes(file)) { res.sendStatus(404); return; }
    const target = path.resolve(root, library.lib, String(library.major), file);
    try {
      const canonicalRoot = realpathSync(root);
      const canonicalTarget = realpathSync(target);
      const relative = path.relative(canonicalRoot, canonicalTarget);
      if (relative.startsWith('..') || path.isAbsolute(relative)) { res.sendStatus(404); return; }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.type(MIME[path.extname(file)] ?? 'application/octet-stream');
      res.sendFile(canonicalTarget, { cacheControl: false }, error => { if (error) next(error); });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { res.sendStatus(404); return; }
      next(error);
    }
  });
}
