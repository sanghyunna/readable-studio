import { describe, it, expect } from 'vitest';
import express from 'express';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { resolveOfflineCdnUrl, type OfflineCdnManifest } from '../src/offline-cdn.js';
import { registerOfflineCdnRoutes } from '../src/routes/offline-cdn.js';

const manifest: OfflineCdnManifest = { libraries: [
  { lib: 'fontawesome', major: 4, version: '4.7.0', files: ['css/font-awesome.min.css', 'fonts/fontawesome-webfont.woff2'] },
  { lib: 'fontawesome', major: 5, version: '5.15.4', files: ['css/all.min.css', 'webfonts/fa-solid-900.woff2', 'js/all.min.js'] },
  { lib: 'fontawesome', major: 6, version: '6.7.2', files: ['css/all.min.css', 'webfonts/fa-solid-900.woff2', 'webfonts/fa-solid-900.woff', 'webfonts/fa-solid-900.ttf', 'webfonts/fa-solid-900.eot', 'webfonts/fa-solid-900.svg', 'js/all.min.js'] },
  { lib: 'chartjs', major: 2, version: '2.9.4', files: ['dist/Chart.min.js', 'dist/Chart.bundle.min.js', 'dist/Chart.min.css'] },
  { lib: 'chartjs', major: 3, version: '3.9.1', files: ['dist/chart.min.js'] },
  { lib: 'chartjs', major: 4, version: '4.4.1', files: ['dist/chart.umd.js'] },
] };
const cases: [string, string, number, string][] = [
  ['https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css', 'fontawesome', 6, 'css/all.min.css'],
  ['https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js', 'chartjs', 4, 'dist/chart.umd.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/Chart.js/2.9.4/Chart.min.js', 'chartjs', 2, 'dist/Chart.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/Chart.js/2.9.4/Chart.bundle.js', 'chartjs', 2, 'dist/Chart.bundle.min.js'],
  ['https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.7.2/css/all.css', 'fontawesome', 6, 'css/all.min.css'],
  ['https://cdn.jsdelivr.net/npm/chart.js', 'chartjs', 4, 'dist/chart.umd.js'],
  ['https://cdn.jsdelivr.net/npm/chart.js@4', 'chartjs', 4, 'dist/chart.umd.js'],
  ['https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js', 'chartjs', 4, 'dist/chart.umd.js'],
  ['https://cdn.jsdelivr.net/npm/chart.js/dist/chart.umd.js', 'chartjs', 4, 'dist/chart.umd.js'],
  ['https://unpkg.com/chart.js@3', 'chartjs', 3, 'dist/chart.min.js'],
  ['https://unpkg.com/@fortawesome/fontawesome-free@5/css/all.min.css', 'fontawesome', 5, 'css/all.min.css'],
  ['https://unpkg.com/font-awesome@4.7.0/css/font-awesome.css', 'fontawesome', 4, 'css/font-awesome.min.css'],
  ['https://use.fontawesome.com/releases/v6.7.2/css/all.css', 'fontawesome', 6, 'css/all.min.css'],
  ['https://use.fontawesome.com/releases/v6.7.2/webfonts/fa-solid-900.woff2', 'fontawesome', 6, 'webfonts/fa-solid-900.woff2'],
  ['https://maxcdn.bootstrapcdn.com/font-awesome/4.7.0/css/font-awesome.min.css', 'fontawesome', 4, 'css/font-awesome.min.css'],
  ['https://stackpath.bootstrapcdn.com/font-awesome/4.7.0/css/font-awesome.min.css', 'fontawesome', 4, 'css/font-awesome.min.css'],
  ['https://kit.fontawesome.com/abcdef.js', 'fontawesome', 6, 'js/all.min.js'],
  ['https://ka-f.fontawesome.com/abcdef.js?token=x', 'fontawesome', 6, 'js/all.min.js'],
];
describe('offline CDN resolver', () => {
  it.each(cases)('%s', (url, lib, major, file) => expect(resolveOfflineCdnUrl(url, manifest)).toEqual({ lib, major, path: file }));
  it.each(['https://fonts.googleapis.com/css2?family=Inter', 'https://cdn.jsdelivr.net/npm/tailwindcss', 'https://unpkg.com/@fortawesome/fontawesome-pro@6/css/all.css', 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/8/css/all.css', 'https://unpkg.com/chart.js@4/dist/missing.js', 'https://kit.fontawesome.com.evil.test/a.js', 'file:///chart.js', 'garbage', 'https://unpkg.com/chart.js@4/dist/%2e%2e%2fsecret.js'])('leaves %s alone', url => expect(resolveOfflineCdnUrl(url, manifest)).toBeNull());
});
describe('offline CDN route', () => {
  it('serves only listed files with MIME, CORS and immutable caching; resolves over HTTP', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ocdn-'));
    const app = express();
    for (const library of manifest.libraries) for (const file of library.files) {
      const target = path.join(root, 'offline-cdn', library.lib, String(library.major), file);
      await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, 'fixture');
    }
    await writeFile(path.join(root, 'offline-cdn/manifest.json'), JSON.stringify(manifest));
    registerOfflineCdnRoutes(app, root);
    const server = createServer(app);
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      for (const [file, mime] of [['fontawesome/6/css/all.min.css', 'text/css'], ['fontawesome/6/webfonts/fa-solid-900.woff2', 'font/woff2'], ['chartjs/4/dist/chart.umd.js', 'javascript'], ['fontawesome/6/webfonts/fa-solid-900.woff', 'font/woff'], ['fontawesome/6/webfonts/fa-solid-900.ttf', 'font/ttf'], ['fontawesome/6/webfonts/fa-solid-900.eot', 'application/vnd.ms-fontobject'], ['fontawesome/6/webfonts/fa-solid-900.svg', 'image/svg+xml']]) {
        const response = await fetch(`${origin}/offline-cdn/${file}`);
        expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain(mime);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(response.headers.get('cache-control')).toContain('immutable');
      }
      for (const file of ['fontawesome/6/css/no.css', 'fontawesome/6/css/%2e%2e%2fmanifest.json', 'fontawesome/6/css/..%5c..%5cmanifest.json', 'fontawesome/6/%252e%252e/manifest.json', 'evil/6/css/all.min.css']) expect((await fetch(`${origin}/offline-cdn/${file}`)).status).toBe(404);
      const result = await fetch(`${origin}/api/offline-cdn/resolve?url=${encodeURIComponent(cases[0]![0])}`);
      expect(await result.json()).toEqual({ lib: 'fontawesome', major: 6, path: 'css/all.min.css' });
    } finally { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); await rm(root, { recursive: true, force: true }); }
  });
});
