import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';

import { startHostedServer } from '../src/hosted-server.js';

const PUBLIC_ORIGIN = 'https://hosted.readable-studio.test';
const USER_A = 'pr08-user-a';
const USER_B = 'pr08-user-b';

type StartedServer = Awaited<ReturnType<typeof startHostedServer>>;
type Project = { id: string; name: string };
type FileEntry = { name: string; path: string; size: number; type: 'file' };

const startedServers: StartedServer[] = [];
const runtimeRoots: string[] = [];

afterEach(async () => {
  await Promise.all(startedServers.splice(0).map((started) => started.shutdown()));
  await Promise.all(runtimeRoots.splice(0).map(removeRuntimeRoot));
});

describe('hosted PR08 HTTP content boundary', () => {
  it('isolates same-named file and folder CRUD plus search by authenticated owner', async () => {
    const started = await start();
    const [csrfA, csrfB] = await csrfPair(started);
    const [projectA, projectB] = await Promise.all([
      createProject(started, USER_A, csrfA, 'A content'),
      createProject(started, USER_B, csrfB, 'B content'),
    ]);
    expect(projectB.id).toBe(projectA.id);

    for (const [user, csrf, content] of [
      [USER_A, csrfA, 'private needle from A'],
      [USER_B, csrfB, 'private needle from B'],
    ] as const) {
      const folder = await json<{ folder: { path: string; type: string } }>(mutate(
        started,
        user,
        csrf,
        'POST',
        `/api/projects/${projectA.id}/folders`,
        { path: 'notes' },
      ));
      expect(folder.folder).toMatchObject({ path: 'notes', type: 'dir' });
      const written = await json<{ file: FileEntry }>(mutate(
        started,
        user,
        csrf,
        'POST',
        `/api/projects/${projectA.id}/files`,
        { name: 'notes/same.txt', content },
      ));
      expect(written.file).toMatchObject({ path: 'notes/same.txt', type: 'file' });
    }

    const [readA, readB] = await Promise.all([
      readFile(started, USER_A, projectA.id, 'notes/same.txt'),
      readFile(started, USER_B, projectB.id, 'notes/same.txt'),
    ]);
    expect(readA).toBe('private needle from A');
    expect(readB).toBe('private needle from B');

    const listedA = await json<{ files: FileEntry[] }>(get(
      started,
      USER_A,
      `/api/projects/${projectA.id}/files`,
    ));
    expect(listedA.files).toEqual([
      expect.objectContaining({ path: 'notes/same.txt', type: 'file' }),
    ]);
    const foldersA = await json<{ folders: Array<{ path: string }> }>(get(
      started,
      USER_A,
      `/api/projects/${projectA.id}/folders`,
    ));
    expect(foldersA.folders).toEqual([expect.objectContaining({ path: 'notes' })]);

    const searchA = await json<{ matches: Array<{ file: string; snippet: string }> }>(get(
      started,
      USER_A,
      `/api/projects/${projectA.id}/search?q=${encodeURIComponent('needle from A')}&max=10`,
    ));
    expect(searchA.matches).toEqual([
      expect.objectContaining({ file: 'notes/same.txt', snippet: expect.stringContaining('A') }),
    ]);
    const searchB = await json<{ matches: Array<{ snippet: string }> }>(get(
      started,
      USER_B,
      `/api/projects/${projectB.id}/search?q=${encodeURIComponent('needle from A')}`,
    ));
    expect(searchB.matches).toEqual([]);

    const renamed = await json<{ file: FileEntry; oldName: string; newName: string }>(mutate(
      started,
      USER_A,
      csrfA,
      'POST',
      `/api/projects/${projectA.id}/files/rename`,
      { from: 'notes/same.txt', to: 'notes/renamed.txt' },
    ));
    expect(renamed).toMatchObject({ oldName: 'notes/same.txt', newName: 'notes/renamed.txt' });
    expect(await readFile(started, USER_A, projectA.id, 'notes/renamed.txt'))
      .toBe('private needle from A');
    expect(await readFile(started, USER_B, projectB.id, 'notes/same.txt'))
      .toBe('private needle from B');

    await success(mutate(
      started,
      USER_A,
      csrfA,
      'DELETE',
      `/api/projects/${projectA.id}/files/notes/renamed.txt`,
    ));
    await success(mutate(
      started,
      USER_A,
      csrfA,
      'DELETE',
      `/api/projects/${projectA.id}/folders`,
      { path: 'notes' },
    ));
    await apiError(get(started, USER_A, `/api/projects/${projectA.id}/files/notes/renamed.txt`), 404);
    expect(await readFile(started, USER_B, projectB.id, 'notes/same.txt'))
      .toBe('private needle from B');
  });

  it('requires Origin and CSRF for content mutations and rejects authority and path smuggling', async () => {
    const started = await start();
    const csrf = await getCsrf(started, USER_A);
    const project = await createProject(started, USER_A, csrf, 'Request boundary');
    const route = `/api/projects/${project.id}/files`;

    await apiError(fetch(`${started.url}${route}`, {
      method: 'POST',
      headers: { ...auth(USER_A), 'content-type': 'application/json', origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ name: 'x.txt', content: 'x' }),
    }), 419, 'HOSTED_CSRF_INVALID');
    await apiError(fetch(`${started.url}${route}`, {
      method: 'POST',
      headers: {
        ...auth(USER_A),
        'content-type': 'application/json',
        'x-readable-studio-csrf': csrf,
        origin: 'https://attacker.example',
      },
      body: JSON.stringify({ name: 'x.txt', content: 'x' }),
    }), 403, 'HOSTED_ORIGIN_INVALID');

    for (const [body, code] of [
      [{ name: '../escape.txt', content: 'x' }, 'BAD_REQUEST'],
      [{ name: 'safe.txt', content: 'x', userKey: USER_B }, 'HOSTED_OWNER_FIELD_FORBIDDEN'],
      [{ name: 'safe.txt', content: 'x', root: 'C:\\outside' }, 'BAD_REQUEST'],
    ] as const) {
      await apiError(mutate(started, USER_A, csrf, 'POST', route, body), 400, code);
    }
    for (const path of [
      `/api/projects/${project.id}/files/%2e%2e/escape.txt`,
      `/api/projects/${project.id}/files/notes%2Fescape.txt`,
      `/api/projects/${project.id}/files/notes%5Cescape.txt`,
    ]) {
      await apiError(get(started, USER_A, path), 404, 'HOSTED_ROUTE_NOT_ALLOWED');
    }
    await apiError(
      get(started, USER_A, `/api/projects/${project.id}/archive?root=../outside`),
      400,
      'BAD_REQUEST',
    );
  });

  it('forces authenticated raw active content to download under a non-executable policy', async () => {
    const started = await start();
    const csrf = await getCsrf(started, USER_A);
    const project = await createProject(started, USER_A, csrf, 'Raw active content');
    const fixtures = [
      ['active.html', '<!doctype html><script>top.location="/api/projects"</script>'],
      ['active.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ] as const;
    for (const [name, content] of fixtures) {
      await writeFile(started, USER_A, csrf, project.id, name, content);
      const response = await get(
        started,
        USER_A,
        `/api/projects/${project.id}/files/${name}`,
      );
      expect(response.status, await bodyOnFailure(response)).toBe(200);
      expect(response.headers.get('content-disposition')).toContain('attachment');
      expect(response.headers.get('content-security-policy')).toBe(
        "default-src 'none'; base-uri 'none'; sandbox",
      );
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await response.text()).toBe(content);
    }
  });

  it('serves credentialless opaque preview scopes with restrictive headers and owner-correct content', async () => {
    const started = await start();
    const [csrfA, csrfB] = await csrfPair(started);
    const [projectA, projectB] = await Promise.all([
      createProject(started, USER_A, csrfA, 'A preview'),
      createProject(started, USER_B, csrfB, 'B preview'),
    ]);
    const maliciousA = maliciousHtml('A');
    const maliciousB = maliciousHtml('B');
    await Promise.all([
      writeFile(started, USER_A, csrfA, projectA.id, 'index.html', maliciousA),
      writeFile(started, USER_B, csrfB, projectB.id, 'index.html', maliciousB),
    ]);

    const [mintedA, mintedB] = await Promise.all([
      mintPreview(mutate(
        started,
        USER_A,
        csrfA,
        'POST',
        `/api/projects/${projectA.id}/preview-url`,
        { file: 'index.html' },
      )),
      mintPreview(mutate(
        started,
        USER_B,
        csrfB,
        'POST',
        `/api/projects/${projectB.id}/preview-url`,
        { file: 'index.html' },
      )),
    ]);
    const { scope: scopeA, cookie: cookieA } = mintedA;
    const { scope: scopeB, cookie: cookieB } = mintedB;
    expect(scopeA).toMatchObject({ file: 'index.html', iframeSandbox: 'allow-scripts', opaqueOrigin: true });
    expect(scopeB).toMatchObject({ file: 'index.html', iframeSandbox: 'allow-scripts', opaqueOrigin: true });
    expect(scopeA.url).not.toBe(scopeB.url);
    await apiError(fetch(`${started.url}${scopeA.url}`), 404);
    const copiedBrowserProof = `${cookieA.split('=', 1)[0]}=${cookieB.split('=')[1]}`;
    await apiError(fetch(`${started.url}${scopeA.url}`, {
      headers: { cookie: copiedBrowserProof },
    }), 404);

    for (const [scope, cookie, html] of [
      [scopeA, cookieA, maliciousA],
      [scopeB, cookieB, maliciousB],
    ] as const) {
      expect(scope.url).toMatch(/^\/api\/projects\/[A-Za-z0-9._-]+\/preview\/odpv_[A-Za-z0-9_-]+\/index\.html$/u);
      const preview = await fetch(`${started.url}${scope.url}`, {
        headers: { cookie },
      });
      expect(preview.status, await bodyOnFailure(preview)).toBe(200);
      expect(preview.headers.get('cache-control')).toBe('no-store');
      expect(preview.headers.get('x-content-type-options')).toBe('nosniff');
      expect(preview.headers.get('access-control-allow-origin')).toBeNull();
      expect(preview.headers.get('set-cookie')).toBeNull();
      const csp = preview.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).toContain('sandbox allow-scripts');
      expect(csp).toBe(scope.csp);
      expect(await preview.text()).toBe(html);
    }

    const pdfBytes = Buffer.from('%PDF-1.1\n%%EOF\n');
    await writeFile(started, USER_A, csrfA, projectA.id, 'brief.pdf', pdfBytes.toString('base64'), 'base64');
    const documentPreview = await json<{ kind: string; title: string; sections: unknown[] }>(mutate(
      started,
      USER_A,
      csrfA,
      'POST',
      `/api/projects/${projectA.id}/files/preview`,
      { path: 'brief.pdf' },
    ));
    expect(documentPreview).toMatchObject({ kind: 'pdf', title: 'brief.pdf' });
    expect(documentPreview.sections.length).toBeGreaterThan(0);
  });

  it('keeps same-name multipart uploads isolated and exposes no staging paths', async () => {
    const started = await start();
    const [csrfA, csrfB] = await csrfPair(started);
    const [projectA, projectB] = await Promise.all([
      createProject(started, USER_A, csrfA, 'A upload'),
      createProject(started, USER_B, csrfB, 'B upload'),
    ]);
    const [uploadedA, uploadedB] = await Promise.all([
      upload(started, USER_A, csrfA, projectA.id, 'A upload bytes'),
      upload(started, USER_B, csrfB, projectB.id, 'B upload bytes'),
    ]);
    expect(uploadedA.originalName).toBe('same.txt');
    expect(uploadedB.originalName).toBe('same.txt');
    expect(uploadedA.name).toMatch(/^inbox\/[0-9a-f-]+-same\.txt$/u);
    expect(uploadedB.name).toMatch(/^inbox\/[0-9a-f-]+-same\.txt$/u);
    expect(uploadedA.name).not.toBe(uploadedB.name);
    expect(JSON.stringify(uploadedA)).not.toMatch(/[A-Z]:\\|\/tmp\/|\.intake-/u);
    expect(JSON.stringify(uploadedB)).not.toMatch(/[A-Z]:\\|\/tmp\/|\.intake-/u);
    expect(await readFile(started, USER_A, projectA.id, uploadedA.name)).toBe('A upload bytes');
    expect(await readFile(started, USER_B, projectB.id, uploadedB.name)).toBe('B upload bytes');
    await apiError(get(started, USER_A, `/api/projects/${projectA.id}/files/${uploadedB.name}`), 404);
    await apiError(get(started, USER_B, `/api/projects/${projectB.id}/files/${uploadedA.name}`), 404);
  });

  it('streams owner-specific archives and returns a bounded path-free export manifest', async () => {
    const started = await start();
    const [csrfA, csrfB] = await csrfPair(started);
    const [projectA, projectB] = await Promise.all([
      createProject(started, USER_A, csrfA, 'A archive'),
      createProject(started, USER_B, csrfB, 'B archive'),
    ]);
    await Promise.all([
      writeFile(started, USER_A, csrfA, projectA.id, 'index.html', '<h1>A archive</h1>'),
      writeFile(started, USER_B, csrfB, projectB.id, 'index.html', '<h1>B archive</h1>'),
    ]);

    for (const [user, expected, rejected] of [
      [USER_A, '<h1>A archive</h1>', '<h1>B archive</h1>'],
      [USER_B, '<h1>B archive</h1>', '<h1>A archive</h1>'],
    ] as const) {
      const archive = await get(started, user, `/api/projects/${projectA.id}/archive`);
      expect(archive.status, await bodyOnFailure(archive)).toBe(200);
      expect(archive.headers.get('content-type')).toContain('application/zip');
      expect(archive.headers.get('content-disposition')).toContain('attachment');
      expect(archive.headers.get('x-content-type-options')).toBe('nosniff');
      expect(archive.headers.get('cache-control')).toBe('no-store');
      const zip = await JSZip.loadAsync(await archive.arrayBuffer());
      const archived = await zip.file('index.html')?.async('text');
      expect(archived).toBe(expected);
      expect(archived).not.toContain(rejected);

      const response = await get(started, user, `/api/projects/${projectA.id}/export/manifest`);
      const raw = await response.text();
      expect(response.status, raw).toBe(200);
      const manifest = JSON.parse(raw) as {
        schema: string;
        projectId: string;
        projectName: string;
        files: Array<{ name: string }>;
      };
      expect(manifest).toMatchObject({
        schema: 'readable-studio.project-export-manifest.v1',
        projectId: projectA.id,
        projectName: user === USER_A ? 'A archive' : 'B archive',
      });
      expect(manifest.files).toEqual([expect.objectContaining({ name: 'index.html' })]);
      expect(raw).not.toMatch(/[A-Z]:\\|\/tmp\/|runtimeRoot|storageKey|userKey/u);
    }
  });

  it('isolates artifact save/lint/download and terminally denies every raw content surface', async () => {
    const started = await start();
    const [csrfA, csrfB] = await csrfPair(started);
    const [projectA] = await Promise.all([
      createProject(started, USER_A, csrfA, 'A raw denial'),
      createProject(started, USER_B, csrfB, 'B raw denial'),
    ]);
    const htmlA = '<!doctype html><title>A artifact</title><h1>A</h1>';
    const htmlB = '<!doctype html><title>B artifact</title><h1>B</h1>';
    const lint = await json<{ findings: unknown[]; agentMessage: string }>(mutate(
      started,
      USER_A,
      csrfA,
      'POST',
      '/api/artifacts/lint',
      { html: htmlA },
    ));
    expect(lint.findings).toBeInstanceOf(Array);
    expect(typeof lint.agentMessage).toBe('string');
    const [artifactA, artifactB] = await Promise.all([
      json<ArtifactResponse>(mutate(
        started,
        USER_A,
        csrfA,
        'POST',
        '/api/artifacts/save',
        { title: 'same', html: htmlA },
      )),
      json<ArtifactResponse>(mutate(
        started,
        USER_B,
        csrfB,
        'POST',
        '/api/artifacts/save',
        { title: 'same', html: htmlB },
      )),
    ]);
    expect(artifactA.artifactId).toMatch(/^oda_[A-Za-z0-9_-]{43}$/u);
    expect(artifactB.artifactId).toMatch(/^oda_[A-Za-z0-9_-]{43}$/u);
    expect(artifactA.url).toBe(`/api/artifacts/${artifactA.artifactId}/download`);
    expect(artifactB.url).toBe(`/api/artifacts/${artifactB.artifactId}/download`);

    await expectArtifact(started, USER_A, artifactA.url, htmlA);
    await expectArtifact(started, USER_B, artifactB.url, htmlB);
    await apiError(get(started, USER_B, artifactA.url), 404);
    await apiError(get(started, USER_A, artifactB.url), 404);

    const abortArtifact = await json<ArtifactResponse>(mutate(
      started,
      USER_A,
      csrfA,
      'POST',
      '/api/artifacts/save',
      { title: 'abort', html: `<h1>abort</h1>${'x'.repeat(2 * 1024 * 1024)}` },
    ));
    await abortDownload(started, USER_A, abortArtifact.url);
    expect((await get(started, USER_A, '/api/hosted/session')).status).toBe(200);

    for (const path of [
      `/api/projects/${projectA.id}/raw/index.html`,
      `/api/projects/${projectA.id}/export/index.html`,
      `/api/projects/${projectA.id}/archive/import`,
      `/api/artifacts/${artifactA.artifactId}`,
      `/api/artifacts/${artifactA.artifactId}/raw`,
      `/artifacts/${artifactA.artifactId}/index.html`,
    ]) {
      await apiError(get(started, USER_A, path), 404, 'HOSTED_ROUTE_NOT_ALLOWED');
    }
  });
});

