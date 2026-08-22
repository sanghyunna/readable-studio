// Shared DTOs for `GET /api/system/fonts`. The daemon enumerates the
// fonts installed on the local machine so the manual-edit typography
// picker can offer every installed family (not just a curated web-safe
// subset) and the export/deploy pipeline can base64-embed the ones a
// design actually uses.
//
// Enumeration is Windows-only today (reads the font registry). On other
// platforms the endpoint returns `{ fonts: [], platform: 'unsupported' }`
// and the UI falls back to the curated font list — see
// `apps/daemon/src/system-fonts.ts`.

/**
 * Bumped when the response shape changes incompatibly. Also serves as a
 * real runtime export so esbuild emits a module for this file (a
 * type-only module cannot be re-exported from the package root under
 * NodeNext resolution — see `handoff.ts`).
 */
export const FONTS_CONTRACT_VERSION = 1;

/** Font container formats we know how to embed as an `@font-face src`. */
export type SystemFontFormat = 'truetype' | 'opentype' | 'woff' | 'woff2' | 'collection';

export type SystemFontsPlatform = 'win32' | 'darwin' | 'linux' | 'unsupported';

/**
 * One concrete font file (a single weight/style face). `path` is an
 * absolute path on the machine running the daemon; the embed step reads
 * these bytes directly, so it never crosses the HTTP boundary as data.
 */
export interface SystemFontFace {
  path: string;
  /** CSS numeric weight, 100–900. Regular is 400, Bold is 700. */
  weight: number;
  style: 'normal' | 'italic';
  format: SystemFontFormat;
}

/**
 * A pickable family. The Regular/Bold/Italic/Bold-Italic quartet of a
 * family is collapsed into one entry (so the toolbar's weight/italic
 * controls select between faces); specialty weights the OS ships under a
 * distinct name (e.g. "Segoe UI Light") stay their own family.
 */
export interface SystemFontFamily {
  /** Display name and the exact value written to `font-family`. */
  family: string;
  faces: SystemFontFace[];
}

/** Response body for `GET /api/system/fonts`. */
export interface SystemFontsResponse {
  fonts: SystemFontFamily[];
  platform: SystemFontsPlatform;
}
