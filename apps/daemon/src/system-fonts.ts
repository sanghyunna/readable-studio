// System font enumeration for the manual-edit typography picker and the
// export/deploy font-embed step (`font-embed.ts`).
//
// Windows-only by design: this product ships Windows-native, and the
// Windows font registry is an authoritative name -> file map, so we can
// enumerate every installed family without a font-parsing dependency.
// On macOS/Linux `listSystemFonts()` returns an empty list with
// `platform: 'unsupported'`; the picker then falls back to the curated
// web-safe list and the embed step is a no-op. Adding those platforms is
// an additive follow-up (scan the OS font dirs + parse name tables).
//
// Family names are a *closed loop*: the same derived name is written to
// `font-family` by the picker and matched by the embedder, so heuristic
// imperfection in `parseFaceName` only affects how nicely faces group —
// never whether an embed resolves.

import { spawn } from 'node:child_process';
import path from 'node:path';

import type {
  SystemFontFace,
  SystemFontFamily,
  SystemFontFormat,
  SystemFontsPlatform,
  SystemFontsResponse,
} from '@readable-studio/contracts';

const REGISTRY_FONTS_SUBKEY = 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts';

/** Extension -> `@font-face` format() hint. `null` = not embeddable (e.g. .fon bitmap fonts). */
export function fontFormatFromPath(filePath: string): SystemFontFormat | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ttf':
      return 'truetype';
    case '.otf':
      return 'opentype';
    case '.ttc':
    case '.otc':
      return 'collection';
    case '.woff':
      return 'woff';
    case '.woff2':
      return 'woff2';
    default:
      return null;
  }
}

// Trailing style descriptors we collapse into a single family so the
// toolbar's weight/italic controls select between faces. Order matters:
// longest phrase first. Everything NOT listed here (Light, Semibold,
// Black, Medium, Narrow, ...) stays part of the family name, i.e. its own
// pickable entry — conservative grouping avoids surprising merges.
const FACE_STYLE_RULES: { re: RegExp; weight: number; style: 'normal' | 'italic' }[] = [
  { re: /\s+(?:bold\s+italic|italic\s+bold|bold\s+oblique)$/i, weight: 700, style: 'italic' },
  { re: /\s+bold$/i, weight: 700, style: 'normal' },
  { re: /\s+(?:italic|oblique)$/i, weight: 400, style: 'italic' },
  { re: /\s+(?:regular|normal|book)$/i, weight: 400, style: 'normal' },
];

/**
 * Split a registry display name (already stripped of its `(TrueType)`
 * suffix) into a grouping family plus the weight/style of this face.
 */
export function parseFaceName(displayName: string): {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
} {
  const name = displayName.trim();
  for (const rule of FACE_STYLE_RULES) {
    if (rule.re.test(name)) {
      const family = name.replace(rule.re, '').trim();
      // Guard: never strip the name down to nothing ("Italic" alone is a family).
      if (family) return { family, weight: rule.weight, style: rule.style };
    }
  }
  return { family: name, weight: 400, style: 'normal' };
}

/** A single registry Fonts value, already resolved to an absolute file path. */
export interface RawFontEntry {
  /** Registry value name, e.g. `Arial Bold (TrueType)`. */
  name: string;
  /** Absolute path to the font file. */
  path: string;
}

const PAREN_SUFFIX = /\s*\([^)]*\)\s*$/; // " (TrueType)", " (OpenType)", ...

/**
 * Turn a raw registry map (value name -> file, possibly bare filename)
 * into resolved entries: strips the `(TrueType)` suffix, splits TrueType
 * Collections (`Cambria & Cambria Math`) into one entry per face sharing
 * the file, resolves bare filenames against the Windows fonts dir, and
 * drops non-embeddable formats.
 */
export function parseRegistryEntries(
  raw: Record<string, string>,
  fontsDir: string,
): RawFontEntry[] {
  const out: RawFontEntry[] = [];
  for (const [rawName, rawFile] of Object.entries(raw)) {
    if (!rawName || !rawFile) continue;
    if (!fontFormatFromPath(rawFile)) continue; // skip .fon and unknowns
    const absPath = path.win32.isAbsolute(rawFile) ? rawFile : path.win32.join(fontsDir, rawFile);
    const stripped = rawName.replace(PAREN_SUFFIX, '').trim();
    if (!stripped) continue;
    // TrueType Collection: one file, several named faces joined by " & ".
    for (const part of stripped.split(' & ')) {
      const name = part.trim();
      if (name) out.push({ name, path: absPath });
    }
  }
  return out;
}

