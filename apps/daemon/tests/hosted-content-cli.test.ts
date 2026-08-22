import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const daemonRoot = fileURLToPath(new URL('..', import.meta.url));
const cliEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const projectId = 'project-1';
const artifactId = `oda_${'A'.repeat(43)}`;

type RequestRecord = {
  body: Buffer;
  headers: http.IncomingHttpHeaders;
  method: string;
  url: string;
};

const requests: RequestRecord[] = [];
let baseOrigin = '';
let csrfSequence = 0;
let retryWrite = true;
let retryRun = true;
let dropRunResponse = true;
let server: http.Server;
let tempRoot: string;
let identityFile: string;

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'readable-hosted-content-cli-'));
  identityFile = path.join(tempRoot, 'identity.txt');
  await writeFile(identityFile, 'identity-secret\n');
  server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const record: RequestRecord = {
      body: Buffer.concat(chunks),
      headers: request.headers,
      method: request.method ?? 'GET',
      url: request.url ?? '/',
    };
    requests.push(record);

    if (record.url === '/api/hosted/session') {
      csrfSequence += 1;
      return json(response, {
        publicOrigin: baseOrigin,
        csrfToken: `csrf-${csrfSequence}`,
        csrfExpiresAt: Date.now() + 60_000,
        providers: [],
      });
    }
    if (record.url === `/api/projects/${projectId}/files?since=0`) {
      return json(response, { files: [{ name: 'src/a.txt', size: 1 }] });
    }
    if (record.url === `/api/projects/${projectId}/files?since=999`) {
      response.writeHead(307, { location: 'https://attacker.example/files' }).end();
      return;
    }
    if (record.url === `/api/projects/${projectId}/files/src/a.txt` && record.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('A');
      return;
    }
    if (record.url === `/api/projects/${projectId}/files` && record.method === 'POST') {
      const body = JSON.parse(record.body.toString('utf8')) as { name: string };
      if (body.name === 'retry.txt' && retryWrite) {
        retryWrite = false;
        return json(response, { error: { code: 'HOSTED_CSRF_INVALID' } }, 419);
      }
      return json(response, { file: { name: body.name } });
    }
    if (record.url === `/api/projects/${projectId}/files/rename`) {
      return json(response, { ok: true });
    }
    if (record.url === `/api/projects/${projectId}/files/src/old.txt` && record.method === 'DELETE') {
      return json(response, { ok: true });
    }
    if (record.url.startsWith(`/api/projects/${projectId}/search?`)) {
      return json(response, { matches: [{ file: 'src/a.txt', line: 1, snippet: 'hello' }] });
    }
    if (record.url === `/api/projects/${projectId}/folders`) {
      return json(response, record.method === 'GET' ? { folders: [{ path: 'src' }] } : { ok: true });
    }
    if (record.url === `/api/projects/${projectId}/upload`) {
      return json(response, { files: [{ name: 'assets/upload.txt' }] });
    }
    if (record.url === `/api/projects/${projectId}/files/preview`) {
      return json(response, { url: `/api/projects/${projectId}/preview/scope/src/a.txt` });
    }
    if (record.url === `/api/projects/${projectId}/preview-url`) {
      return json(response, { url: `/api/projects/${projectId}/preview/scope/src/a.txt` });
    }
    if (record.url === `/api/projects/${projectId}/archive?root=src`) {
      response.writeHead(200, { 'content-type': 'application/zip' }).end('ZIP');
      return;
    }
    if (record.url === `/api/projects/${projectId}/export/manifest`) {
      return json(response, { projectId, files: [] });
    }
    if (record.url === '/api/projects' && record.method === 'POST') {
      return json(response, {
        project: { id: projectId, name: 'Hosted project', createdAt: 1, updatedAt: 1, status: 'active' },
      }, 201);
    }
    if (record.url === `/api/projects/${projectId}/conversations` && record.method === 'POST') {
      return json(response, {
        conversation: {
          id: 'conversation-1', projectId, title: 'Build', sessionMode: 'design', messageCount: 0,
          createdAt: 1, updatedAt: 1, totalDurationMs: 0, latestRun: null,
        },
      }, 201);
    }
    if (/^\/api\/projects\/project-1\/conversations\/conversation-1\/messages\/[A-Za-z0-9_-]+$/u.test(record.url) && record.method === 'PUT') {
      return json(response, { message: { id: record.url.split('/').at(-1), ...JSON.parse(record.body.toString('utf8')) } });
    }
    if (record.url === '/api/runs' && record.method === 'POST') {
      if (retryRun) {
        retryRun = false;
        return json(response, { error: { code: 'HOSTED_CSRF_INVALID' } }, 419);
      }
      if (dropRunResponse) {
        dropRunResponse = false;
        response.writeHead(202, {
          'content-length': '1024',
          'content-type': 'application/json',
        });
        response.end('{"runId":"');
        return;
      }
      const body = JSON.parse(record.body.toString('utf8')) as { conversationId: string; assistantMessageId: string };
      return json(response, { runId: 'run-1', conversationId: body.conversationId, assistantMessageId: body.assistantMessageId }, 202);
    }
    if (record.url === '/api/runs/run-1/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('id: 1\nevent: agent\ndata: {"type":"text_delta","delta":"Done"}\n\nid: 2\nevent: end\ndata: {"status":"succeeded","code":0}\n\n');
      return;
    }
    if (record.url === '/api/runs/run-1/cancel' && record.method === 'POST') {
      return json(response, { ok: true });
    }
    if (record.url === '/api/artifacts/save') {
      return json(response, { artifactId, url: `/api/artifacts/${artifactId}/download`, lint: [] });
    }
    if (record.url === '/api/artifacts/lint') {
      return json(response, { findings: [], agentMessage: 'clean' });
    }
    if (record.url === `/api/artifacts/${artifactId}/download`) {
      response.writeHead(200, { 'content-type': 'text/html' }).end('<h1>saved</h1>');
      return;
    }
    json(response, { error: { code: 'NOT_FOUND', message: record.url } }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address == null || typeof address === 'string') throw new Error('test server did not bind');
  baseOrigin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(tempRoot, { recursive: true, force: true });
});

