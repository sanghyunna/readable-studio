import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DesignTemplateImportManifest } from '@readable-studio/contracts';
import { renderHtmlThumbnail, waitForDesktopRenderer } from './desktop-render-client.js';

type ThumbnailRuntime = {
  root: string;
  origin: () => string;
  render?: typeof renderHtmlThumbnail;
  ready?: () => Promise<boolean>;
};
let runtime: ThumbnailRuntime | undefined;
const active = new Set<string>();
let sweeping = false;

export function configureTemplateThumbnails(options: ThumbnailRuntime): void {
  runtime = options;
}

export async function requestTemplateThumbnails(opts: {
  templateDir: string;
  id: string;
}): Promise<void> {
  const current = runtime;
  if (!current || active.has(opts.templateDir)) return;
  active.add(opts.templateDir);
  const manifestPath = path.join(opts.templateDir, 'import.json');
  let thumbnail: DesignTemplateImportManifest['thumbnail'] & { error?: string };
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as DesignTemplateImportManifest;
    const coverPath = manifest.cover.split('/').map(encodeURIComponent).join('/');
    const image = await (current.render ?? renderHtmlThumbnail)(
      `${current.origin()}/api/design-templates/${encodeURIComponent(opts.id)}/pages/${coverPath}`,
    );
    const updatedAt = new Date().toISOString();
    if (!Buffer.isBuffer(image)) {
      thumbnail = image.code === 'desktop-unavailable'
        ? { status: 'pending', source: null, updatedAt }
        : { status: 'failed', source: null, updatedAt, error: image.error };
    } else {
      const ext = image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'png'
        : image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP' ? 'webp'
          : null;
      if (!ext) throw new Error('renderer returned neither PNG nor WebP');
      const thumbnails = path.join(opts.templateDir, 'thumbnails');
      // Do not recreate a template deleted while its renderer was running.
      await readFile(manifestPath);
      await mkdir(thumbnails, { recursive: true });
      await writeFile(path.join(thumbnails, `cover.${ext}`), image);
      await rm(path.join(thumbnails, `cover.${ext === 'png' ? 'webp' : 'png'}`), { force: true });
      thumbnail = { status: 'ready', source: 'rendered', updatedAt };
    }
    // Preserve a display-name change made while Electron rendered the cover.
    const latest = JSON.parse(await readFile(manifestPath, 'utf8')) as DesignTemplateImportManifest;
    await writeFile(manifestPath, `${JSON.stringify({ ...latest, thumbnail }, null, 2)}\n`);
  } catch (error) {
    console.warn(`[design-templates] thumbnail generation failed for ${opts.id}`, error);
    try {
      const latest = JSON.parse(await readFile(manifestPath, 'utf8')) as DesignTemplateImportManifest;
      await writeFile(manifestPath, `${JSON.stringify({
        ...latest,
        thumbnail: { status: 'failed', source: null, updatedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) },
      }, null, 2)}\n`);
    } catch (persistError) {
      if ((persistError as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[design-templates] thumbnail failure state could not be saved for ${opts.id}`, persistError);
      }
    }
  } finally {
    active.delete(opts.templateDir);
  }
}

// Registration precedes the desktop IPC listener, so wait for bounded readiness
// before scanning. One sweep at a time; each cover is rendered sequentially.
export async function retryPendingTemplateThumbnails(): Promise<void> {
  const current = runtime;
  if (!current || sweeping) return;
  sweeping = true;
  try {
    if (!await (current.ready ?? waitForDesktopRenderer)()) return;
    const entries = await readdir(current.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('user-')) continue;
      const templateDir = path.join(current.root, entry.name);
      try {
        const manifest = JSON.parse(await readFile(path.join(templateDir, 'import.json'), 'utf8')) as DesignTemplateImportManifest;
        if (manifest.thumbnail.status === 'pending') {
          await requestTemplateThumbnails({ templateDir, id: entry.name });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[design-templates] pending thumbnail read failed', error);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[design-templates] pending thumbnail sweep failed', error);
  } finally {
    sweeping = false;
  }
}
