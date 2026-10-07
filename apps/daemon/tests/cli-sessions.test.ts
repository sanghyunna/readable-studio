import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const daemonRoot = fileURLToPath(new URL('..', import.meta.url));
const cliEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

type RequestRecord = { body: unknown; method: string; url: string };

const KNOWN_FOLDER = 'folder-1';
const session = {
  id: 'session-1', projectId: 'workspace-1', folderId: null as string | null, title: 'Draft',
  sessionMode: 'design', messageCount: 0, createdAt: 1, updatedAt: 1,
};
const folder = { id: KNOWN_FOLDER, name: 'Research', createdAt: 1, updatedAt: 1 };
const railSession = { ...session, workspaceId: 'workspace-1', state: 'idle', workspaceSessionCount: 1 };

const requests: RequestRecord[] = [];
let baseOrigin = '';
let server: http.Server;
let tempRoot: string;

function json(response: http.ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'readable-session-cli-'));
  server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    const method = request.method ?? 'GET';
    const url = request.url ?? '/';
    requests.push({ body: raw ? JSON.parse(raw) : undefined, method, url });
    const body = raw ? JSON.parse(raw) : {};

    if (method === 'POST' && url === '/api/sessions') {
      if (body.folderId && body.folderId !== KNOWN_FOLDER) {
        return json(response, { error: { code: 'NOT_FOUND', message: 'folder not found' } }, 404);
      }
      return json(response, {
        session: { ...session, folderId: body.folderId ?? null },
        workspace: { id: 'workspace-1', name: 'Draft' },
      });
    }
    if (method === 'GET' && url.startsWith('/api/sessions?')) return json(response, { sessions: [railSession] });
    if (method === 'GET' && url === '/api/rail') {
      return json(response, { folders: [{ ...folder, sessions: [] }], recents: [railSession], generatedAt: 1 });
    }
    if (method === 'GET' && url === '/api/sessions/session-1') return json(response, { session });
    if (method === 'PATCH' && url === '/api/sessions/session-1') {
      if (body.folderId && body.folderId !== KNOWN_FOLDER) {
        return json(response, { error: { code: 'NOT_FOUND', message: 'folder not found' } }, 404);
      }
      return json(response, { session: { ...session, ...body } });
    }
    if (method === 'DELETE' && url === '/api/sessions/session-1') return json(response, { ok: true });
    if (method === 'POST' && url === '/api/folders') return json(response, { folder: { ...folder, name: body.name } });
    if (method === 'GET' && url === '/api/folders') return json(response, { folders: [folder] });
    if (method === 'PATCH' && url === `/api/folders/${KNOWN_FOLDER}`) {
      return json(response, { folder: { ...folder, name: body.name } });
    }
    if (method === 'DELETE' && url.startsWith(`/api/folders/${KNOWN_FOLDER}?`)) {
      return json(response, { ok: true, movedSessionIds: ['session-1'], deletedSessionIds: [] });
    }
    json(response, { error: { code: 'NOT_FOUND', message: url } }, 404);
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

beforeEach(() => {
  requests.length = 0;
});

async function runCli(args: string[], input?: string): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', cliEntry, ...args, '--daemon-url', baseOrigin],
      {
        cwd: daemonRoot,
        env: { ...process.env, READABLE_HOSTED_IDENTITY_TOKEN_FILE: '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? -1, stderr, stdout }));
    child.stdin.end(input);
  });
}

function sent() {
  return requests.map(({ method, url }) => [method, url]);
}

