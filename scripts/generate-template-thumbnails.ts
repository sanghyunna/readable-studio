/// <reference lib="dom" />
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';

// Build-time network is intentional: the shipped WebP, not a live iframe,
// guarantees offline viewing. Browser version is pinned in pnpm-lock.yaml.
// pnpm exec tsx scripts/generate-template-thumbnails.ts [--check] [--id example-...]
const root = process.cwd();
const out = path.join(root, 'apps/web/public/template-thumbnails');
const evidence = path.join(root, process.argv.includes('--evidence') ? process.argv[process.argv.indexOf('--evidence') + 1]! : '.omo/evidence/impl-thumbs');
const files = execFileSync('fd', ['^readable-studio\\.json$', 'plugins/_official/examples'], { encoding: 'utf8' }).trim().split(/\r?\n/);
const templates = await Promise.all(files.map(async file => ({ file, manifest: JSON.parse(await readFile(file, 'utf8')) })));
const selected = templates.filter(({ manifest }) => ['deck', 'report', 'website'].includes(manifest.readable.hubType)).sort((a, b) => ['deck', 'report', 'website'].indexOf(a.manifest.readable.hubType) - ['deck', 'report', 'website'].indexOf(b.manifest.readable.hubType));
const onlyId = process.argv.includes('--id') ? process.argv[process.argv.indexOf('--id') + 1] : undefined;
const ids = onlyId?.split(',');
const htmlFiles = execFileSync('fd', ['\\.html$', 'plugins/_official/examples', 'design-templates'], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
await mkdir(out, { recursive: true });
await mkdir(evidence, { recursive: true });
if (process.argv.includes('--check')) {
  const missing = [];
  for (const { manifest } of selected) {
    const src = manifest.readable.thumbnail?.src;
    if (src !== `/template-thumbnails/${manifest.name}.webp`) { missing.push(manifest.name); continue; }
    if ((await stat(path.join(root, 'apps/web/public', src))).size === 0) throw new Error(`Empty thumbnail: ${manifest.name}`);
  }
  if (missing.length) throw new Error(`Missing thumbnails: ${missing.join(', ')}`);
  console.log(`Coverage: ${selected.length}/${selected.length}`);
} else {
  const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-angle=swiftshader'] });
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  const entries: { id: string; type: string; sourceHash: string; bytes: number }[] = [];
  const failures: { id: string; error: string }[] = [];
  try {
    for (const { file, manifest } of selected) {
      if (ids && !ids.includes(manifest.name)) continue;
      const type = manifest.readable.hubType;
      try {
        console.log(`Capturing ${manifest.name}`);
        const viewport = type === 'deck' ? { width: 1920, height: 1080 } : type === 'report' ? { width: 1280, height: 1600 } : { width: 1440, height: 900 };
        await page.setViewportSize(viewport);
        const folder = path.dirname(file);
        const sourceFolder = path.join(root, 'design-templates', path.basename(folder));
        const candidates = htmlFiles.filter(candidate => [folder, sourceFolder].some(base => path.resolve(candidate).startsWith(path.resolve(base) + path.sep)));
        const declared = path.join(folder, manifest.readable.thumbnail?.entry ?? manifest.readable.preview?.entry ?? 'example.html');
        const filename = candidates.find(candidate => path.resolve(candidate) === path.resolve(declared)) ?? candidates.find(candidate => candidate.endsWith('example.html')) ?? candidates.find(candidate => candidate.endsWith('template.html')) ?? candidates.find(candidate => /examples[\\/]demo-deck[\\/]index\.html$/.test(candidate));
        if (!filename) throw new Error('No HTML exemplar');
        let html = await readFile(filename, 'utf8');
        if (html.includes('<!-- SLIDES_HERE -->')) html = html.replace('<!-- SLIDES_HERE -->', await readFile(path.join(path.dirname(filename), 'example-slides.html'), 'utf8'));
        const url = pathToFileURL(path.resolve(filename)).href;
        await page.route(url, route => route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' }), { times: 1 });
        await page.goto(url, { waitUntil: 'load', timeout: 30000 });
        // Streaming media and render loops need not become network-idle.
        // Let authored entrance timers and canvas scenes reach their intended frame.
        await page.waitForTimeout(2500);
        // tsx's function-name transform can otherwise leak __name into the page.
        await page.evaluate('globalThis.__name = (value) => value');
        await page.evaluate(async () => {
          let timer: ReturnType<typeof setTimeout>;
          await Promise.race([new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Thumbnail readiness exceeded 15 seconds')), 15000); }), (async () => {
          await document.fonts.ready;
          const bounded = async (work: Promise<unknown>, ms = 10000) => {
            let timeout: ReturnType<typeof setTimeout>;
            try { await Promise.race([work, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Media readiness timeout')), ms); })]); }
            finally { clearTimeout(timeout!); }
          };
          const failed: HTMLImageElement[] = [];
          await Promise.all(Array.from(document.images).map(async image => {
            image.loading = 'eager';
            try { await bounded(image.decode()); } catch { failed.push(image); }
          }));
          const visibleFailures = failed.filter(image => {
            const box = image.getBoundingClientRect();
            return box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth && box.width * box.height > 4096;
          });
          if (visibleFailures.length > 1 || visibleFailures.some(image => {
            const box = image.getBoundingClientRect();
            return box.width * box.height > innerWidth * innerHeight * 0.1;
          })) throw new Error(`Undecoded visible images: ${visibleFailures.map(image => image.currentSrc).join(', ')}`);
          // CSS backgrounds are not represented in document.images.
          const backgrounds = new Set<string>();
          for (const element of Array.from(document.querySelectorAll('*'))) {
            const box = element.getBoundingClientRect();
            if (box.bottom <= 0 || box.top >= innerHeight) continue;
            for (const match of getComputedStyle(element).backgroundImage.matchAll(/url\(["']?(.*?)["']?\)/g)) backgrounds.add(match[1]!);
          }
          await Promise.all(Array.from(backgrounds).map(async src => {
            const image = new Image(); image.src = src;
            await bounded(image.decode());
          }));
          for (const video of Array.from(document.querySelectorAll('video'))) {
            const box = video.getBoundingClientRect();
            if (box.bottom > 0 && box.top < innerHeight && box.width > 0) {
              video.preload = 'auto';
              if (video.readyState < 2) await bounded(new Promise<void>((resolve, reject) => {
                video.addEventListener('loadeddata', () => resolve(), { once: true });
                video.addEventListener('error', () => reject(new Error('Video load failed')), { once: true });
                video.load();
              }));
              video.pause();
              await bounded(new Promise<void>(resolve => {
                video.addEventListener('seeked', () => resolve(), { once: true });
                video.currentTime = Math.min(2, video.duration / 2);
              }));
            } else video.pause();
          }
          for (const animation of document.getAnimations()) {
            const end = animation.effect?.getComputedTiming().endTime;
            if (end !== undefined && Number.isFinite(end)) animation.finish(); else animation.pause();
          }
          window.scrollTo(0, 0);
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          })()]).finally(() => clearTimeout(timer));
        });
        const selector = manifest.readable.thumbnail?.selector ?? (type === 'deck' ? '.slide, [data-slide]' : undefined);
        let capture = await page.screenshot({ animations: 'disabled' });
        if (selector && await page.locator(selector).count()) {
          const target = page.locator(selector).first();
          const box = await target.boundingBox();
          if (box && box.width > 300 && box.height > 200) capture = await target.screenshot({ animations: 'disabled' });
        }
        const image = sharp(capture);
        const buffer = type === 'deck' ? await image.resize(480, 270, { fit: 'contain' }).webp({ quality: 80 }).toBuffer() : await image.resize({ width: 480 }).webp({ quality: 80 }).toBuffer();
        if (buffer.length > 81920) throw new Error(`Over 80 KiB budget: ${buffer.length}`);
        if (buffer.length < 1500) throw new Error(`Suspiciously empty capture: ${buffer.length} bytes`);
        await writeFile(path.join(evidence, `${manifest.name}.png`), capture);
        await writeFile(path.join(out, `${manifest.name}.webp`), buffer);
        const raw = await readFile(file, 'utf8');
        const thumb = { ...manifest.readable.thumbnail, src: `/template-thumbnails/${manifest.name}.webp` };
        const next = manifest.readable.thumbnail ? raw.replace(/"thumbnail": \{[^}]*\}/, `"thumbnail": ${JSON.stringify(thumb)}`) : raw.replace(/("hubType": "[^"]+",)/, `$1\n    "thumbnail": ${JSON.stringify(thumb)},`);
        await writeFile(file, next);
        entries.push({ id: manifest.name, type, sourceHash: createHash('sha256').update(html).digest('hex'), bytes: buffer.length });
        console.log(`${manifest.name}: ${buffer.length}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ id: manifest.name, error: message });
        console.error(`${manifest.name}: ${message}`);
        if (!message.includes('No HTML exemplar')) await page.screenshot({ path: path.join(evidence, `${manifest.name}-rejected.png`) });
      }
    }
  } finally { await browser.close(); }
  const previous = ids ? JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8')).entries as typeof entries : [];
  const merged = [...previous.filter(entry => !entries.some(next => next.id === entry.id)), ...entries];
  merged.sort((a, b) => selected.findIndex(({ manifest }) => manifest.name === a.id) - selected.findIndex(({ manifest }) => manifest.name === b.id));
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify({ recipe: 1, entries: merged }, null, 2) + '\n');
  await writeFile(path.join(evidence, 'failures.json'), JSON.stringify(failures, null, 2) + '\n');
  console.log(`Total: ${entries.length} thumbnails, ${entries.reduce((sum, entry) => sum + entry.bytes, 0)} bytes; failures: ${failures.length}`);
  for (const type of ['deck', 'report', 'website']) {
    const group = entries.filter(entry => entry.type === type);
    if (!group.length) continue;
    const columns = 5, cellWidth = 240, cellHeight = type === 'report' ? 330 : 170;
    const layers = [];
    for (let i = 0; i < group.length; i++) {
      const name = group[i]!.id;
      const image = await sharp(path.join(out, `${name}.webp`)).resize(230, cellHeight - 30, { fit: 'contain', background: '#eeeeee' }).png().toBuffer();
      const left = (i % columns) * cellWidth, top = Math.floor(i / columns) * cellHeight;
      layers.push({ input: image, left, top });
      layers.push({ input: Buffer.from(`<svg width="240" height="24"><text x="2" y="16" font-size="9">${name.replace('example-', '')}</text></svg>`), left, top: top + cellHeight - 25 });
    }
    await sharp({ create: { width: columns * cellWidth, height: Math.ceil(group.length / columns) * cellHeight, channels: 3, background: '#eeeeee' } }).composite(layers).png().toFile(path.join(evidence, `${type}.png`));
  }
  if (failures.length) process.exitCode = 1;
}
