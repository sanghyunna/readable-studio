import { describe, expect, it, vi } from 'vitest';

import {
  HostedProviderClient,
  HostedProviderRequestError,
} from '../src/providers/hosted';

const session = {
  publicOrigin: 'https://hosted.readable-studio.test',
  csrfToken: 'csrf-one',
  csrfExpiresAt: Date.now() + 60_000,
  providers: [{ id: 'anthropic', model: 'claude-sonnet-4-20250514' }],
} as const;

function json(value: unknown = { ok: true }, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HostedProviderClient content surface', () => {
  it('uses canonical wildcard segments for nested file reads and deletes', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(new Response('<h1>A</h1>', {
        headers: { 'content-type': 'text/html' },
      }))
      .mockResolvedValueOnce(json());
    const client = new HostedProviderClient(fetcher);

    const file = await client.readProjectFile('project-a', 'slides/a b.html');
    await client.deleteProjectFile('project-a', 'slides/a b.html');

    expect(file.headers.get('content-type')).toContain('text/html');
    await expect(file.text()).resolves.toBe('<h1>A</h1>');

    expect(fetcher.mock.calls.slice(1).map(([url]) => url)).toEqual([
      '/api/projects/project-a/files/slides/a%20b.html',
      '/api/projects/project-a/files/slides/a%20b.html',
    ]);
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({
      method: 'DELETE',
      credentials: 'include',
      headers: expect.objectContaining({
        Origin: session.publicOrigin,
        'X-Readable-Studio-CSRF': session.csrfToken,
      }),
    });
    expect(fetcher.mock.calls.flatMap(([url]) => String(url))).not.toContain('/raw/');

    for (const path of [
      '../secret.txt',
      'slides//secret.txt',
      'slides%2Fsecret.txt',
      'slides%5Csecret.txt',
      'slides%252Fsecret.txt',
    ]) {
      expect(() => client.readProjectFile('project-a', path), path)
        .toThrow(HostedProviderRequestError);
    }
    expect(() => client.readProjectFile('project%2Fa', 'index.html'))
      .toThrow(HostedProviderRequestError);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('sends only the closed JSON file, folder, search, preview, and artifact shapes', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => (
      input === '/api/hosted/session' ? json(session) : json()
    ));
    const client = new HostedProviderClient(fetcher);

    await client.listProjectFiles('project-a', 7);
    await client.writeProjectFile('project-a', {
      name: 'slides/index.html',
      content: '<h1>Slides</h1>',
      overwrite: false,
      ignored: 'not-sent',
    } as never);
    await client.renameProjectFile('project-a', 'slides/index.html', 'slides/final.html');
    await client.searchProjectFiles('project-a', { q: 'hero section', pattern: '*.html', max: 10 });
    await client.listProjectFolders('project-a');
    await client.createProjectFolder('project-a', 'slides/assets');
    await client.deleteProjectFolder('project-a', 'slides/assets');
    await client.previewProjectFile('project-a', 'slides/final.html');
    await client.createProjectPreviewUrl('project-a', 'slides/final.html');
    await client.saveArtifact({
      identifier: 'demo',
      title: 'Demo',
      html: '<!doctype html>',
      ignored: 'not-sent',
    } as never);
    await client.lintArtifact('<!doctype html>');

    const calls = fetcher.mock.calls.slice(1);
    expect(calls.map(([url]) => url)).toEqual([
      '/api/projects/project-a/files?since=7',
      '/api/projects/project-a/files',
      '/api/projects/project-a/files/rename',
      '/api/projects/project-a/search?q=hero+section&pattern=*.html&max=10',
      '/api/projects/project-a/folders',
      '/api/projects/project-a/folders',
      '/api/projects/project-a/folders',
      '/api/projects/project-a/files/preview',
      '/api/projects/project-a/preview-url',
      '/api/artifacts/save',
      '/api/artifacts/lint',
    ]);
    expect(calls.map(([, init]) => init?.method)).toEqual([
      'GET', 'POST', 'POST', 'GET', 'GET', 'POST', 'DELETE', 'POST', 'POST', 'POST', 'POST',
    ]);
    expect(calls.map(([, init]) => init?.body).filter((body) => body !== undefined)).toEqual([
      '{"name":"slides/index.html","content":"<h1>Slides</h1>","overwrite":false}',
      '{"from":"slides/index.html","to":"slides/final.html"}',
      '{"path":"slides/assets"}',
      '{"path":"slides/assets"}',
      '{"path":"slides/final.html"}',
      '{"file":"slides/final.html"}',
      '{"html":"<!doctype html>","identifier":"demo","title":"Demo"}',
      '{"html":"<!doctype html>"}',
    ]);
    expect(calls.every(([url]) => !String(url).includes('/raw/'))).toBe(true);
  });

  it('retries the identical multipart body with refreshed CSRF and no manual content type', async () => {
    const refreshed = { ...session, csrfToken: 'csrf-two' };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json({}, 419))
      .mockResolvedValueOnce(json(refreshed))
      .mockResolvedValueOnce(json({ files: [] }));
    const client = new HostedProviderClient(fetcher);
    const files = [new File(['one'], 'one.txt', { type: 'text/plain' })];

    await client.uploadProjectFiles('project-a', files, 'nested/uploads');

    const first = fetcher.mock.calls[1]?.[1];
    const retry = fetcher.mock.calls[3]?.[1];
    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/projects/project-a/upload');
    expect(retry?.body).toBe(first?.body);
    expect(first?.body).toBeInstanceOf(FormData);
    const body = first?.body as FormData;
    expect(body.get('dir')).toBe('nested/uploads');
    expect((body.getAll('files')[0] as File).name).toBe('one.txt');
    expect(new Headers(first?.headers).get('content-type')).toBeNull();
    expect(new Headers(first?.headers).get('origin')).toBe(session.publicOrigin);
    expect(new Headers(first?.headers).get('x-readable-studio-csrf')).toBe('csrf-one');
    expect(new Headers(retry?.headers).get('x-readable-studio-csrf')).toBe('csrf-two');
  });

  it('returns only same-origin API URLs for archive, manifest, and artifact downloads', () => {
    const client = new HostedProviderClient(vi.fn<typeof fetch>());

    expect(client.projectArchiveUrl('project-a')).toBe('/api/projects/project-a/archive');
    expect(client.projectArchiveUrl('project-a', 'slides/final'))
      .toBe('/api/projects/project-a/archive?root=slides%2Ffinal');
    expect(client.projectExportManifestUrl('project-a'))
      .toBe('/api/projects/project-a/export/manifest');
    expect(client.artifactDownloadUrl(`oda_${'a'.repeat(43)}`))
      .toBe(`/api/artifacts/oda_${'a'.repeat(43)}/download`);

    expect(() => client.projectArchiveUrl('project-a', 'slides%2Fprivate'))
      .toThrow(HostedProviderRequestError);
    expect(() => client.artifactDownloadUrl('oda_a%2Fcopied'))
      .toThrow(HostedProviderRequestError);
  });
});