describe('readable session', () => {
  it('creates sessions with flags, a prompt file, and stdin, printing the raw envelope under --json', async () => {
    const promptFile = path.join(tempRoot, 'prompt.txt');
    await writeFile(promptFile, 'Build a landing page\nwith two sections');

    const created = await runCli([
      'session', 'new', '--folder', KNOWN_FOLDER, '--title', 'Landing', '--mode', 'chat',
      '--skill', 'web-skill', '--design-system', 'ds-1', '--prompt-file', promptFile, '--json',
    ]);
    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({
      session: { ...session, folderId: KNOWN_FOLDER },
      workspace: { id: 'workspace-1', name: 'Draft' },
    });

    const piped = await runCli(['session', 'new', '--prompt-file', '-'], 'from stdin');
    expect(piped.code).toBe(0);
    expect(piped.stdout).toContain('[session] created session-1');

    expect(sent()).toEqual([['POST', '/api/sessions'], ['POST', '/api/sessions']]);
    expect(requests[0]!.body).toEqual({
      folderId: KNOWN_FOLDER,
      title: 'Landing',
      conversationMode: 'chat',
      skillId: 'web-skill',
      designSystemId: 'ds-1',
      pendingPrompt: 'Build a landing page\nwith two sections',
    });
    expect(requests[1]!.body).toEqual({ pendingPrompt: 'from stdin' });
  }, 60_000);

  it('lists, trees, and reads sessions through the frozen routes', async () => {
    const recent = await runCli(['session', 'list', '--recent', '--limit', '5', '--json']);
    expect(JSON.parse(recent.stdout)).toEqual({ sessions: [railSession] });
    await runCli(['session', 'list', '--folder', KNOWN_FOLDER]);
    const tree = await runCli(['session', 'tree', '--json']);
    expect(JSON.parse(tree.stdout)).toMatchObject({ folders: [{ id: KNOWN_FOLDER }], recents: [{ id: 'session-1' }] });
    const info = await runCli(['session', 'info', 'session-1', '--json']);
    expect(JSON.parse(info.stdout)).toEqual({ session });

    expect(sent()).toEqual([
      ['GET', '/api/sessions?folder=none&limit=5'],
      ['GET', `/api/sessions?folder=${KNOWN_FOLDER}`],
      ['GET', '/api/rail'],
      ['GET', '/api/sessions/session-1'],
    ]);
  }, 60_000);

  it('renames, moves (folder none sends null), and deletes', async () => {
    const renamed = await runCli(['session', 'rename', 'session-1', '--title', 'Renamed', '--json']);
    expect(JSON.parse(renamed.stdout)).toEqual({ session: { ...session, title: 'Renamed' } });
    const into = await runCli(['session', 'move', 'session-1', '--folder', KNOWN_FOLDER, '--json']);
    expect(JSON.parse(into.stdout).session.folderId).toBe(KNOWN_FOLDER);
    const out = await runCli(['session', 'move', 'session-1', '--folder', 'none', '--json']);
    expect(JSON.parse(out.stdout).session.folderId).toBeNull();
    const removed = await runCli(['session', 'delete', 'session-1', '--json']);
    expect(JSON.parse(removed.stdout)).toEqual({ ok: true });

    expect(sent()).toEqual([
      ['PATCH', '/api/sessions/session-1'],
      ['PATCH', '/api/sessions/session-1'],
      ['PATCH', '/api/sessions/session-1'],
      ['DELETE', '/api/sessions/session-1'],
    ]);
    expect(requests[0]!.body).toEqual({ title: 'Renamed' });
    expect(requests[1]!.body).toEqual({ folderId: KNOWN_FOLDER });
    expect(requests[2]!.body).toEqual({ folderId: null });
  }, 60_000);

  it('exits non-zero with the API error for an unknown folder, and 2 for bad usage', async () => {
    const move = await runCli(['session', 'move', 'session-1', '--folder', 'missing']);
    expect(move.code).not.toBe(0);
    expect(JSON.parse(move.stderr.trim()).error.message).toBe('folder not found');

    const create = await runCli(['session', 'new', '--folder', 'missing', '--title', 'x']);
    expect(create.code).not.toBe(0);
    expect(create.stderr).toContain('folder not found');

    const noFolder = await runCli(['session', 'move', 'session-1']);
    expect(noFolder.code).toBe(2);
    const both = await runCli(['session', 'list', '--recent', '--folder', KNOWN_FOLDER]);
    expect(both.code).toBe(2);
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'PATCH /api/sessions/session-1',
      'POST /api/sessions',
    ]);
  }, 60_000);
});

describe('readable folder', () => {
  it('creates, lists, renames, and deletes with the keep/delete policy', async () => {
    const created = await runCli(['folder', 'create', '--name', 'Research', '--json']);
    expect(JSON.parse(created.stdout)).toEqual({ folder });
    const listed = await runCli(['folder', 'list', '--json']);
    expect(JSON.parse(listed.stdout)).toEqual({ folders: [folder] });
    const renamed = await runCli(['folder', 'rename', KNOWN_FOLDER, '--name', 'Notes', '--json']);
    expect(JSON.parse(renamed.stdout)).toEqual({ folder: { ...folder, name: 'Notes' } });
    const kept = await runCli(['folder', 'delete', KNOWN_FOLDER, '--json']);
    expect(JSON.parse(kept.stdout)).toEqual({ ok: true, movedSessionIds: ['session-1'], deletedSessionIds: [] });
    await runCli(['folder', 'delete', KNOWN_FOLDER, '--sessions', 'delete']);

    expect(sent()).toEqual([
      ['POST', '/api/folders'],
      ['GET', '/api/folders'],
      ['PATCH', `/api/folders/${KNOWN_FOLDER}`],
      ['DELETE', `/api/folders/${KNOWN_FOLDER}?sessions=keep`],
      ['DELETE', `/api/folders/${KNOWN_FOLDER}?sessions=delete`],
    ]);
    expect(requests[0]!.body).toEqual({ name: 'Research' });
    expect(requests[2]!.body).toEqual({ name: 'Notes' });
  }, 60_000);

  it('fails non-zero for an unknown folder and rejects an invalid --sessions value', async () => {
    const rename = await runCli(['folder', 'rename', 'missing', '--name', 'x']);
    expect(rename.code).not.toBe(0);
    expect(rename.stderr).toContain('/api/folders/missing');

    const bad = await runCli(['folder', 'delete', KNOWN_FOLDER, '--sessions', 'purge']);
    expect(bad.code).toBe(2);
    const noName = await runCli(['folder', 'create']);
    expect(noName.code).toBe(2);
    expect(sent()).toEqual([['PATCH', '/api/folders/missing']]);
  }, 60_000);
});
