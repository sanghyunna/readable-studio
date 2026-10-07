import type http from 'node:http';
import { execFileSync } from 'node:child_process';
import { access, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';
import { stageActiveSkill, skillCwdAliasSegment } from '../src/cwd-aliases.js';
import { loadPluginLocalSkill } from '../src/plugins/local-skill.js';
import { getInstalledPlugin } from '../src/plugins/registry.js';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let server: http.Server;
let shutdown: (() => Promise<void> | void) | undefined;
let origin: string;
let fixture: string;
const id = 'preview-relative-assets-fixture';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

function references(html: string): string[] {
  const $ = load(html);
  const refs = new Set<string>();
  $('img, video, source, script, link, iframe').each((_, element) => {
    for (const attr of ['src', 'poster']) {
      const value = $(element).attr(attr);
      if (value) refs.add(value);
    }
    const srcset = $(element).attr('srcset');
    if (srcset) for (const candidate of srcset.split(',')) refs.add(candidate.trim().split(/\s+/)[0]!);
  });
  for (const match of html.matchAll(/\burl\(\s*['"]?([^)'"\s]+)['"]?\s*\)/gi)) {
    // Font-face URLs are not media/background references; some examples retain
    // optional remote/root-relative font fallbacks that are not vendored.
    if (!/\.(?:woff2?|ttf|otf)(?:[?#]|$)/i.test(match[1]!)) refs.add(match[1]!);
  }
  // Include JS-built media: literals in arrays/objects and background-image constants.
  for (const match of html.matchAll(/['"`]((?:\.\/|\.\.\/)?assets\/[^'"`\s<>]+)['"`]/g)) refs.add(match[1]!);
  return [...refs].filter((ref) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|%23)/i.test(ref));
}

beforeAll(async () => {
  fixture = await mkdtemp(path.join(os.tmpdir(), 'preview-relative-'));
  await mkdir(path.join(fixture, 'nested', 'assets'), { recursive: true });
  await writeFile(path.join(fixture, 'nested', 'assets', 'image.png'), png);
  await writeFile(path.join(fixture, 'nested', 'index.html'), `<!doctype html><html><head>
    <base href="https://wrong.invalid/"><style>.background { background-image: url(assets/image.png); }</style>
    </head><body><img src="assets/image.png"><img srcset="assets/image.png 1x, assets/image.png 2x">
    <div class="background" style="background-image: url('assets/image.png')"></div>
    <video poster="assets/image.png"></video><picture><source srcset="assets/image.png 1x"></picture>
    <script>const folder = 'assets/'; const image = document.createElement('img'); image.src = folder + 'image.png'; document.body.append(image);</script>
    </body></html>`);
  await writeFile(path.join(fixture, 'SKILL.md'), `---\nname: ${id}\ndescription: fixture\n---\nUse assets/image.png.\n`);
  await writeFile(path.join(fixture, 'readable-studio.json'), JSON.stringify({
    name: id, version: '1.0.0', description: 'fixture', license: 'MIT',
    readable: { kind: 'skill', capabilities: ['prompt:inject'], preview: { entry: './nested/index.html' } },
  }));
  const started = await startServer({ port: 0, returnServer: true }) as { server: http.Server; url: string; shutdown?: () => Promise<void> | void };
  ({ server, shutdown } = started);
  origin = started.url;
  const installed = await fetch(`${origin}/api/plugins/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: fixture }) });
  expect(await installed.text()).toContain('event: success');
}, 30_000);

afterAll(async () => {
  if (origin) expect((await fetch(`${origin}/api/plugins/${id}/uninstall`, { method: 'POST' })).ok).toBe(true);
  await Promise.resolve(shutdown?.());
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (fixture) await rm(fixture, { recursive: true, force: true });
}, 60_000);

describe('relative preview assets', () => {
  it('resolves img, srcset, style CSS, inline backgrounds, poster and JS-built URLs against the entry directory', async () => {
    const previewUrl = `${origin}/api/plugins/${id}/preview`;
    const response = await fetch(previewUrl);
    expect(response.status).toBe(200);
    const html = await response.text();
    const $ = load(html);
    expect($('base')).toHaveLength(1);
    const base = new URL($('base').attr('href') ?? previewUrl, previewUrl);
    expect(new URL('assets/' + 'image.png', base).pathname).toBe(`/api/plugins/${id}/asset/nested/assets/image.png`);
    for (const ref of references(html)) {
      const asset = await fetch(new URL(ref, base));
      expect(asset.status, ref).toBe(200);
      expect(asset.headers.get('content-type')).toMatch(/^image\/png/);
      expect(Buffer.from(await asset.arrayBuffer())).toEqual(png);
    }
  });

  it('serves every local media reference from every bundled example with an assets folder offline', async () => {
    const examplesRoot = path.join(root, 'plugins', '_official', 'examples');
    const folders = execFileSync('fd', ['^assets$', examplesRoot, '-t', 'd', '-d', '2', '--absolute-path'], { encoding: 'utf8' }).trim().split(/\r?\n/);
    const htmlFiles = execFileSync('fd', ['\\.html$', examplesRoot, '-t', 'f', '--absolute-path'], { encoding: 'utf8' }).trim().split(/\r?\n/).map((file) => path.resolve(file));
    let templates = 0;
    let assets = 0;
    const types: Record<string, string> = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm' };
    for (const folder of folders) {
      const pluginRoot = path.resolve(path.dirname(folder.replace(/[\\/]$/, '')));
      const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'readable-studio.json'), 'utf8')) as { name: string };
      const previewUrl = `${origin}/api/plugins/${manifest.name}/preview`;
      const response = await fetch(previewUrl);
      // Authoring-only toolkits can have CSS/JS assets without any HTML.
      if (!htmlFiles.some((file) => file.startsWith(pluginRoot + path.sep))) {
        expect(response.status).toBe(404);
        continue;
      }
      expect(response.status, manifest.name).toBe(200);
      const html = await response.text();
      const $ = load(html);
      const base = new URL($('base').attr('href') ?? previewUrl, previewUrl);
      // Audit the original example too, including literal media passed to JS.
      const original = await readFile(path.join(pluginRoot, 'example.html'), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      const originalBase = new URL(`/api/plugins/${manifest.name}/asset/`, origin);
      const urls = new Set([
        ...references(html).map((ref) => new URL(ref, base).href),
        ...references(original).map((ref) => new URL(ref, originalBase).href),
      ]);
      for (const ref of urls) {
        const url = new URL(ref);
        expect(url.origin, `${manifest.name}: ${ref}`).toBe(origin);
        const prefix = `/api/plugins/${manifest.name}/asset/`;
        expect(url.pathname, `${manifest.name}: ${ref}`).toContain(prefix);
        const rel = decodeURIComponent(url.pathname.slice(prefix.length));
        const diskPath = path.resolve(pluginRoot, rel);
        expect(diskPath.startsWith(pluginRoot + path.sep), ref).toBe(true);
        await access(diskPath);
        const asset = await fetch(url);
        expect(asset.status, `${manifest.name}: ${ref}`).toBe(200);
        const type = types[path.extname(diskPath).toLowerCase()];
        if (type) expect(asset.headers.get('content-type'), ref).toContain(type);
        const bytes = Buffer.from(await asset.arrayBuffer());
        if (!/\.html?$/i.test(diskPath)) expect(bytes, ref).toEqual(await readFile(diskPath));
        assets++;
      }
      templates++;
    }
    expect(templates).toBeGreaterThan(30);
    expect(assets).toBeGreaterThan(100);
    process.stdout.write(`Offline preview audit: ${templates} templates, ${assets} references\n`);
  }, 180_000);

  it('copies plugin-local skill media into the agent project and allows copying it beside output', async () => {
    const dataRoot = process.env.READABLE_DATA_DIR ? path.resolve(root, process.env.READABLE_DATA_DIR) : path.join(root, '.readable-studio');
    const db = new Database(path.join(dataRoot, 'app.sqlite'));
    const plugin = getInstalledPlugin(db, 'example-luxury-botanical');
    db.close();
    expect(plugin).not.toBeNull();
    const skill = await loadPluginLocalSkill(plugin!);
    expect(skill).not.toBeNull();
    expect(skill!.body).toContain(`.readable-studio-skills/${skillCwdAliasSegment(skill!.dir)}/`);
    const project = await mkdtemp(path.join(os.tmpdir(), 'preview-agent-assets-'));
    try {
      const staged = await stageActiveSkill(project, skillCwdAliasSegment(skill!.dir), skill!.dir);
      expect(staged.staged).toBe(true);
      const filename = 'BL1996-Beyond_wild_vetiver_Flakon_100ml_300dpi_a55ie5-ad7edb.webp';
      const source = path.join(staged.stagedPath!, 'assets', filename);
      await mkdir(path.join(project, 'assets'));
      const output = path.join(project, 'assets', filename);
      await copyFile(source, output);
      expect(await readFile(output)).toEqual(await readFile(path.join(skill!.dir, 'assets', filename)));
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }, 60_000);
});
