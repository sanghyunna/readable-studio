import { describe, expect, it } from 'vitest';

import type { SystemFontFamily } from '@readable-studio/contracts';

import {
  collectUsedFontFamilies,
  embedSystemFonts,
  existingFontFaceFamilies,
  primaryFontFamilyToken,
} from '../src/font-embed.js';

describe('primaryFontFamilyToken', () => {
  it('takes the first token, unquoted and decoded', () => {
    expect(primaryFontFamilyToken('"Segoe UI", sans-serif')).toBe('Segoe UI');
    expect(primaryFontFamilyToken("'Foo Bar'")).toBe('Foo Bar');
    expect(primaryFontFamilyToken('Consolas')).toBe('Consolas');
    expect(primaryFontFamilyToken('&quot;Seg UI&quot;, serif')).toBe('Seg UI');
    expect(primaryFontFamilyToken('   ')).toBe('');
  });
});

describe('collectUsedFontFamilies', () => {
  it('finds primary tokens in <style> blocks and inline style attributes', () => {
    const html = `<html><head><style>
      h1 { font-family: "Segoe UI", sans-serif; }
      p  { font-family: Consolas; }
    </style></head><body>
      <div style="font-family: 'Comic Sans MS'; color:red">hi</div>
      <span style='font-family: "Georgia"'>x</span>
    </body></html>`;
    expect(new Set(collectUsedFontFamilies(html))).toEqual(
      new Set(['Segoe UI', 'Consolas', 'Comic Sans MS', 'Georgia']),
    );
  });
});

describe('existingFontFaceFamilies', () => {
  it('collects families already declared with @font-face (lowercased)', () => {
    const html = `<style>@font-face{font-family:'MyBrand';src:url(brand.woff2)}</style>`;
    expect(existingFontFaceFamilies(html).has('mybrand')).toBe(true);
  });
});

function fam(family: string, path: string): SystemFontFamily {
  return { family, faces: [{ path, weight: 400, style: 'normal', format: 'truetype' }] };
}