interface PreviewResponse {
  readonly url: string;
  readonly file: string;
  readonly csp: string;
  readonly iframeSandbox: string;
  readonly opaqueOrigin: true;
}

interface ArtifactResponse {
  readonly artifactId: string;
  readonly url: string;
  readonly lint: readonly unknown[];
}

async function start(): Promise<StartedServer> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'readable-hosted-pr08-'));
  const counters = new Map<string, number>();
  runtimeRoots.push(runtimeRoot);
  const started = await startHostedServer({
    host: '127.0.0.1',
    port: 0,
    publicOrigin: PUBLIC_ORIGIN,
    runtimeRoot,
    testComposition: {
      createEntityId(kind, userKey) {
        const key = `${userKey}\0${kind}`;
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        return `same-${kind}-${next}`;
      },
      resolveIdentity(request) {
        const user = request.headers.authorization?.replace(/^Bearer\s+/iu, '');
        if (user === USER_A) return { userKey: USER_A, sessionKey: 'session-a' };
        if (user === USER_B) return { userKey: USER_B, sessionKey: 'session-b' };
        return null;
      },
    },
  });
  startedServers.push(started);
  return started;
}

async function createProject(
  started: StartedServer,
  user: string,
  csrf: string,
  title: string,
): Promise<Project> {
  const body = await json<{ project: Project }>(mutate(
    started,
    user,
    csrf,
    'POST',
    '/api/projects',
    { title, kind: 'prototype' },
  ));
  return body.project;
}

