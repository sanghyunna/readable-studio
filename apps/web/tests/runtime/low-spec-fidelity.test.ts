import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSrcdoc, type SrcdocOptions } from '../../src/runtime/srcdoc';
import { buildSandboxedPreviewDocument, exportAsMd, exportAsZip, exportProjectAsHtml, exportStandaloneHtml } from '../../src/runtime/exports';
import { applyPerformanceProfileToDocument, PERFORMANCE_PROFILE_ATTRIBUTE } from '../../src/state/config';

const source = '<!doctype html><html><head><style>main{width:320px;transform:translateX(7px);animation:pulse 2s infinite}@keyframes pulse{to{opacity:.5}}</style></head><body><main data-readable-id="hero">한글 artifact</main><img src="./hero.svg"></body></html>';
const bundled = source.replace('./hero.svg', 'data:image/svg+xml;base64,PHN2Zy8+');
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
let host: JSDOM;
const downloads: Blob[] = [];

beforeEach(() => {
  host = new JSDOM('<!doctype html><html><body><iframe></iframe></body></html>', { url: 'http://localhost' });
  vi.stubGlobal('document', host.window.document);
  vi.stubGlobal('window', host.window);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  vi.spyOn(host.window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    if (!(blob instanceof Blob)) throw new TypeError('Expected downloadable Blob');
    downloads.push(blob);
    return 'blob:download';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  downloads.length = 0;
  host.window.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('low-spec artifact boundary', () => {
  it.each<SrcdocOptions>([{}, { editBridge: true }, { deck: true, initialSlideIndex: 1 }, { inspectBridge: true, commentBridge: true, paletteBridge: true }])('keeps preview and sandbox wrapper hashes identical for %j', (options) => {
    // Given the same artifact and all supported bridge combinations.
    applyPerformanceProfileToDocument('full');
    const full = [buildSrcdoc(source, options), buildSandboxedPreviewDocument(buildSrcdoc(source, options), 'Artifact')];
    // When only the host profile changes.
    applyPerformanceProfileToDocument('low');
    const low = [buildSrcdoc(source, options), buildSandboxedPreviewDocument(buildSrcdoc(source, options), 'Artifact')];
    // Then the complete bytes remain identical, with no host styling/stamp injected.
    expect(low.map(hash)).toEqual(full.map(hash));
    expect(document.querySelectorAll(`[${PERFORMANCE_PROFILE_ATTRIBUTE}]`)).toHaveLength(1);
    expect(document.documentElement.getAttribute(PERFORMANCE_PROFILE_ATTRIBUTE)).toBe('low');
    expect(document.querySelector('iframe')?.contentDocument?.documentElement.hasAttribute(PERFORMANCE_PROFILE_ATTRIBUTE)).toBe(false);
    for (const output of low) {
      expect(output).not.toContain(PERFORMANCE_PROFILE_ATTRIBUTE);
      expect(output).not.toContain('styles/low-spec');
    }
  });

  it.each([exportAsMd, exportAsZip])('keeps generated download hashes identical through %s', async (download) => {
    // Given identical input and a fixed ZIP timestamp.
    applyPerformanceProfileToDocument('full');
    download(source, 'Artifact');
    // When the same download is requested in low mode.
    applyPerformanceProfileToDocument('low');
    download(source, 'Artifact');
    // Then the real generated Blob bytes match, not merely the filename.
    const hashes = await Promise.all(downloads.map(async (blob) => hash(new Uint8Array(await blob.arrayBuffer()))));
    expect(hashes).toHaveLength(2);
    expect(hashes[1]).toBe(hashes[0]);
  });

  it.each(['project', 'inline'] as const)('preserves the %s inlining request and downloaded response bytes in both profiles', async (kind) => {
    // Given an HTTP boundary fixture containing an already-inlined asset.
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      requests.push(String(init?.body));
      return new Response(bundled, { headers: {
        'content-type': 'text/html',
        'x-readable-studio-external-reference-count': '0',
        'x-readable-studio-missing-local-reference-count': '0',
        'x-readable-studio-skipped-system-font-count': '0',
      } });
    }));
    // When the real export/download entry point runs under each profile.
    for (const profile of ['full', 'low'] as const) {
      applyPerformanceProfileToDocument(profile);
      if (kind === 'project') await exportProjectAsHtml({ projectId: 'project', filePath: 'index.html', title: 'Artifact' });
      else await exportStandaloneHtml({ source: { kind: 'inline', html: source }, title: 'Artifact' });
    }
    // Then no profile reaches the inliner and its output is downloaded unchanged.
    expect(requests).toHaveLength(2);
    expect(hash(requests[0] ?? '')).toBe(hash(requests[1] ?? ''));
    expect(requests[0]).not.toContain('performance');
    expect(downloads).toHaveLength(2);
    for (const blob of downloads) expect(hash(await blob.text())).toBe(hash(bundled));
  });
});
