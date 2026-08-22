import type http from 'node:http';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { injectStandaloneDeckKeyDedupe } from '../src/standalone-deck-nav.js';
import { startServer } from '../src/server.js';

function duplicateDeckHtml() {
  return (
    '<!doctype html><html><head></head><body>' +
    '<section class="slide active"></section><section class="slide"></section><section class="slide"></section>' +
    '<script>' +
    'window.idx=0;' +
    'function show(next){window.idx=Math.max(0,Math.min(2,next));}' +
    'function onKey(e){if(e.key==="ArrowRight"){show(window.idx+1);}if(e.key==="ArrowLeft"){show(window.idx-1);}}' +
    'window.addEventListener("keydown",onKey,true);' +
    'document.addEventListener("keydown",onKey,true);' +
    '</script>' +
    '</body></html>'
  );
}

// ---------------------------------------------------------------------------
// HTTP integration — GET /api/projects/:id/export/*?inline=1
// ---------------------------------------------------------------------------

describe('GET /api/projects/:id/export/*?inline=1 route', () => {
  let server: http.Server;
  let baseUrl: string;
  let projectsRoot: string;
  const projectId = 'proj-export-inline-test';

  const cssBody = 'body{color:#0a0}';
  const jsBody = 'window.READABLE_EXPORT_OK = 42;';
  const nestedJsBody = 'export const N = 7;';

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;

    const createProject = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        name: 'Standalone export fixture',
        metadata: { kind: 'prototype' },
        skipDiscoveryBrief: true,
      }),
    });
    expect(createProject.status).toBe(200);

    projectsRoot = path.join(process.env.READABLE_DATA_DIR!, 'projects');
    const dir = path.join(projectsRoot, projectId);
    const pages = path.join(dir, 'pages');
    const shared = path.join(dir, 'shared');
    await mkdir(dir, { recursive: true });
    await mkdir(pages, { recursive: true });
    await mkdir(shared, { recursive: true });

    await writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><html><head>' +
        '<link rel="stylesheet" href="app.css">' +
        '<script src="app.js"></script>' +
        '</head><body><div id="root"></div></body></html>',
    );
    await writeFile(path.join(dir, 'app.css'), cssBody);
    await writeFile(path.join(dir, 'app.js'), jsBody);

    await mkdir(path.join(dir, 'images'), { recursive: true });
    await writeFile(
      path.join(dir, 'image.html'),
      '<!doctype html><html><body><img src="./images/logo.png"></body></html>',
    );
    await writeFile(
      path.join(dir, 'images', 'logo.png'),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
    );
    await writeFile(path.join(dir, 'broken.html'), '<!doctype html><script type="module">export {</script>');
    await mkdir(path.join(dir, 'node_modules', 'fixture-package'), { recursive: true });
    await writeFile(
      path.join(dir, 'node_modules', 'fixture-package', 'package.json'),
      JSON.stringify({ module: './entry.js' }),
    );
    await writeFile(path.join(dir, 'node_modules', 'fixture-package', 'entry.js'), 'export const PACKAGE_MARKER = "BARE_PACKAGE_OK";');
    await writeFile(
      path.join(dir, 'package-module.html'),
      '<!doctype html><script type="module">import { PACKAGE_MARKER } from "fixture-package"; window.PACKAGE_MARKER = PACKAGE_MARKER;</script>',
    );
    await mkdir(path.join(dir, 'node_modules', 'exports-package'), { recursive: true });
    await writeFile(
      path.join(dir, 'node_modules', 'exports-package', 'package.json'),
      JSON.stringify({ module: './legacy-module.js', exports: { '.': { browser: './browser.js', import: './entry.js', default: './fallback.js' } } }),
    );
    await writeFile(path.join(dir, 'node_modules', 'exports-package', 'browser.js'), 'export const marker = "EXPORTS_BROWSER_OK";');
    await writeFile(path.join(dir, 'node_modules', 'exports-package', 'legacy-module.js'), 'export const marker = "LEGACY_MODULE_WRONG";');
    await writeFile(path.join(dir, 'exports-package.html'), '<!doctype html><script type="module">import { marker } from "exports-package"; window.marker = marker;</script>');

    await writeFile(
      path.join(dir, 'partial.html'),
      '<!doctype html><html><head>' +
        '<link rel="stylesheet" href="missing.css">' +
        '<script src="app.js"></script>' +
        '</head><body></body></html>',
    );

    await writeFile(
      path.join(pages, 'index.html'),
      '<!doctype html><html><head>' +
        '<script src="../shared/util.js"></script>' +
        '</head></html>',
    );
    await writeFile(path.join(shared, 'util.js'), nestedJsBody);

    await writeFile(
      path.join(dir, 'deck.html'),
      duplicateDeckHtml(),
    );
  }, 30_000);

  afterAll(() => new Promise<void>((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  }));

  const exportUrl = (name: string, query = 'inline=1') =>
    `${baseUrl}/api/projects/${projectId}/export/${name}${query ? `?${query}` : ''}`;

  it('POST /api/exports/standalone-html embeds a local project image', async () => {
    const res = await fetch(`${baseUrl}/api/exports/standalone-html`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: { kind: 'project', projectId, filePath: 'image.html' },
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('x-readable-studio-external-reference-count')).toBe('0');
    expect(res.headers.get('x-readable-studio-missing-local-reference-count')).toBe('0');
    const body = await res.text();
    expect(body).toContain('src="data:image/png;base64,');
    expect(body).not.toContain('./images/logo.png');
  });

  it('POST standalone export returns exact download/security/summary headers', async () => {
    const res = await fetch(`${baseUrl}/api/exports/standalone-html`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: { kind: 'inline', html: '<!doctype html><img src="https://example.com/a.png"><img src="missing.png">' } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="standalone.html"');
    expect(res.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-readable-studio-external-reference-count')).toBe('1');
    expect(res.headers.get('x-readable-studio-missing-local-reference-count')).toBe('1');
    expect(res.headers.get('x-readable-studio-skipped-system-font-count')).toBe('0');
    const body = await res.text();
    expect(Number(res.headers.get('content-length'))).toBe(Buffer.byteLength(body));
  });

  it('POST standalone export rejects malformed requests, non-HTML files, and invalid modules', async () => {
    const post = (source: unknown) => fetch(`${baseUrl}/api/exports/standalone-html`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    const malformed = await post({ kind: 'project', projectId });
    expect(malformed.status).toBe(400);
    const unsupported = await post({ kind: 'project', projectId, filePath: 'app.css' });
    expect(unsupported.status).toBe(415);
    expect((await post({ kind: 'project', projectId, filePath: '../outside.html' })).status).toBe(400);
    const broken = await post({ kind: 'project', projectId, filePath: 'broken.html' });
    expect(broken.status).toBe(422);
    expect(((await broken.json()) as { error: { code: string } }).error.code).toBe('BUNDLE_FAILED');

    const oversized = await post({ kind: 'inline', html: 'x'.repeat(2 * 1024 * 1024 + 1) });
    expect(oversized.status).toBe(413);
    expect(((await oversized.json()) as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');

    const missingProject = await post({ kind: 'project', projectId: 'missing-project', filePath: 'index.html' });
    expect(missingProject.status).toBe(404);
    expect(((await missingProject.json()) as { error: { code: string } }).error.code).toBe('FILE_NOT_FOUND');
  });

  it('bundles bare imports from the project node_modules only', async () => {
    const res = await fetch(`${baseUrl}/api/exports/standalone-html`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: { kind: 'project', projectId, filePath: 'package-module.html' } }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('BARE_PACKAGE_OK');
    expect(body).not.toContain('from "fixture-package"');
  });

  it('resolves the root browser condition in package exports maps', async () => {
    const res = await fetch(`${baseUrl}/api/exports/standalone-html`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: { kind: 'project', projectId, filePath: 'exports-package.html' } }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('EXPORTS_BROWSER_OK');
    expect(body).not.toContain('LEGACY_MODULE_WRONG');
  });

  it.each(['showcase', 'preview'] as const)('exports the design-system %s view', async (view) => {
    const res = await fetch(`${baseUrl}/api/exports/standalone-html`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: { kind: 'design-system', designSystemId: 'default', view } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect((await res.text()).toLowerCase()).toContain('<!doctype html>');
  });

  it('returns 404 for a missing design system', async () => {
    const res = await fetch(`${baseUrl}/api/exports/standalone-html`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: { kind: 'design-system', designSystemId: 'does-not-exist', view: 'showcase' } }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FILE_NOT_FOUND');
  });

  it('legacy GET export uses the standalone bundler for images', async () => {
    const res = await fetch(exportUrl('image.html'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('src="data:image/png;base64,');
    expect(body).not.toContain('./images/logo.png');
  });

  it('returns a self-contained HTML body when ?inline=1 on a 3-file layout', async () => {
    const res = await fetch(exportUrl('index.html'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    // Wiring guard: the compatibility route uses the standalone bundler.
    expect(body).toContain(cssBody);
    expect(body).toContain(jsBody);
    expect(body).not.toContain('href="app.css"');
    expect(body).not.toContain('src="app.js"');
    expect(body).toContain('<style data-readable-bundled-from="app.css">');
  });

  it('exported standalone deck advances one slide per physical arrow key', async () => {
    const res = await fetch(exportUrl('deck.html'));
    expect(res.status).toBe(200);
    const body = await res.text();

    interface FakeKeyEvent {
      key: string;
      defaultPrevented: boolean;
      preventDefault(): void;
    }
    type FakeKeyListener = (event: FakeKeyEvent) => void;
    const windowListeners: FakeKeyListener[] = [];
    const documentListeners: FakeKeyListener[] = [];
    const fakeWindow = {
      idx: 0,
      addEventListener: (_type: string, listener: FakeKeyListener) => windowListeners.push(listener),
      removeEventListener: () => {},
    };
    const fakeDocument = {
      addEventListener: (_type: string, listener: FakeKeyListener) => documentListeners.push(listener),
      removeEventListener: () => {},
    };

    for (const match of body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
      Function('window', 'document', match[1]!)(fakeWindow, fakeDocument);
    }

    function press(key: string) {
      const event = {
        key,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const listener of windowListeners) listener.call(fakeWindow, event);
      for (const listener of documentListeners) listener.call(fakeDocument, event);
    }

    press('ArrowRight');
    expect(fakeWindow.idx).toBe(1);
    press('ArrowLeft');
    expect(fakeWindow.idx).toBe(0);
  });

  it('returns 400 BAD_REQUEST when ?inline is missing', async () => {
    const res = await fetch(exportUrl('index.html', ''));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for non-canonical inline values (0, false, foo)', async () => {
    for (const q of ['inline=0', 'inline=false', 'inline=foo', 'inline=']) {
      const res = await fetch(exportUrl('index.html', q));
      expect(res.status).toBe(400);
    }
  });

  it('returns 415 UNSUPPORTED_MEDIA_TYPE for non-HTML files', async () => {
    // Drift fix discovered in PR #1312 round-3: the round-1 code emitted
    // `UNSUPPORTED_FILE_TYPE` (status 400) which is not a registered
    // ApiErrorCode in packages/contracts/src/errors.ts. The canonical
    // code for "wrong content type" is UNSUPPORTED_MEDIA_TYPE with HTTP
    // 415, so the route now uses both.
    const res = await fetch(exportUrl('app.css'));
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('returns 404 FILE_NOT_FOUND for a nonexistent file', async () => {
    const res = await fetch(exportUrl('missing.html'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FILE_NOT_FOUND');
  });

  it('returns 400 BAD_REQUEST for an invalid project id (..)', async () => {
    const res = await fetch(`${baseUrl}/api/projects/../export/index.html?inline=1`);
    // Express normalizes `..` segments before routing, so this should not
    // reach our handler; the daemon's middleware or routing answers first.
    // Either way, the request must NOT succeed at extracting a parent
    // directory.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('rejects null-origin requests with 403 (export is for same-origin / server-side callers only)', async () => {
    // Unlike /raw/*, the /export/* route is NOT in the daemon's null-
    // origin allowlist (server.ts _NULL_ORIGIN_SAFE_GET_RE). The export
    // consumer set is the daemon UI (same-origin) and server-side
    // screenshot tooling (no Origin header at all); sandboxed-iframe
    // srcdoc previews fetch through /raw/ instead, where each asset has
    // its own URL. This test pins the contract so a future change that
    // adds /export/ to the allowlist has to update it deliberately.
    const res = await fetch(exportUrl('index.html'), { headers: { Origin: 'null' } });
    expect(res.status).toBe(403);
  });

  it('returns 200 with the <link> tag intact when a sibling asset is missing', async () => {
    const res = await fetch(exportUrl('partial.html'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<link rel="stylesheet" href="missing.css">');
    expect(body).toContain(jsBody);
    expect(body).not.toContain('src="app.js"');
  });

  it('inlines a nested HTML entry (pages/index.html + ../shared/util.js)', async () => {
    const res = await fetch(exportUrl('pages/index.html'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(nestedJsBody);
    expect(body).not.toContain('src="../shared/util.js"');
  });

  it('exports a Vite dev HTML entry through the built dist artifact for offline HTML downloads', async () => {
    const dir = path.join(projectsRoot, projectId);
    await mkdir(path.join(dir, 'dist', 'assets'), { recursive: true });
    await writeFile(
      path.join(dir, 'vite-entry.html'),
      '<!doctype html><html><head><script type="module" src="/src/main.tsx"></script></head><body><div id="root"></div></body></html>',
    );
    await writeFile(
      path.join(dir, 'dist', 'index.html'),
      '<!doctype html><html><head>' +
        '<script type="module" crossorigin src="/assets/app.js"></script>' +
        '<link rel="stylesheet" crossorigin href="/assets/app.css">' +
        '</head><body><div id="root"></div></body></html>',
    );
    await writeFile(path.join(dir, 'dist', 'assets', 'app.js'), 'window.VITE_EXPORT_OK = true;');
    await writeFile(path.join(dir, 'dist', 'assets', 'app.css'), 'body{background:#123456 url(/assets/logo.png)}');
    await writeFile(path.join(dir, 'dist', 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const res = await fetch(exportUrl('vite-entry.html'));
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('window.VITE_EXPORT_OK = true;');
    expect(body).toContain('body{background:#123456 url(');
    expect(body).toContain('data:image/png;base64,');
    expect(body).not.toContain('/src/main.tsx');
    expect(body).not.toContain('/assets/app.js');
    expect(body).not.toContain('/assets/app.css');
    expect(body).toContain('data-readable-bundled-from="assets/app.css"');

    const post = await fetch(`${baseUrl}/api/exports/standalone-html`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: { kind: 'project', projectId, filePath: 'vite-entry.html' } }),
    });
    expect(post.status).toBe(200);
    expect(await post.text()).toContain('window.VITE_EXPORT_OK = true;');
  });

  it('detects Vite module scripts regardless of attribute order', async () => {
    const dir = path.join(projectsRoot, projectId);
    await writeFile(path.join(dir, 'vite-reversed.html'), '<!doctype html><script src="/src/main.ts" type="module"></script>');
    const res = await fetch(exportUrl('vite-reversed.html'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('window.VITE_EXPORT_OK = true;');
  });

  it('rejects a project entry reached through an internal symlink', async () => {
    const dir = path.join(projectsRoot, projectId);
    const linked = path.join(dir, 'linked-entry.html');
    try {
      await symlink(path.join(dir, 'index.html'), linked, 'file');
    } catch (error: any) {
      if (error?.code === 'EPERM') return;
      throw error;
    }
    const response = await fetch(`${baseUrl}/api/exports/standalone-html`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: { kind: 'project', projectId, filePath: 'linked-entry.html' } }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
  });

  it('rejects a Vite dist entry reached through an internal symlink', async () => {
    const dir = path.join(projectsRoot, projectId, 'symlink-vite');
    await mkdir(path.join(dir, 'dist'), { recursive: true });
    await writeFile(path.join(dir, 'entry.html'), '<!doctype html><script type="module" src="/src/main.ts"></script>');
    await writeFile(path.join(dir, 'dist', 'real.html'), '<!doctype html><p>linked dist</p>');
    try {
      await symlink(path.join(dir, 'dist', 'real.html'), path.join(dir, 'dist', 'index.html'), 'file');
    } catch (error: any) {
      if (error?.code === 'EPERM') return;
      throw error;
    }
    const response = await fetch(`${baseUrl}/api/exports/standalone-html`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: { kind: 'project', projectId, filePath: 'symlink-vite/entry.html' } }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
  });

  it('returns 413 instead of falling back when Vite dist HTML is oversized', async () => {
    const dir = path.join(projectsRoot, projectId, 'oversized-vite');
    await mkdir(path.join(dir, 'dist'), { recursive: true });
    await writeFile(path.join(dir, 'entry.html'), '<!doctype html><script type="module" src="/src/main.ts"></script>');
    await writeFile(path.join(dir, 'dist', 'index.html'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
    const response = await fetch(`${baseUrl}/api/exports/standalone-html`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: { kind: 'project', projectId, filePath: 'oversized-vite/entry.html' } }),
    });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('exports a nested Vite dev HTML entry through its sibling built dist artifact', async () => {
    const dir = path.join(projectsRoot, projectId, 'pages');
    await mkdir(path.join(dir, 'dist', 'assets'), { recursive: true });
    await writeFile(
      path.join(dir, 'nested-vite.html'),
      '<!doctype html><html><head><script type="module" src="/src/main.tsx"></script></head><body><div id="root"></div></body></html>',
    );
    await writeFile(
      path.join(dir, 'dist', 'index.html'),
      '<!doctype html><html><head>' +
        '<script type="module" crossorigin src="/assets/nested.js"></script>' +
        '<link rel="stylesheet" crossorigin href="/assets/nested.css">' +
        '</head><body><div id="root"></div></body></html>',
    );
    await writeFile(path.join(dir, 'dist', 'assets', 'nested.js'), 'window.NESTED_VITE_EXPORT_OK = true;');
    await writeFile(path.join(dir, 'dist', 'assets', 'nested.css'), 'body{background:#abcdef}');

    const res = await fetch(exportUrl('pages/nested-vite.html'));
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('window.NESTED_VITE_EXPORT_OK = true;');
    expect(body).toContain('body{background:#abcdef}');
    expect(body).not.toContain('/src/main.tsx');
    expect(body).not.toContain('/assets/nested.js');
    expect(body).not.toContain('/assets/nested.css');
    expect(body).toContain('data-readable-bundled-from="assets/nested.css"');
  });

  it('sends Content-Security-Policy: sandbox allow-scripts to block daemon-origin privilege escalation', async () => {
    // PR #1312 round-2 review (lefarcen P2 @ import-export-routes.ts:423):
    // top-level browser navigation to the export URL sends no Origin
    // header, so the daemon middleware lets it through and any JS in
    // the exported document runs with daemon-origin privileges (access
    // to /api/, cookies, localStorage). CSP `sandbox allow-scripts`
    // treats the response like a sandboxed iframe with an opaque origin:
    // scripts execute (which the export needs — that's the whole point
    // of inlining JS) but cannot read cookies, hit /api/, or otherwise
    // escalate to the daemon's origin.
    const res = await fetch(exportUrl('index.html'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
  });

  it('accepts inline=true / yes / on / TRUE / Yes / ON (case-insensitive accept list per decision §7)', async () => {
    // PR #1312 round-2 review (lefarcen P3 @ export-inline-route.test.ts:262):
    // PR body decision §7 promises `inline=true/yes/on` case-insensitive
    // matching parseForceInline at file-viewer-render-mode.ts:59-66, but
    // round-1 tests only exercised inline=1. Pin the full accept list.
    for (const q of ['inline=true', 'inline=yes', 'inline=on', 'inline=TRUE', 'inline=Yes', 'inline=ON']) {
      const res = await fetch(exportUrl('index.html', q));
      expect(res.status).toBe(200);
    }
  });

  it('returns 413 PAYLOAD_TOO_LARGE when the owner file blows past the candidates cap', async () => {
    // Generated owner has 501 references, one above the standalone limit.
    const dir = path.join(projectsRoot, projectId);
    const huge = '<!doctype html><html><head>' +
      '<link rel="stylesheet" href="a.css">'.repeat(501) +
      '</head></html>';
    await writeFile(path.join(dir, 'too-many-tags.html'), huge);
    const res = await fetch(exportUrl('too-many-tags.html'));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('returns 413 (not 415) for an oversize non-HTML file — proves owner cap fires pre-buffer', async () => {
    // Source size is checked from stat metadata before MIME or buffer reads.
    const dir = path.join(projectsRoot, projectId);
    const overCap = 2 * 1024 * 1024 + 1;
    await writeFile(path.join(dir, 'huge.txt'), Buffer.alloc(overCap, 0x61));
    const res = await fetch(exportUrl('huge.txt'));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects an invalid project id (chars outside isSafeId char class) with 400 BAD_REQUEST', async () => {
    // PR #1312 round-2 review (lefarcen P3 @ export-inline-route.test.ts:287):
    // the previous `..` test was rejected by Express path normalization
    // before the route saw it, so it didn't actually exercise the
    // isSafeId guard. We need an id that (a) Express passes through
    // unchanged into req.params and (b) isSafeId rejects. The `!` char
    // is URL-safe (no percent-encoding needed) and not in isSafeId's
    // /^[A-Za-z0-9._-]+$/ char class, so it hits the route's first
    // checkpoint and returns the documented envelope.
    const res = await fetch(exportUrl('index.html').replace(`/${projectId}/`, '/bad!id/'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('invalid project id');
  });
});
