import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  bundleStandaloneHtml,
  MAX_STANDALONE_HTML_BYTES,
  MAX_STANDALONE_READ_CONCURRENCY,
  StandaloneHtmlLimitError,
  type StandaloneSource,
} from '../src/standalone-html.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function source(html: string, files: Record<string, string | Buffer>): StandaloneSource {
  return {
    html,
    entryPath: 'index.html',
    resolve: async (reference, ownerPath) => {
      const resolved = path.posix.normalize(reference.startsWith('/')
        ? reference.slice(1)
        : path.posix.join(path.posix.dirname(ownerPath), reference));
      const value = files[resolved];
      if (value === undefined || resolved === '..' || resolved.startsWith('../')) return null;
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const ext = path.posix.extname(resolved);
      const mime = ({
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
        '.gif': 'image/gif', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
      } as Record<string, string>)[ext] ?? 'text/javascript';
      return { path: resolved, mime, size: bytes.length, read: async () => bytes };
    },
  };
}

describe('bundleStandaloneHtml', () => {
  it('recursively bundles stylesheets, imports, inline CSS, images, and fonts', async () => {
    const report = await bundleStandaloneHtml(source(
      '<!doctype html><html><head><link rel="stylesheet" href="styles/main.css"></head>' +
        '<body style="background:url(./images/a.png)"><style>.hero{background:url(images/a.png)}</style></body></html>',
      {
        'styles/main.css': '@import url(nested/theme.css) screen;@font-face{font-family:X;src:url(../fonts/x.woff2)}',
        'styles/nested/theme.css': '.theme{background:url(../../images/a.png)}',
        'images/a.png': PNG,
        'fonts/x.woff2': Buffer.from('font'),
      },
    ));

    expect(report.html).toContain('data-readable-bundled-from="styles/main.css"');
    expect(report.html).toContain('@media screen');
    expect(report.html.match(/data:image\/png;base64,/g)?.length).toBeGreaterThanOrEqual(3);
    expect(report.html).toContain('data:font/woff2;base64,');
    expect(report.missingLocalReferences).toEqual([]);
  });

  it('bundles static and dynamic ES module imports into one inline module', async () => {
    const report = await bundleStandaloneHtml(source(
      '<!doctype html><script type="module" src="main.js"></script>',
      {
        'main.js': 'import { value } from "./dep.js"; window.STATIC = value; import("./lazy.js").then(x => window.LAZY = x.lazy);',
        'dep.js': 'export const value = "STATIC_MARKER";',
        'lazy.js': 'export const lazy = "LAZY_MARKER";',
      },
    ));

    expect(report.html).not.toContain('src="main.js"');
    expect(report.html).toContain('STATIC_MARKER');
    expect(report.html).toContain('LAZY_MARKER');
    expect(report.html).not.toMatch(/import\(["']\.\/lazy\.js/);
  });

  it('embeds media attributes and preserves srcset descriptors and SVG fragments', async () => {
    const report = await bundleStandaloneHtml(source(
      '<!doctype html><img srcset="a.png 1x, b.png 2x"><video poster="sprite.svg#hero"><source src="movie.png"></video>',
      { 'a.png': PNG, 'b.png': PNG, 'sprite.svg': '<svg/>', 'movie.png': PNG },
    ));
    expect(report.html).toMatch(/srcset="data:image\/png;base64,[^"]+ 1x, data:image\/png;base64,[^"]+ 2x"/);
    expect(report.html).toContain('data:image/svg+xml;base64,');
    expect(report.html).toContain('#hero');
    expect(report.html).toContain('<source src="data:image/png;base64,');
  });

  it('keeps the candidate after a descriptorless data URL in srcset', async () => {
    const report = await bundleStandaloneHtml(source(
      '<!doctype html><img srcset="data:image/png;base64,AA==, next.png 2x">',
      { 'next.png': PNG },
    ));
    expect(report.html).toContain('data:image/png;base64,AA==, data:image/png;base64,');
    expect(report.html).toContain(' 2x');
  });

  it('embeds every supported HTML asset attribute and removes stale fetch metadata', async () => {
    const html = '<!doctype html><head><link rel="icon" href="a.jpg"><link rel="apple-touch-icon" href="a.webp">' +
      '<link rel="mask-icon" href="a.svg"><link rel="preload" href="a.gif"><link rel="modulepreload" href="a.js">' +
      '<link rel="preload" href="https://cdn.example/a.js"></head><body>' +
      '<img src="a.jpg" integrity="old" crossorigin><source src="a.webp"><video src="a.gif" poster="a.svg"></video>' +
      '<audio src="a.gif"></audio><track src="a.gif"><input type="image" src="a.gif"><object data="a.svg"></object>' +
      '<embed src="a.gif"><svg><image href="a.svg" xlink:href="a.svg"></image></svg></body>';
    const report = await bundleStandaloneHtml(source(html, {
      'a.jpg': Buffer.from('jpg'), 'a.webp': Buffer.from('webp'), 'a.gif': Buffer.from('gif'),
      'a.svg': '<svg/>', 'a.js': 'export const ok = true;',
    }));

    expect(report.html).toContain('data:image/jpeg;base64,');
    expect(report.html).toContain('data:image/webp;base64,');
    expect(report.html).toContain('data:image/gif;base64,');
    expect(report.html).toContain('data:image/svg+xml;base64,');
    expect(report.html).not.toContain('integrity="old"');
    expect(report.html).not.toMatch(/<link rel="(?:module)?preload" href="a\./);
    expect(report.html).toContain('https://cdn.example/a.js');
    expect(report.externalReferences).toContain('https://cdn.example/a.js');
  });

  it('inlines classic scripts safely and keeps execution attributes', async () => {
    const report = await bundleStandaloneHtml(source(
      '<!doctype html><script src="classic.js" async defer nomodule integrity="old" crossorigin></script>',
      { 'classic.js': 'window.marker = "</script><p>not markup</p>";' },
    ));
    expect(report.html).toContain('async');
    expect(report.html).toContain('defer');
    expect(report.html).toContain('nomodule');
    expect(report.html).not.toContain('src="classic.js"');
    expect(report.html).not.toContain('integrity="old"');
    expect(report.html).toContain('<\\/script');
  });

  it('preserves and reports external and missing references without fetching them', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const report = await bundleStandaloneHtml(source(
      '<!doctype html><img src="https://example.com/a.png"><img src="missing.png"><script src="//cdn.example/x.js"></script><img src="file:///tmp/a.png"><img src="blob:test">',
      {},
    ));
    expect(report.html).toContain('https://example.com/a.png');
    expect(report.html).toContain('missing.png');
    expect(report.externalReferences).toEqual(['//cdn.example/x.js', 'https://example.com/a.png', 'file:///tmp/a.png', 'blob:test']);
    expect(report.missingLocalReferences).toEqual(['missing.png']);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('bundles module-imported CSS and binary assets', async () => {
    const report = await bundleStandaloneHtml(source(
      '<!doctype html><script type="module" src="main.js"></script>',
      {
        'main.js': 'import "./main.css"; import logo from "./logo.png"; window.LOGO = logo;',
        'main.css': '.hero{background:url(./logo.png)}',
        'logo.png': PNG,
      },
    ));
    expect(report.html).toContain('data-readable-bundled-module-css');
    expect(report.html.match(/data:image\/png;base64,/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('preserves a cyclic CSS import and reports it once', async () => {
    const report = await bundleStandaloneHtml(source(
      '<!doctype html><link rel="stylesheet" href="styles/a.css">',
      { 'styles/a.css': '@import "b.css";.a{}', 'styles/b.css': '@import "a.css";.b{}' },
    ));
    expect(report.html).toContain('@import "a.css"');
    expect(report.missingLocalReferences).toEqual(['a.css']);
  });

  it('does not treat references inside unclosed CSS comments or strings as assets', async () => {
    const resolve = vi.fn(async () => null);
    await bundleStandaloneHtml({
      html: '<!doctype html><style>/* url(secret.png)</style><div style="content:\'url(other.png)"></div>',
      entryPath: 'index.html',
      resolve,
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('deduplicates equivalent missing local paths and ignores embedded references for the candidate limit', async () => {
    const report = await bundleStandaloneHtml(source(
      `<!doctype html>${'<img src="data:image/png;base64,AA==">'.repeat(501)}<img src="./missing.png"><img src="missing.png">`,
      {},
    ));
    expect(report.missingLocalReferences).toEqual(['./missing.png']);
  });

  it('strips query strings for lookup, preserves SVG fragments, and leaves data URIs unchanged', async () => {
    const embedded = 'data:image/png;base64,AA==';
    const report = await bundleStandaloneHtml(source(
      `<!doctype html><img src="${embedded}"><img src="sprite.svg?v=1#icon">`,
      { 'sprite.svg': '<svg/>' },
    ));
    expect(report.html).toContain(embedded);
    expect(report.html).toContain('data:image/svg+xml;base64,');
    expect(report.html).toContain('#icon');
    expect(report.html).not.toContain('?v=1');
  });

  it('keeps unresolved module imports external and reports the local dependency', async () => {
    const report = await bundleStandaloneHtml(source(
      '<!doctype html><script type="module">import value from "./missing.js"; window.VALUE = value;</script>',
      {},
    ));
    expect(report.html).toContain('./missing.js');
    expect(report.missingLocalReferences).toEqual(['./missing.js']);
  });

  it('preserves a local reference when the file cannot be read', async () => {
    const failing: StandaloneSource = {
      html: '<!doctype html><img src="broken.png">',
      entryPath: 'index.html',
      resolve: async () => ({
        path: 'broken.png',
        mime: 'image/png',
        size: 1,
        read: async () => { throw new Error('unreadable'); },
      }),
    };
    const report = await bundleStandaloneHtml(failing);
    expect(report.html).toContain('src="broken.png"');
    expect(report.missingLocalReferences).toEqual(['broken.png']);
  });

  it('applies and removes a local base href', async () => {
    const report = await bundleStandaloneHtml(source(
      '<!doctype html><base href="assets/"><img src="logo.png">',
      { 'assets/logo.png': PNG },
    ));
    expect(report.html).not.toContain('<base');
    expect(report.html).toContain('src="data:image/png;base64,');
  });

  it('enforces the 500-reference ceiling', async () => {
    const html = `<!doctype html>${'<img src="missing.png">'.repeat(501)}`;
    await expect(bundleStandaloneHtml(source(html, {}))).rejects.toBeInstanceOf(StandaloneHtmlLimitError);
  });

  it('rejects an oversized asset before reading it', async () => {
    const read = vi.fn(async () => Buffer.alloc(0));
    const oversized: StandaloneSource = {
      html: '<!doctype html><img src="huge.png">',
      entryPath: 'index.html',
      resolve: async () => ({ path: 'huge.png', mime: 'image/png', size: MAX_STANDALONE_HTML_BYTES + 1, read }),
    };
    await expect(bundleStandaloneHtml(oversized)).rejects.toBeInstanceOf(StandaloneHtmlLimitError);
    expect(read).not.toHaveBeenCalled();
  });

  it('preserves module graph size errors as payload limits', async () => {
    const oversized: StandaloneSource = {
      html: '<!doctype html><script type="module">import "./huge.js"</script>',
      entryPath: 'index.html',
      resolve: async () => ({
        path: 'huge.js',
        mime: 'text/javascript',
        size: MAX_STANDALONE_HTML_BYTES + 1,
        read: async () => Buffer.alloc(0),
      }),
    };
    await expect(bundleStandaloneHtml(oversized)).rejects.toBeInstanceOf(StandaloneHtmlLimitError);
  });

  it('rejects a module data URL that projects above 100 MiB before reading it', async () => {
    const imageRead = vi.fn(async () => Buffer.alloc(0));
    const moduleSource: StandaloneSource = {
      html: '<!doctype html><script type="module">import image from "./huge.png"; window.image = image;</script>',
      entryPath: 'index.html',
      resolve: async (reference) => reference === './huge.png'
        ? { path: 'huge.png', mime: 'image/png', size: 79 * 1024 * 1024, read: imageRead }
        : null,
    };
    await expect(bundleStandaloneHtml(moduleSource)).rejects.toBeInstanceOf(StandaloneHtmlLimitError);
    expect(imageRead).not.toHaveBeenCalled();
  });

  it('checks the bytes returned by a source instead of trusting its size hint', async () => {
    const mismatched: StandaloneSource = {
      html: '<!doctype html><script src="huge.js"></script>',
      entryPath: 'index.html',
      resolve: async () => ({
        path: 'huge.js',
        mime: 'text/javascript',
        size: 1,
        read: async () => Buffer.alloc(MAX_STANDALONE_HTML_BYTES + 1),
      }),
    };
    await expect(bundleStandaloneHtml(mismatched)).rejects.toBeInstanceOf(StandaloneHtmlLimitError);
  });

  it('rejects aggregate data-URI expansion above 100 MiB after one deduplicated read', async () => {
    const bytes = Buffer.alloc(170 * 1024);
    const read = vi.fn(async () => bytes);
    const aggregate: StandaloneSource = {
      html: `<!doctype html>${'<img src="same.bin">'.repeat(500)}`,
      entryPath: 'index.html',
      resolve: async () => ({ path: 'same.bin', mime: 'application/octet-stream', size: bytes.length, read }),
    };
    await expect(bundleStandaloneHtml(aggregate)).rejects.toBeInstanceOf(StandaloneHtmlLimitError);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('rejects the next aggregate classic script before reading it', async () => {
    const bytes = Buffer.alloc(60 * 1024 * 1024, 0x20);
    const reads: string[] = [];
    const aggregate: StandaloneSource = {
      html: '<!doctype html><script src="a.js"></script><script src="b.js"></script>',
      entryPath: 'index.html',
      resolve: async (reference) => ({
        path: reference,
        mime: 'text/javascript',
        size: bytes.length,
        read: async () => {
          reads.push(reference);
          return bytes;
        },
      }),
    };
    await expect(bundleStandaloneHtml(aggregate)).rejects.toBeInstanceOf(StandaloneHtmlLimitError);
    expect(reads).toEqual(['a.js']);
  });

  it('accepts a classic-script result immediately below 100 MiB', async () => {
    const bytes = Buffer.alloc(MAX_STANDALONE_HTML_BYTES - 1024, 0x20);
    const report = await bundleStandaloneHtml({
      html: '<!doctype html><script src="large.js"></script>',
      entryPath: 'index.html',
      resolve: async () => ({
        path: 'large.js',
        mime: 'text/javascript',
        size: bytes.length,
        read: async () => bytes,
      }),
    });
    expect(report.outputBytes).toBeLessThan(MAX_STANDALONE_HTML_BYTES);
  }, 60_000);

  it('reads each file once and never exceeds eight concurrent reads', async () => {
    let active = 0;
    let peak = 0;
    const reads = new Map<string, number>();
    const concurrencySource: StandaloneSource = {
      html: '<!doctype html><script type="module" src="main.js"></script>',
      entryPath: 'index.html',
      resolve: async (reference, ownerPath) => {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(ownerPath), reference));
        if (resolved !== 'main.js' && !/^dep\d+\.js$/.test(resolved)) return null;
        const body = resolved === 'main.js'
          ? Array.from({ length: 16 }, (_, index) => `import "./dep${index}.js";`).join('')
          : `window["${resolved}"] = true;`;
        return {
          path: resolved,
          mime: 'text/javascript',
          size: Buffer.byteLength(body),
          read: async () => {
            reads.set(resolved, (reads.get(resolved) ?? 0) + 1);
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
            active -= 1;
            return Buffer.from(body);
          },
        };
      },
    };
    await bundleStandaloneHtml(concurrencySource);
    expect(peak).toBeLessThanOrEqual(MAX_STANDALONE_READ_CONCURRENCY);
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
  });
});
