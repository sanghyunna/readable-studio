import express from 'express';
import type { Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { registerStaticResourceRoutes } from '../src/routes/static-resource.js';
import { PNG_1PX } from './helpers/template-zip.js';

vi.mock('../src/desktop-render-client.js', () => ({
  renderHtmlThumbnail: vi.fn(),
  waitForDesktopRenderer: vi.fn().mockResolvedValue(false),
}));
let root: string;
let server: Server;
let origin: string;
beforeAll(async () => {
  // Runtime data commonly lives under hidden .tmp / .readable-studio roots.
  root = await mkdtemp(path.join(os.tmpdir(), '.thumbnail-routes-'));
  const dir = path.join(root, 'user-deck');
  await mkdir(path.join(dir, 'pages', 'assets'), { recursive: true });
  await mkdir(path.join(dir, 'thumbnails'));
  await writeFile(path.join(dir, 'import.json'), JSON.stringify({ schemaVersion: 1, id: 'user-deck' }));
  await writeFile(path.join(dir, 'pages', 'cover.html'), '<link href="assets/style.css"><h1>Cover</h1>');
  await writeFile(path.join(dir, 'pages', 'assets', 'style.css'), 'h1{color:red}');
  const app = express();
  registerStaticResourceRoutes(app, {
    paths: {
      USER_DESIGN_TEMPLATES_DIR: root, RUNTIME_DATA_DIR: root,
      RUNTIME_DATA_DIR_CANONICAL: root, PROJECT_ROOT: root,
      ARTIFACTS_DIR: root, BUNDLED_PETS_DIR: root, DESIGN_SYSTEMS_DIR: root,
      DESIGN_TEMPLATES_DIR: root, READABLE_BIN: root, PROJECTS_DIR: root,
      SKILLS_DIR: root, USER_DESIGN_SYSTEMS_DIR: root, USER_SKILLS_DIR: root,
    },
    http: {
      createSseResponse: () => undefined,
      isLocalSameOrigin: () => true,
      sendMulterError: () => undefined,
      resolvedPortRef: { get current() { return (server.address() as { port: number })?.port ?? 0; } },
      requireLocalDaemonRequest: (_req: unknown, _res: unknown, next: () => void) => next(),
      sendApiError: (res: express.Response, status: number, code: string, error: string) => res.status(status).json({ code, error }),
    },
    resources: {
      listAllDesignTemplates: async () => [],
      listAllDesignSystems: async () => [],
      listAllSkills: async () => [],
      listAllSkillLikeEntries: async () => [],
      mimeFor: (file: string) => file.endsWith('.css') ? 'text/css' : 'text/html',
    },
  });
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});
it.each([
  ['cover.html', 'text/html', '<h1>Cover</h1>'],
  ['assets/style.css', 'text/css', 'h1{color:red}'],
])('serves page file %s with its MIME', async (file, mime, body) => {
  const response = await fetch(`${origin}/api/design-templates/user-deck/pages/${file}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain(mime);
  expect(await response.text()).toContain(body);
});
it.each(['%2e%2e%2fimport.json', '..%5cimport.json', 'assets%2f..%2f..%2fimport.json'])('rejects traversal %s', async (file) => {
  const response = await fetch(`${origin}/api/design-templates/user-deck/pages/${file}`);
  expect(response.status).toBe(403);
});
it.each([
  ['png', PNG_1PX, 'image/png'],
  ['webp', Buffer.from('524946460400000057454250', 'hex'), 'image/webp'],
])('serves %s thumbnail with correct Content-Type', async (ext, bytes, mime) => {
  const thumbs = path.join(root, 'user-deck', 'thumbnails');
  await rm(path.join(thumbs, 'cover.png'), { force: true });
  await rm(path.join(thumbs, 'cover.webp'), { force: true });
  await writeFile(path.join(thumbs, `cover.${ext}`), bytes);
  const response = await fetch(`${origin}/api/design-templates/user-deck/thumbnail`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain(mime);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
});