async function csrfPair(started: StartedServer): Promise<readonly [string, string]> {
  return Promise.all([getCsrf(started, USER_A), getCsrf(started, USER_B)]);
}

async function getCsrf(started: StartedServer, user: string): Promise<string> {
  const body = await json<{ csrfToken: string }>(get(started, user, '/api/hosted/session'));
  return body.csrfToken;
}

function get(started: StartedServer, user: string, path: string): Promise<Response> {
  return fetch(`${started.url}${path}`, { headers: auth(user) });
}

function abortDownload(started: StartedServer, user: string, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${started.url}${path}`, { headers: auth(user) }, (response) => {
      response.once('close', resolve);
      response.destroy();
    });
    request.once('error', reject);
    request.end();
  });
}

function mutate(
  started: StartedServer,
  user: string,
  csrf: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${started.url}${path}`, {
    method,
    headers: {
      ...auth(user),
      'content-type': 'application/json',
      'x-readable-studio-csrf': csrf,
      origin: PUBLIC_ORIGIN,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function writeFile(
  started: StartedServer,
  user: string,
  csrf: string,
  projectId: string,
  name: string,
  content: string,
  encoding: 'utf8' | 'base64' = 'utf8',
): Promise<FileEntry> {
  const body = await json<{ file: FileEntry }>(mutate(
    started,
    user,
    csrf,
    'POST',
    `/api/projects/${projectId}/files`,
    { name, content, encoding },
  ));
  return body.file;
}

async function readFile(
  started: StartedServer,
  user: string,
  projectId: string,
  name: string,
): Promise<string> {
  const response = await get(started, user, `/api/projects/${projectId}/files/${pathUrl(name)}`);
  const body = await response.text();
  expect(response.status, body).toBe(200);
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('cache-control')).toBe('no-store');
  return body;
}

async function upload(
  started: StartedServer,
  user: string,
  csrf: string,
  projectId: string,
  content: string,
): Promise<{ name: string; originalName: string; mime: string; size: number }> {
  const form = new FormData();
  form.set('dir', 'inbox');
  form.append('files', new Blob([content], { type: 'text/plain' }), 'same.txt');
  const body = await json<{ files: Array<{
    name: string;
    originalName: string;
    mime: string;
    size: number;
  }> }>(fetch(`${started.url}/api/projects/${projectId}/upload`, {
    method: 'POST',
    headers: {
      ...auth(user),
      'x-readable-studio-csrf': csrf,
      origin: PUBLIC_ORIGIN,
    },
    body: form,
  }));
  expect(body.files).toHaveLength(1);
  return body.files[0]!;
}

async function expectArtifact(
  started: StartedServer,
  user: string,
  path: string,
  html: string,
): Promise<void> {
  const response = await get(started, user, path);
  const body = await response.text();
  expect(response.status, body).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(response.headers.get('content-disposition')).toContain('attachment');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(body).toBe(html);
}

function maliciousHtml(owner: string): string {
  return '<!doctype html><title>' + owner + '</title>'
    + '<form action="/api/projects" method="post"><button>submit</button></form>'
    + '<script>fetch("/api/projects");new WebSocket("wss://host.invalid");top.location="/api/hosted/session"</script>';
}

function auth(user: string): Record<string, string> {
  return { authorization: `Bearer ${user}` };
}

function pathUrl(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

async function json<T>(responsePromise: Promise<Response>): Promise<T> {
  const response = await responsePromise;
  const text = await response.text();
  expect(response.status, text).toBeGreaterThanOrEqual(200);
  expect(response.status, text).toBeLessThan(300);
  return JSON.parse(text) as T;
}

async function mintPreview(
  responsePromise: Promise<Response>,
): Promise<{ readonly scope: PreviewResponse; readonly cookie: string }> {
  const response = await responsePromise;
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const setCookie = response.headers.get('set-cookie');
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('SameSite=Strict');
  expect(setCookie).toContain('Secure');
  const cookie = setCookie?.split(';', 1)[0];
  if (cookie == null) throw new Error('preview browser-binding cookie is missing');
  return { scope: JSON.parse(text) as PreviewResponse, cookie };
}

async function success(responsePromise: Promise<Response>): Promise<void> {
  const response = await responsePromise;
  const text = await response.text();
  expect(response.status, text).toBeGreaterThanOrEqual(200);
  expect(response.status, text).toBeLessThan(300);
}

async function apiError(
  responsePromise: Promise<Response>,
  status: number,
  code?: string,
): Promise<void> {
  const response = await responsePromise;
  const text = await response.text();
  expect(response.status, text).toBe(status);
  const body = JSON.parse(text) as { error?: { code?: string } };
  if (code) expect(body).toMatchObject({ error: { code } });
  else expect(body.error?.code).not.toBe('HOSTED_ROUTE_NOT_ALLOWED');
}

async function bodyOnFailure(response: Response): Promise<string> {
  return response.ok ? '' : response.clone().text();
}

async function removeRuntimeRoot(runtimeRoot: string): Promise<void> {
  const expectedPrefix = join(tmpdir(), 'readable-hosted-pr08-');
  if (!runtimeRoot.startsWith(expectedPrefix)) {
    throw new Error(`refusing to remove unexpected runtime root: ${runtimeRoot}`);
  }
  await rm(runtimeRoot, { recursive: true, force: true });
}
