// Runtime wiring for `font-embed.ts`: turns the pure embedder into a
// one-call helper backed by the real system-font enumeration and the
// filesystem. Kept separate so `font-embed.ts` stays fs/registry-free and
// unit-testable. Used by both export paths — the single-file HTML export
// (`import-export-routes.ts`, `?inline=1`) and deploy (`deploy.ts`).

import { readFile, stat } from 'node:fs/promises';

import { MAX_SYSTEM_FONT_FACE_BYTES, embedSystemFonts, type EmbedFontsOptions, type EmbedFontsResult } from './font-embed.js';
import { indexFamiliesByName, listSystemFonts } from './system-fonts.js';

/**
 * Embed every installed non-web-safe font a design uses into `html`.
 * `extraCss` is any linked stylesheet the caller bundles separately (the
 * deploy path) so fonts used only there are still embedded. No-op (returns
 * the HTML unchanged) when enumeration is unsupported or finds nothing — so
 * callers can always run it unconditionally.
 */
export async function embedUsedSystemFonts(
  html: string,
  extraCss: string[] = [],
  opts: { maxTotalBytes?: number } = {},
): Promise<EmbedFontsResult> {
  const { fonts, platform } = await listSystemFonts();
  if (platform !== 'win32' || fonts.length === 0) {
    return { html, embedded: [], skipped: [] };
  }
  const index = indexFamiliesByName(fonts);
  const embedOpts: EmbedFontsOptions = { extraCss };
  if (opts.maxTotalBytes !== undefined) embedOpts.maxTotalBytes = opts.maxTotalBytes;
  return embedSystemFonts(html, {
    resolveFamily: (name) => index.get(name.toLowerCase()),
    // stat-guard: skip oversized faces (e.g. large CJK fonts) before a big
    // readFile, matching the inliner's cheap-stat-first discipline.
    readFontBytes: async (p) => {
      try {
        const s = await stat(p);
        if (!s.isFile() || s.size > MAX_SYSTEM_FONT_FACE_BYTES) return null;
        return await readFile(p);
      } catch {
        return null;
      }
    },
  }, embedOpts);
}
