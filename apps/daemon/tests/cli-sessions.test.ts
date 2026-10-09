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

// A rail with every shape the UI's search, filter and sort distinguish.
const rs = (id: string, folderId: string | null, title: string | null, state: string, updatedAt: number, shared = 1) => ({
  id, workspaceId: `ws-${id}`, folderId, title, sessionMode: 'design', createdAt: 1, updatedAt,
  messageCount: 1, state, workspaceSessionCount: shared,
});
const sA1 = rs('s-a1', KNOWN_FOLDER, 'Deck draft', 'running', 50, 2);
const sA2 = rs('s-a2', KNOWN_FOLDER, null, 'idle', 40, 2);
const sB1 = rs('s-b1', 'folder-2', 'Summary', 'awaiting', 30);
const sR2 = rs('s-r2', null, 'Failed deck', 'failed', 60);
const railFolders = [
  { ...folder, updatedAt: 5, sessions: [sA1, sA2] },
  { id: 'folder-2', name: 'Notes', createdAt: 1, updatedAt: 9, sessions: [sB1] },
  { id: 'folder-3', name: 'Archive deck', createdAt: 1, updatedAt: 1, sessions: [] },
];
const rail = { folders: railFolders, recents: [railSession, sR2], generatedAt: 1 };
const listedFolders = [railFolders[0], railFolders[2], railFolders[1]].map((f) => {
  if (!f) throw new Error('unexpected missing folder');
  const { sessions, ...rest } = f;
  return rest;
});
const withName = (s: { folderId: string | null }, folderName: string | null) => ({ ...s, folderName });

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
    if (method === 'GET' && url === '/api/rail') return json(response, rail);
    if (method === 'GET' && url === '/api/sessions/s-a1') {
      return json(response, { session: { ...session, id: 's-a1', projectId: 'ws-s-a1', folderId: KNOWN_FOLDER, title: 'Deck draft' } });
    }
    if (url === '/api/sessions/missing') {
      return json(response, { error: { code: 'CONVERSATION_NOT_FOUND', message: 'session not found' } }, 404);
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
    if (method === 'GET' && url === '/api/folders') return json(response, { folders: listedFolders });
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

async function runCli(args: string[], input?: string, withDaemonUrl = true): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', cliEntry, ...args, ...(withDaemonUrl ? ['--daemon-url', baseOrigin] : [])],
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
    const recent = await runCli(['session', 'list', '--recent', '--limit', '1', '--json']);
    expect(JSON.parse(recent.stdout)).toEqual({ sessions: [withName(sR2, null)] });
    const inFolder = await runCli(['session', 'list', '--folder', KNOWN_FOLDER]);
    expect(inFolder.stdout.trim().split('\n')).toEqual([
      's-a1\tResearch\tDeck draft\trunning\t2',
      's-a2\tResearch\t-\tidle\t2',
    ]);
    const tree = await runCli(['session', 'tree', '--json']);
    expect(JSON.parse(tree.stdout)).toEqual(rail);
    const info = await runCli(['session', 'info', 'session-1', '--json']);
    expect(JSON.parse(info.stdout)).toEqual({ session, folderName: null, state: 'idle', workspaceSessionCount: 1 });
    const infoText = await runCli(['session', 'info', 'session-1']);
    expect(infoText.stdout).toMatch(/^folder: +프로젝트 없음$/m);
    expect(infoText.stdout).toMatch(/^state: +idle$/m);
    expect(infoText.stdout).toMatch(/^shared: +no$/m);
    const shared = await runCli(['session', 'info', 's-a1']);
    expect(shared.stdout).toMatch(/^folder: +Research \(folder-1\)$/m);
    expect(shared.stdout).toMatch(/^state: +running$/m);
    expect(shared.stdout).toMatch(/^shared: +작업 폴더 공유 \(세션 2개\)$/m);

    expect(sent()).toEqual([
      ['GET', '/api/rail'],
      ['GET', '/api/rail'],
      ['GET', '/api/rail'],
      ['GET', '/api/sessions/session-1'],
      ['GET', '/api/rail'],
      ['GET', '/api/sessions/session-1'],
      ['GET', '/api/rail'],
      ['GET', '/api/sessions/s-a1'],
      ['GET', '/api/rail'],
    ]);
  }, 60_000);

  it('mirrors the rail search, state filters and folder sort over GET /api/rail', async () => {
    const ids = async (args: string[]) => {
      const result = await runCli([...args, '--json']);
      expect(result.code, args.join(' ')).toBe(0);
      return JSON.parse(result.stdout).sessions.map((s: { id: string }) => s.id);
    };
    // Unfiltered: every session, most recent first, with its folder name.
    expect(JSON.parse((await runCli(['session', 'list', '--json'])).stdout)).toEqual({
      sessions: [withName(sR2, null), withName(sA1, 'Research'), withName(sA2, 'Research'),
        withName(sB1, 'Notes'), withName(railSession, null)],
    });
    // Search is case-insensitive on the title; a folder-name hit keeps all its sessions;
    // an untitled session matches the rail's untitled label.
    expect(await ids(['session', 'list', '--query', '  DECK '])).toEqual(['s-r2', 's-a1']);
    expect(await ids(['session', 'list', '--query', 'research'])).toEqual(['s-a1', 's-a2']);
    expect(await ids(['session', 'list', '--query', '제목 없는'])).toEqual(['s-a2']);
    expect(await ids(['session', 'list', '--query', 'untitled'])).toEqual(['s-a2']);
    expect(await ids(['session', 'list', '--query', '제목'])).toEqual(['s-a2']);
    const untitledTree = JSON.parse((await runCli(['session', 'tree', '--query', 'untitled', '--json'])).stdout);
    expect(untitledTree.folders.flatMap((f: { sessions: { id: string }[] }) => f.sessions.map((s) => s.id))).toEqual(['s-a2']);
    expect(untitledTree.recents.map((s: { id: string }) => s.id)).toEqual([]);
    const untitledTreeKo = JSON.parse((await runCli(['session', 'tree', '--query', '제목', '--json'])).stdout);
    expect(untitledTreeKo.folders.flatMap((f: { sessions: { id: string }[] }) => f.sessions.map((s) => s.id))).toEqual(['s-a2']);
    expect(untitledTreeKo.recents.map((s: { id: string }) => s.id)).toEqual([]);
    // 확인 필요 = awaiting or failed; 실행 중 = running.
    expect(await ids(['session', 'list', '--state', 'attention'])).toEqual(['s-r2', 's-b1']);
    expect(await ids(['session', 'list', '--state', 'running'])).toEqual(['s-a1']);
    expect(await ids(['session', 'list', '--state', 'all', '--recent'])).toEqual(['s-r2', 'session-1']);
    expect(await ids(['session', 'list', '--recent', '--state', 'attention', '--query', 'deck', '--limit', '1'])).toEqual(['s-r2']);
    expect((await runCli(['session', 'list', '--query', 'no such title'])).stdout.trim()).toBe('No sessions match.');

    // The tree keeps a folder whose name matches even when it has no matching session.
    const tree = JSON.parse((await runCli(['session', 'tree', '--query', 'deck', '--sort', 'name', '--json'])).stdout);
    expect(tree.folders.map((f: { id: string; sessions: { id: string }[] }) => [f.id, f.sessions.map((s) => s.id)]))
      .toEqual([['folder-3', []], [KNOWN_FOLDER, ['s-a1']]]);
    expect(tree.recents.map((s: { id: string }) => s.id)).toEqual(['s-r2']);
    const attention = JSON.parse((await runCli(['session', 'tree', '--state', 'attention', '--json'])).stdout);
    expect(attention.folders.map((f: { id: string }) => f.id)).toEqual(['folder-2']);
    const byRecent = JSON.parse((await runCli(['session', 'tree', '--sort', 'recent', '--json'])).stdout);
    expect(byRecent.folders.map((f: { id: string }) => f.id)).toEqual(['folder-2', KNOWN_FOLDER, 'folder-3']);

    const folderIds = async (sort: string) =>
      JSON.parse((await runCli(['folder', 'list', '--sort', sort, '--json'])).stdout).folders.map((f: { id: string }) => f.id);
    expect(await folderIds('name')).toEqual(['folder-3', 'folder-2', KNOWN_FOLDER]);
    expect(await folderIds('recent')).toEqual(['folder-2', KNOWN_FOLDER, 'folder-3']);

    for (const args of [['session', 'list', '--state', 'done'], ['session', 'tree', '--sort', 'size'], ['folder', 'list', '--sort', 'size']]) {
      const bad = await runCli(args);
      expect(bad.code, args.join(' ')).toBe(2);
    }
    expect(new Set(sent().map(([method, url]) => `${method} ${url}`))).toEqual(new Set(['GET /api/rail', 'GET /api/folders']));
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

describe('readable --help', () => {
  it('lists the session and folder commands', async () => {
    const result = await runCli(['--help'], undefined, false);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^ {2}readable session <new\|list\|tree\|info\|rename\|move\|delete>/m);
    expect(result.stdout).toMatch(/^ {2}readable folder <create\|list\|rename\|delete>/m);
  }, 60_000);
});

describe('readable session/folder usage errors', () => {
  const noStack = (stderr: string) => expect(stderr).not.toMatch(/\n\s+at /);

  it('rejects an unknown flag with one line plus usage and exit 2', async () => {
    for (const args of [
      ['session', 'list', '--bogus-flag'],
      ['session', 'new', '--bogus-flag', 'x'],
      ['folder', 'create', '--name', 'probe', '--bogus-flag'],
      ['folder', 'list', '--bogus-flag'],
    ]) {
      const result = await runCli(args);
      expect(result.code, args.join(' ')).toBe(2);
      expect(result.stderr.split('\n')[0]).toMatch(/^unknown flag: --bogus-flag\b/);
      expect(result.stderr).toContain('Usage:');
      noStack(result.stderr);
    }
    expect(sent()).toEqual([]);
  }, 60_000);

  it('reports a missing --prompt-file path without a stack trace', async () => {
    const missing = path.join(tempRoot, 'missing.txt');
    const result = await runCli(['session', 'new', '--prompt-file', missing]);
    expect(result.code).not.toBe(0);
    expect(result.stderr.trim()).toBe(`prompt file not found: ${missing}`);
    expect(sent()).toEqual([]);
  }, 60_000);

  it('rejects --prompt-file on verbs that do not take a prompt', async () => {
    for (const args of [
      ['folder', 'create', '--name', 'pf', '--prompt-file', '-'],
      ['session', 'rename', 'session-1', '--title', 'x', '--prompt-file', '-'],
    ]) {
      const result = await runCli(args, '');
      expect(result.code, args.join(' ')).toBe(2);
      expect(result.stderr.split('\n')[0]).toMatch(/^--prompt-file is not accepted by readable (folder create|session rename)$/);
    }
    expect(sent()).toEqual([]);
  }, 60_000);

  it('exits 2 for an invalid --limit before calling the daemon', async () => {
    for (const limit of ['abc', '0', '-1', '1.5']) {
      const result = await runCli(['session', 'list', '--limit', limit]);
      expect(result.code, limit).toBe(2);
      expect(result.stderr).toContain('--limit must be a positive integer');
    }
    expect(sent()).toEqual([]);
  }, 60_000);

  it('reports session-not-found for an unknown session on every verb', async () => {
    for (const args of [
      ['session', 'info', 'missing'],
      ['session', 'rename', 'missing', '--title', 'x'],
      ['session', 'move', 'missing', '--folder', KNOWN_FOLDER],
      ['session', 'delete', 'missing'],
    ]) {
      const result = await runCli(args);
      expect(result.code, args.join(' ')).toBe(1);
      expect(JSON.parse(result.stderr.trim()).error.code, args.join(' ')).toBe('session-not-found');
    }
  }, 60_000);
});

describe('readable folder', () => {
  it('creates, lists, renames, and deletes with the keep/delete policy', async () => {
    const created = await runCli(['folder', 'create', '--name', 'Research', '--json']);
    expect(JSON.parse(created.stdout)).toEqual({ folder });
    const listed = await runCli(['folder', 'list', '--json']);
    expect(JSON.parse(listed.stdout)).toEqual({ folders: listedFolders });
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
