#!/usr/bin/env node
// Generate every raster brand icon from the single master SVG.
//
// `apps/web/public/app-icon.svg` is the ONLY hand-authored brand asset. It is
// the white rounded-plate mark (transparent outside the corner radius). This
// script rasterises it into the binaries that used to be hand-synced and drift:
//
//   apps/web/public/app-icon.png       1024x1024 RGBA
//   apps/web/public/logo.png           byte-identical copy
//   docs/assets/logo.png               byte-identical copy
//   tools/pack/resources/win/icon.ico  16/32/48/64/128/256, PNG-encoded, 32bpp
//
// The pre-plate transparent originals (`app-icon-transparent.svg` / `.png`) are
// NOT touched here — they are kept verbatim for surfaces that need a bare mark.
// `apps/web/public/logo.svg` and `brand-icon.svg` are byte copies of the master
// and are refreshed here too, so all three vector files can never diverge.
//
// The root command boundary in AGENTS.md reserves root scripts for repo-level
// checks, tool control planes and repo-level generators; this is the last of
// those (same class as `bake:community-pets` / `seed:*`), and the assets it
// writes span apps/web, docs and tools/pack, so no single workspace package
// owns it.
//
// Run:
//   pnpm bake:brand-icons
//   node --experimental-strip-types scripts/generate-brand-icons.ts   # no pnpm
//   pnpm exec tsx scripts/generate-brand-icons.ts                     # via tsx
//
// Flags:
//   --check   Verify the outputs are already up to date; write nothing and
//             exit non-zero if any file would change.
//
// Idempotent: rasterisation is deterministic, so a clean re-run rewrites the
// same bytes. Files whose bytes already match are left untouched on disk.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The single hand-authored source of truth. */
const MASTER_SVG = 'apps/web/public/app-icon.svg';

/** Vector copies kept byte-identical to the master. */
const SVG_COPIES = ['apps/web/public/logo.svg', 'apps/web/public/brand-icon.svg'] as const;

/** 1024x1024 RGBA outputs. The first is the canonical one; the rest are copies. */
const PNG_OUTPUTS = [
  'apps/web/public/app-icon.png',
  'apps/web/public/logo.png',
  'docs/assets/logo.png',
] as const;

const PNG_SIZE = 1024;

const ICO_OUTPUT = 'tools/pack/resources/win/icon.ico';

/** Matches the size set of the previously hand-authored ICO. */
const ICO_SIZES = [16, 32, 48, 64, 128, 256] as const;

const ICO_DIRECTORY_ENTRY_BYTES = 16;
const ICO_HEADER_BYTES = 6;
const ICO_TYPE_ICON = 1;
const ICO_BITS_PER_PIXEL = 32;

async function renderPng(svg: Buffer, size: number): Promise<Buffer> {
  return sharp(svg, { density: (72 * size) / 48 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}

/**
 * Assemble a PNG-encoded ICO. Windows Vista+ reads PNG payloads directly, which
 * is what the existing `icon.ico` already used for all six sizes.
 */
function buildIco(images: readonly { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(ICO_HEADER_BYTES);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(ICO_TYPE_ICON, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(images.length * ICO_DIRECTORY_ENTRY_BYTES);
  let offset = ICO_HEADER_BYTES + directory.length;

  images.forEach((image, index) => {
    const entry = index * ICO_DIRECTORY_ENTRY_BYTES;
    // 256 is encoded as 0 in the single-byte width/height fields.
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry);
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1);
    directory.writeUInt8(0, entry + 2); // palette colours: none for 32bpp
    directory.writeUInt8(0, entry + 3); // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(ICO_BITS_PER_PIXEL, entry + 6);
    directory.writeUInt32LE(image.png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

async function readIfPresent(absolutePath: string): Promise<Buffer | null> {
  try {
    return await readFile(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Writes only when bytes differ. Returns true when the file changed. */
async function writeIfChanged(
  repositoryPath: string,
  contents: Buffer,
  checkOnly: boolean,
): Promise<boolean> {
  const absolutePath = path.join(repoRoot, repositoryPath);
  const current = await readIfPresent(absolutePath);
  if (current && current.equals(contents)) {
    console.log(`up to date  ${repositoryPath}`);
    return false;
  }
  if (checkOnly) {
    console.error(`STALE       ${repositoryPath}`);
    return true;
  }
  await writeFile(absolutePath, contents);
  console.log(`wrote       ${repositoryPath} (${contents.length} bytes)`);
  return true;
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  const master = await readFile(path.join(repoRoot, MASTER_SVG));

  let changed = false;

  for (const copy of SVG_COPIES) {
    changed = (await writeIfChanged(copy, master, checkOnly)) || changed;
  }

  const masterPng = await renderPng(master, PNG_SIZE);
  for (const output of PNG_OUTPUTS) {
    changed = (await writeIfChanged(output, masterPng, checkOnly)) || changed;
  }

  const icoImages = await Promise.all(
    ICO_SIZES.map(async (size) => ({ size, png: await renderPng(master, size) })),
  );
  changed = (await writeIfChanged(ICO_OUTPUT, buildIco(icoImages), checkOnly)) || changed;

  if (checkOnly && changed) {
    console.error(`\nBrand icons are stale. Run: pnpm bake:brand-icons`);
    process.exitCode = 1;
    return;
  }
  console.log(changed ? '\nBrand icons regenerated.' : '\nBrand icons already up to date.');
}

await main();