describe('embedSystemFonts', () => {
  const bytes = Buffer.from('FAKE-FONT-BYTES');
  const readFontBytes = async (p: string) => (p.endsWith('.missing') ? null : bytes);

  it('embeds a used system font and injects an @font-face into <head>', async () => {
    const html = `<html><head><title>t</title></head><body><h1 style="font-family:'Segoe UI'">Hi</h1></body></html>`;
    const resolveFamily = (name: string) =>
      name.toLowerCase() === 'segoe ui' ? fam('Segoe UI', 'C:/f/segoeui.ttf') : undefined;
    const res = await embedSystemFonts(html, { resolveFamily, readFontBytes });
    expect(res.embedded).toEqual(['Segoe UI']);
    expect(res.html).toContain('data-readable-embedded-fonts');
    expect(res.html).toContain("font-family:'Segoe UI'");
    expect(res.html).toContain(`base64,${bytes.toString('base64')}`);
    // Injected before </head>.
    expect(res.html.indexOf('data-readable-embedded-fonts')).toBeLessThan(res.html.indexOf('</head>'));
  });

  it('never embeds web-safe/generic families', async () => {
    const html = `<div style="font-family: Arial, sans-serif">x</div>`;
    const resolveFamily = () => fam('Arial', 'C:/f/arial.ttf'); // even if resolvable, must skip
    const res = await embedSystemFonts(html, { resolveFamily, readFontBytes });
    expect(res.embedded).toEqual([]);
    expect(res.html).toBe(html);
  });

  it('does not double-embed a family already covered by @font-face', async () => {
    const html = `<html><head><style>@font-face{font-family:'MyBrand';src:url(b.woff2)}</style></head><body><p style="font-family:'MyBrand'">x</p></body></html>`;
    const resolveFamily = (name: string) =>
      name.toLowerCase() === 'mybrand' ? fam('MyBrand', 'C:/f/mybrand.ttf') : undefined;
    const res = await embedSystemFonts(html, { resolveFamily, readFontBytes });
    expect(res.embedded).toEqual([]);
  });

  it('skips a face larger than the per-asset cap', async () => {
    const html = `<h1 style="font-family:'Segoe UI'">Hi</h1>`;
    const resolveFamily = () => fam('Segoe UI', 'C:/f/segoeui.ttf');
    const res = await embedSystemFonts(html, { resolveFamily, readFontBytes }, { maxAssetBytes: 4 });
    expect(res.embedded).toEqual([]);
    expect(res.skipped).toEqual(['Segoe UI']);
  });

  it('is a no-op when nothing resolves', async () => {
    const html = `<h1 style="font-family:'Unknown Font'">Hi</h1>`;
    const res = await embedSystemFonts(html, { resolveFamily: () => undefined, readFontBytes });
    expect(res.html).toBe(html);
    expect(res.embedded).toEqual([]);
  });

  it('neutralizes a malicious font name that tries to break out of the <style> block (XSS)', async () => {
    // A locally-installed font whose registry name contains </style><script>.
    const evil = 'X</style><script>alert(1)</script>';
    const html = `<html><head></head><body><h1 style="font-family:'${evil}'">x</h1></body></html>`;
    const resolveFamily = (name: string) =>
      name.toLowerCase() === evil.toLowerCase() ? fam(evil, 'C:/f/evil.ttf') : undefined;
    const res = await embedSystemFonts(html, { resolveFamily, readFontBytes });
    expect(res.embedded).toEqual([evil]); // still embeds — closed loop preserved
    const start = res.html.indexOf('<style data-readable-embedded-fonts>');
    const block = res.html.slice(start, res.html.indexOf('</style>', start) + '</style>'.length);
    // The injected element must contain exactly ONE </style> (its own real close) and no <script>.
    expect(block.match(/<\/style>/gi)?.length).toBe(1);
    expect(block.toLowerCase()).not.toContain('<script>');
  });

  it('embeds a system font referenced only in external (extra) CSS', async () => {
    const html = `<html><head></head><body><p>hi</p></body></html>`; // no font-family in the HTML itself
    const extraCss = ['p { font-family: "Segoe UI", sans-serif; }'];
    const resolveFamily = (name: string) =>
      name.toLowerCase() === 'segoe ui' ? fam('Segoe UI', 'C:/f/segoeui.ttf') : undefined;
    const res = await embedSystemFonts(html, { resolveFamily, readFontBytes }, { extraCss });
    expect(res.embedded).toEqual(['Segoe UI']);
    expect(res.html).toContain("font-family:'Segoe UI'");
  });

  it('embeds a family referenced in two different cases (HTML + extra CSS) only once', async () => {
    const html = `<h1 style="font-family:'Segoe UI'">a</h1>`;
    const extraCss = ['h2 { font-family: segoe ui; }']; // same family, different case
    const resolveFamily = (name: string) =>
      name.toLowerCase() === 'segoe ui' ? fam('Segoe UI', 'C:/f/segoeui.ttf') : undefined;
    const res = await embedSystemFonts(html, { resolveFamily, readFontBytes }, { extraCss });
    expect(res.embedded).toEqual(['Segoe UI']); // once, not twice
    expect((res.html.match(/@font-face/g) || []).length).toBe(1);
  });

  it('stops embedding once the total byte budget is exhausted', async () => {
    const html = `<h1 style="font-family:'Alpha'">a</h1><h2 style="font-family:'Beta'">b</h2>`;
    const families: Record<string, SystemFontFamily> = {
      alpha: fam('Alpha', 'C:/f/a.ttf'),
      beta: fam('Beta', 'C:/f/b.ttf'),
    };
    const resolveFamily = (name: string) => families[name.toLowerCase()];
    const oneFaceBase64 = bytes.toString('base64').length; // budget for exactly one face
    const res = await embedSystemFonts(html, { resolveFamily, readFontBytes }, { maxTotalBytes: oneFaceBase64 });
    expect(res.embedded).toEqual(['Alpha']);
    expect(res.skipped).toEqual(['Beta']);
  });

  it('does not re-embed a family already declared with @font-face in external CSS', async () => {
    const html = `<p style="font-family:'Brand'">x</p>`;
    const extraCss = [`@font-face{font-family:'Brand';src:url(b.woff2)}`];
    const res = await embedSystemFonts(
      html,
      { resolveFamily: () => fam('Brand', 'C:/f/brand.ttf'), readFontBytes },
      { extraCss },
    );
    expect(res.embedded).toEqual([]);
  });
});