/** Group resolved entries into pickable families with deduped faces, sorted. */
export function buildFontFamilies(entries: RawFontEntry[]): SystemFontFamily[] {
  const byKey = new Map<string, SystemFontFamily>();
  for (const entry of entries) {
    const format = fontFormatFromPath(entry.path);
    if (!format) continue;
    const { family, weight, style } = parseFaceName(entry.name);
    const key = family.toLowerCase();
    let fam = byKey.get(key);
    if (!fam) {
      fam = { family, faces: [] };
      byKey.set(key, fam);
    }
    const face: SystemFontFace = { path: entry.path, weight, style, format };
    // Dedupe by weight+style; first registry hit wins.
    if (!fam.faces.some((f) => f.weight === face.weight && f.style === face.style)) {
      fam.faces.push(face);
    }
  }
  const families = [...byKey.values()];
  for (const fam of families) {
    // normal before italic within a weight.
    fam.faces.sort((a, b) => a.weight - b.weight || (a.style === b.style ? 0 : a.style === 'normal' ? -1 : 1));
  }
  families.sort((a, b) => a.family.localeCompare(b.family, undefined, { sensitivity: 'base' }));
  return families;
}

function windowsFontsDir(): string {
  const winDir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  return path.win32.join(winDir, 'Fonts');
}

// Force UTF-8 stdout so non-ASCII font names (CJK, etc.) survive: PS 5.1
// otherwise writes them in the console codepage and Node's utf8 read mangles
// them (verified against real Korean font names). Get-Item + GetValueNames
// avoids the PS* metadata noise Get-ItemProperty adds.
function buildEnumerationScript(): string {
  return [
    "$ErrorActionPreference='Stop'",
    '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)',
    'function Read-FontKey($path){',
    '  $out=@{}',
    '  if(Test-Path -LiteralPath $path){',
    '    $k=Get-Item -LiteralPath $path',
    '    foreach($n in $k.GetValueNames()){ if($n){ $out[$n]=[string]$k.GetValue($n) } }',
    '  }',
    '  return $out',
    '}',
    "$res=@{ hklm=Read-FontKey 'HKLM:\\" + REGISTRY_FONTS_SUBKEY + "'; hkcu=Read-FontKey 'HKCU:\\" + REGISTRY_FONTS_SUBKEY + "' }",
    '$res | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');
}

function runPowerShell(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // -EncodedCommand (UTF-16LE base64) sidesteps all shell quoting of the script.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`powershell font enumeration timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`powershell exited ${code}: ${stderr.trim() || 'no stderr'}`));
    });
  });
}

async function enumerateWindowsFonts(timeoutMs: number): Promise<SystemFontFamily[]> {
  const stdout = await runPowerShell(buildEnumerationScript(), timeoutMs);
  const trimmed = stdout.replace(/^﻿/, '').trim(); // drop any UTF-8 BOM
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as { hklm?: Record<string, string>; hkcu?: Record<string, string> };
  const fontsDir = windowsFontsDir();
  const entries = [
    ...parseRegistryEntries(parsed.hklm ?? {}, fontsDir),
    ...parseRegistryEntries(parsed.hkcu ?? {}, fontsDir),
  ];
  return buildFontFamilies(entries);
}

function currentPlatform(): SystemFontsPlatform {
  switch (process.platform) {
    case 'win32':
      return 'win32';
    case 'darwin':
      return 'darwin';
    case 'linux':
      return 'linux';
    default:
      return 'unsupported';
  }
}

let cached: Promise<SystemFontsResponse> | null = null;

async function computeSystemFonts(timeoutMs: number): Promise<SystemFontsResponse> {
  const platform = currentPlatform();
  if (platform !== 'win32') {
    // ponytail: macOS/Linux enumeration is a follow-up; return a graceful
    // empty so the picker falls back to curated fonts instead of erroring.
    return { fonts: [], platform };
  }
  try {
    const fonts = await enumerateWindowsFonts(timeoutMs);
    return { fonts, platform: 'win32' };
  } catch (err) {
    console.warn('[system-fonts] enumeration failed:', (err as Error)?.message || err);
    return { fonts: [], platform: 'win32' };
  }
}

/**
 * List fonts installed on the machine running the daemon. Result is cached
 * for the daemon lifetime (fonts rarely change mid-session); pass
 * `refresh: true` to rescan after installing a font.
 */
export function listSystemFonts(opts: { refresh?: boolean; timeoutMs?: number } = {}): Promise<SystemFontsResponse> {
  if (opts.refresh) cached = null;
  if (!cached) {
    cached = computeSystemFonts(opts.timeoutMs ?? 15_000).catch((err) => {
      cached = null; // don't cache a hard failure; let the next call retry
      throw err;
    });
  }
  return cached;
}

/**
 * Case-insensitive family lookup index for the embed step. Built from a
 * `SystemFontsResponse` so callers can share one enumeration.
 */
export function indexFamiliesByName(fonts: SystemFontFamily[]): Map<string, SystemFontFamily> {
  const index = new Map<string, SystemFontFamily>();
  for (const fam of fonts) index.set(fam.family.toLowerCase(), fam);
  return index;
}
