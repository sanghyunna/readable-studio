import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizePersistedArtifactHtml, resolvePersistedHtmlArtifact, type ArtifactPersistenceRun } from '../../src/artifacts/persistence';
import type { AgentEvent, ProjectFile } from '../../src/types';

const html = '<!doctype html><html><body><pre>a  b</pre></body></html>';
const index: ProjectFile = { name: 'index.html', path: 'index.html', kind: 'html', mime: 'text/html', size: html.length, mtime: 2000 };
const run: ArtifactPersistenceRun = { startedAt: 1000, messageId: 'message-1', preTurnFileNames: [] };
const write: AgentEvent = { kind: 'tool_use', id: 'write-1', name: 'Write', input: { file_path: 'index.html' } };
const success: AgentEvent = { kind: 'tool_result', toolUseId: 'write-1', content: '', isError: false };
function resolve(files = [index], context = run, content = html) {
  return resolvePersistedHtmlArtifact('project-1', content, 'design', 'design.html', files, context);
}
afterEach(() => vi.unstubAllGlobals());

describe('current-run HTML content resolution', () => {
  it('uses the shipped uncached project-file reader and only trims document edges', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(`\uFEFF\n${html}\n`));
    vi.stubGlobal('fetch', fetch);
    expect(await resolve()).toBe(index);
    expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/raw/index.html', { cache: 'no-store' });
    expect(normalizePersistedArtifactHtml(`\uFEFF\n${html}\n`)).toBe(html);
  });

  it('does not collapse meaningful interior whitespace', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(html.replace('a  b', 'a b'))));
    expect(await resolve()).toBeNull();
  });

  it('requires provenance when a legacy replay has no pre-turn snapshot', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await resolve([index], { startedAt: 1000, messageId: 'message-1', replay: true })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('can positively identify an existing index rewritten by a successful current-run tool', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(html)));
    expect(await resolve([index], { ...run, preTurnFileNames: ['index.html'], events: [write, success] })).toBe(index);
  });

  it.each([
    [write],
    [write, { ...success, isError: true }],
    [{ ...write, input: { file_path: 'nested/index.html' } }, success],
    [{ ...write, input: { file_path: 'D:/another-project/index.html' } }, success],
  ] satisfies AgentEvent[][])('does not treat an incomplete, failed, or different-directory write as provenance (%#)', async (...events) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await resolve([index], { ...run, preTurnFileNames: ['index.html'], events })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never reuses a stale pre-run index, even with a successful tool event', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await resolve([{ ...index, mtime: 999 }], { ...run, events: [write, success] })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not attribute an index written after the completed run to that replay', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await resolve([index], { ...run, completedAt: 1999, replay: true })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires stored content equality even when replay manifest metadata matches', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(html.replace('a  b', 'different'))));
    const named = { ...index, name: 'design.html', path: 'design.html', artifactManifest: {
      schema: 'readable-studio.artifact-manifest.v1', kind: 'html', renderer: 'html', entry: 'design.html', title: 'Design', exports: ['html'], metadata: { identifier: 'design', messageId: run.messageId },
    } } satisfies ProjectFile;
    expect(await resolve([named], { ...run, replay: true })).toBeNull();
  });

  it('reports a failed stored-content read and declines to merge', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    const warning = vi.spyOn(console, 'warn');
    try {
      expect(await resolve()).toBeNull();
      expect(warning).toHaveBeenCalledWith('[fetchProjectFileText] failed:', expect.objectContaining({ status: 404, name: 'index.html' }));
    } finally {
      warning.mockRestore();
    }
  });
});
