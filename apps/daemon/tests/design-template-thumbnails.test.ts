import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureTemplateThumbnails,
  requestTemplateThumbnails,
  retryPendingTemplateThumbnails,
} from '../src/design-template-thumbnails.js';
import { PNG_1PX } from './helpers/template-zip.js';

const webp = Buffer.from('524946460400000057454250', 'hex');
let root: string;
const render = vi.fn();
const ready = vi.fn();
async function template(id = 'user-deck', status = 'pending') {
  const dir = path.join(root, id);
  await mkdir(path.join(dir, 'pages'), { recursive: true });
  await writeFile(path.join(dir, 'pages', 'cover.html'), '<h1>Cover</h1>');
  await writeFile(path.join(dir, 'import.json'), JSON.stringify({
    schemaVersion: 1, id, name: 'Deck', cover: 'cover.html',
    pages: [{ file: 'cover.html' }],
    thumbnail: { status, source: null, updatedAt: '2020-01-01' },
  }));
  return dir;
}
const manifest = async (dir: string) => JSON.parse(await readFile(path.join(dir, 'import.json'), 'utf8'));
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'template-thumbnails-'));
  render.mockReset().mockResolvedValue(webp);
  ready.mockReset().mockResolvedValue(true);
  configureTemplateThumbnails({ root, origin: () => 'http://127.0.0.1:12345', render, ready });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('cover thumbnail generation', () => {
  it('captures an imported cover at its own canvas dimensions and aspect ratio', async () => {
    const dir = await template();
    await writeFile(path.join(dir, 'pages', 'cover.html'), '<style>.page{width:900px;height:1200px}</style><main class="page">Portrait cover</main>');
    await requestTemplateThumbnails({ templateDir: dir, id: 'user-deck' });
    expect(render).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/api/design-templates/user-deck/pages/cover.html',
      { width: 900, height: 1200, outWidth: 360, outHeight: 480 },
    );
  });

  it.each([['webp', webp], ['png', PNG_1PX]])('writes detected %s bytes and ready/rendered state', async (ext, bytes) => {
    const dir = await template();
    render.mockResolvedValue(bytes);
    await requestTemplateThumbnails({ templateDir: dir, id: 'user-deck' });
    expect(await readFile(path.join(dir, 'thumbnails', `cover.${ext}`))).toEqual(bytes);
    expect((await manifest(dir)).thumbnail).toMatchObject({ status: 'ready', source: 'rendered' });
    expect(render).toHaveBeenCalledWith('http://127.0.0.1:12345/api/design-templates/user-deck/pages/cover.html',
      { width: 1920, height: 1080, outWidth: 480, outHeight: 270 });
  });
  it('keeps unavailable desktop pending', async () => {
    const dir = await template();
    render.mockResolvedValue({ ok: false, code: 'desktop-unavailable', error: 'offline' });
    await requestTemplateThumbnails({ templateDir: dir, id: 'user-deck' });
    expect((await manifest(dir)).thumbnail).toMatchObject({ status: 'pending', source: null });
  });
  it('rejects unknown image magic without writing a cover', async () => {
    const dir = await template();
    render.mockResolvedValue(Buffer.from('not an image'));
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await requestTemplateThumbnails({ templateDir: dir, id: 'user-deck' });
    expect((await manifest(dir)).thumbnail).toMatchObject({ status: 'failed', error: 'renderer returned neither PNG nor WebP' });
    log.mockRestore();
  });
  it.each(['THUMBNAIL_RENDER_FAILED', 'THUMBNAIL_RENDER_TIMEOUT'])('records %s', async (code) => {
    const dir = await template();
    render.mockResolvedValue({ ok: false, code, error: 'capture failed' });
    await requestTemplateThumbnails({ templateDir: dir, id: 'user-deck' });
    expect((await manifest(dir)).thumbnail).toMatchObject({ status: 'failed', error: 'capture failed' });
  });
  it('contains thrown renderer errors', async () => {
    const dir = await template();
    render.mockRejectedValue(new Error('unexpected'));
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(requestTemplateThumbnails({ templateDir: dir, id: 'user-deck' })).resolves.toBeUndefined();
    expect((await manifest(dir)).thumbnail).toMatchObject({ status: 'failed', error: 'unexpected' });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
  it('ignores concurrent duplicate requests', async () => {
    const dir = await template();
    let release!: (value: Buffer) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    render.mockImplementation(() => { entered(); return new Promise<Buffer>((resolve) => { release = resolve; }); });
    const first = requestTemplateThumbnails({ templateDir: dir, id: 'user-deck' });
    await started;
    await requestTemplateThumbnails({ templateDir: dir, id: 'user-deck' });
    release(webp);
    await first;
    expect(render).toHaveBeenCalledTimes(1);
  });
  it('sweeps each pending template once, sequentially, on availability trigger', async () => {
    await template('user-a');
    await template('user-b');
    await template('user-ready', 'ready');
    await template('user-failed', 'failed');
    let active = 0;
    render.mockImplementation(async () => {
      expect(active++).toBe(0);
      await Promise.resolve();
      active--;
      return webp;
    });
    await retryPendingTemplateThumbnails();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(2);
    expect((await manifest(path.join(root, 'user-a'))).thumbnail.status).toBe('ready');
  });
  it('does not sweep before the desktop is ready', async () => {
    await template();
    ready.mockResolvedValue(false);
    await retryPendingTemplateThumbnails();
    expect(render).not.toHaveBeenCalled();
  });
  it('removes a stale image of the other format on regeneration', async () => {
    const dir = await template();
    await mkdir(path.join(dir, 'thumbnails'));
    await writeFile(path.join(dir, 'thumbnails', 'cover.webp'), webp);
    render.mockResolvedValue(PNG_1PX);
    await requestTemplateThumbnails({ templateDir: dir, id: 'user-deck' });
    await expect(readFile(path.join(dir, 'thumbnails', 'cover.webp'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