describe('hosted PR08 content CLI', () => {
  it('uses the frozen file, search, folder, and canonical wildcard routes', async () => {
    expect((await runCli(['files', 'list', projectId, '--since', '0', '--json'])).stdout)
      .toContain('src/a.txt');
    expect((await runCli(['files', 'read', projectId, 'src/a.txt'])).stdout).toBe('A');
    await runCli(['files', 'write', projectId, 'src/new.txt', '--json'], 'hello');
    await runCli(['files', 'rename', projectId, 'src/new.txt', 'src/renamed.txt', '--json']);
    await runCli(['files', 'delete', projectId, 'src/old.txt', '--json']);
    await runCli(['files', 'search', projectId, '--query', 'hello', '--pattern', '*.txt', '--max', '10', '--json']);
    await runCli(['files', 'folders', 'list', projectId, '--json']);
    await runCli(['files', 'folders', 'create', projectId, 'assets/images', '--json']);
    await runCli(['files', 'folders', 'delete', projectId, 'assets/images', '--json']);

    const content = contentRequests();
    expect(content.map(({ method, url }) => [method, url])).toEqual([
      ['GET', `/api/projects/${projectId}/files?since=0`],
      ['GET', `/api/projects/${projectId}/files/src/a.txt`],
      ['POST', `/api/projects/${projectId}/files`],
      ['POST', `/api/projects/${projectId}/files/rename`],
      ['DELETE', `/api/projects/${projectId}/files/src/old.txt`],
      ['GET', `/api/projects/${projectId}/search?q=hello&pattern=*.txt&max=10`],
      ['GET', `/api/projects/${projectId}/folders`],
      ['POST', `/api/projects/${projectId}/folders`],
      ['DELETE', `/api/projects/${projectId}/folders`],
    ]);
    expect(JSON.parse(content[2]!.body.toString('utf8'))).toEqual({
      name: 'src/new.txt', content: 'hello', encoding: 'utf8',
    });
    expect(JSON.parse(content[3]!.body.toString('utf8'))).toEqual({
      from: 'src/new.txt', to: 'src/renamed.txt',
    });
    expect(JSON.parse(content[7]!.body.toString('utf8'))).toEqual({ path: 'assets/images' });
    expect(JSON.parse(content[8]!.body.toString('utf8'))).toEqual({ path: 'assets/images' });
    expectAuthorized(content);
  }, 30_000);

  it('uses multipart upload, POST preview DTOs, archive, and export manifest routes', async () => {
    requests.length = 0;
    const upload = path.join(tempRoot, 'upload.txt');
    await writeFile(upload, 'upload-body');
    await runCli(['files', 'upload', projectId, upload, '--as', 'assets/upload.txt', '--json']);
    await runCli(['files', 'preview', projectId, 'src/a.txt', '--json']);
    await runCli(['files', 'preview-url', projectId, 'src/a.txt', '--json']);
    expect((await runCli(['files', 'archive', projectId, '--root', 'src'])).stdout).toBe('ZIP');
    expect((await runCli(['files', 'export-manifest', projectId, '--json'])).stdout)
      .toContain(projectId);

    const content = contentRequests();
    expect(content.map(({ method, url }) => [method, url])).toEqual([
      ['POST', `/api/projects/${projectId}/upload`],
      ['POST', `/api/projects/${projectId}/files/preview`],
      ['POST', `/api/projects/${projectId}/preview-url`],
      ['GET', `/api/projects/${projectId}/archive?root=src`],
      ['GET', `/api/projects/${projectId}/export/manifest`],
    ]);
    expect(content[0]!.headers['content-type']).toContain('multipart/form-data; boundary=');
    expect(content[0]!.body.toString('utf8')).toContain('name="dir"\r\n\r\nassets');
    expect(content[0]!.body.toString('utf8')).toContain('filename="upload.txt"');
    expect(JSON.parse(content[1]!.body.toString('utf8'))).toEqual({ path: 'src/a.txt' });
    expect(JSON.parse(content[2]!.body.toString('utf8'))).toEqual({ file: 'src/a.txt' });
    expectAuthorized(content);
  }, 30_000);

  it('exposes hosted artifact save, lint, and opaque download without raw routes', async () => {
    requests.length = 0;
    const html = path.join(tempRoot, 'artifact.html');
    await writeFile(html, '<h1>saved</h1>');
    const saved = await runCli([
      'artifacts', 'save', '--html-file', html, '--identifier', 'hero', '--title', 'Hero', '--json',
    ]);
    expect(JSON.parse(saved.stdout)).toMatchObject({ artifactId });
    expect((await runCli(['artifacts', 'lint', '--html-file', html, '--json'])).stdout)
      .toContain('findings');
    expect((await runCli(
      ['artifacts', 'download', artifactId],
      undefined,
      true,
      false,
      { READABLE_HOSTED_IDENTITY_TOKEN_FILE: identityFile },
    )).stdout).toBe('<h1>saved</h1>');

    const content = contentRequests();
    expect(content.map(({ method, url }) => [method, url])).toEqual([
      ['POST', '/api/artifacts/save'],
      ['POST', '/api/artifacts/lint'],
      ['GET', `/api/artifacts/${artifactId}/download`],
    ]);
    expect(JSON.parse(content[0]!.body.toString('utf8'))).toEqual({
      html: '<h1>saved</h1>', identifier: 'hero', title: 'Hero',
    });
    expect(content.every(({ url }) => !url.includes('/raw/'))).toBe(true);
    expectAuthorized(content);
  }, 30_000);

  it('retries one 419 with an identical body and rejects traversal or competing stdin', async () => {
    requests.length = 0;
    retryWrite = true;
    await runCli(['files', 'write', projectId, 'retry.txt', '--json'], 'same-body');
    const writes = contentRequests().filter(({ url }) => url.endsWith('/files'));
    expect(writes).toHaveLength(2);
    expect(writes[0]!.body).toEqual(writes[1]!.body);
    expect(writes[0]!.headers['x-readable-studio-csrf']).not.toBe(writes[1]!.headers['x-readable-studio-csrf']);

    requests.length = 0;
    const traversal = await runCli(
      ['files', 'delete', projectId, '../secret.txt', '--json'],
      undefined,
      false,
    );
    expect(traversal.code).toBe(2);
    expect(traversal.stderr).toContain('canonical relative path');
    expect(contentRequests()).toEqual([]);

    const redirected = await runCli(
      ['files', 'list', projectId, '--since', '999', '--json'],
      undefined,
      false,
    );
    expect(redirected.code).toBe(1);
    expect(redirected.stderr).toContain('cross-origin redirect');
    expect(`${redirected.stdout}${redirected.stderr}`).not.toContain('identity-secret');

    const conflict = await runCli(
      ['files', 'write', projectId, 'safe.txt', '--identity-token-file', '-'],
      'identity-secret\ncontent',
      false,
      false,
    );
    expect(conflict.code).toBe(2);
    expect(conflict.stderr).toContain('stdin cannot supply both');
    expect(`${conflict.stdout}${conflict.stderr}`).not.toContain('identity-secret');
  }, 30_000);

  it('preserves the existing local JSON upload route when hosted identity is absent', async () => {
    requests.length = 0;
    const upload = path.join(tempRoot, 'local-upload.txt');
    await writeFile(upload, 'local');
    await runCli(
      ['files', 'upload', projectId, upload, '--as', 'local-upload.txt', '--json'],
      undefined,
      true,
      false,
    );
    const [request] = contentRequests();
    expect(request).toMatchObject({ method: 'POST', url: `/api/projects/${projectId}/files` });
    expect(request!.headers.authorization).toBeUndefined();
    expect(JSON.parse(request!.body.toString('utf8'))).toEqual({
      name: 'local-upload.txt',
      content: Buffer.from('local').toString('base64'),
      encoding: 'base64',
    });
  });

  it('uses hosted authority and stable ids for the core project and run workflow', async () => {
    requests.length = 0;
    retryRun = true;
    dropRunResponse = true;
    await runCli(['project', 'create', '--name', 'Hosted project', '--json']);
    await runCli(['conversation', 'new', projectId, '--title', 'Build', '--json']);
    const followed = await runCli([
      'run', 'start', '--project', projectId, '--conversation', 'conversation-1',
      '--message', 'Build it', '--follow', '--json',
    ]);
    await runCli(['run', 'cancel', 'run-1', '--json']);

    expect(followed.stdout.trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { event: 'agent', data: { type: 'text_delta', delta: 'Done' } },
      { event: 'end', data: { status: 'succeeded', code: 0 } },
    ]);
    const core = contentRequests();
    expectAuthorized(core);
    expect(JSON.parse(core.find(({ url, method }) => url === '/api/projects' && method === 'POST')!.body.toString('utf8')))
      .toEqual({ title: 'Hosted project' });
    const runRequests = core.filter(({ url, method }) => url === '/api/runs' && method === 'POST');
    expect(runRequests).toHaveLength(3);
    expect(runRequests.every(({ body }) => body.equals(runRequests[0]!.body))).toBe(true);
    const intent = JSON.parse(runRequests[0]!.body.toString('utf8')) as Record<string, unknown>;
    expect(intent).toMatchObject({
      projectId,
      conversationId: 'conversation-1',
      agentId: 'pi',
      message: 'Build it',
    });
    expect(intent.clientRequestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(intent.assistantMessageId).toMatch(/^[0-9a-f-]{36}$/u);
    const messageWrites = core.filter(({ url, method }) => url.includes('/messages/') && method === 'PUT');
    expect(messageWrites.map(({ body }) => JSON.parse(body.toString('utf8')))).toEqual([
      { role: 'user', content: 'Build it' },
      { role: 'assistant', content: '' },
    ]);
    expect(messageWrites[1]!.url).toContain(`/messages/${intent.assistantMessageId}`);
  }, 30_000);
});

function json(response: http.ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function contentRequests(): RequestRecord[] {
  return requests.filter(({ url }) => url !== '/api/hosted/session');
}

function expectAuthorized(records: RequestRecord[]): void {
  for (const record of records) {
    expect(record.headers.authorization).toBe('Bearer identity-secret');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(record.method)) {
      expect(record.headers.origin).toBe(baseOrigin);
      expect(record.headers['x-readable-studio-csrf']).toMatch(/^csrf-/u);
    }
  }
}

async function runCli(
  args: string[],
  input?: string,
  expectSuccess = true,
  addIdentity = true,
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stderr: string; stdout: string }> {
  const fullArgs = [
    '--import', 'tsx', cliEntry, ...args,
    '--daemon-url', baseOrigin,
    ...(addIdentity ? ['--identity-token-file', identityFile] : []),
  ];
  const result = await new Promise<{ code: number; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, fullArgs, {
      cwd: daemonRoot,
      env: { ...process.env, READABLE_HOSTED_IDENTITY_TOKEN_FILE: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? -1, stderr, stdout }));
    child.stdin.end(input);
  });
  if (expectSuccess && result.code !== 0) {
    throw new Error(`CLI failed (${result.code}): ${result.stderr}`);
  }
  return result;
}
