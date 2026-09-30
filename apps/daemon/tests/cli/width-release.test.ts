import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
const digest = 'a'.repeat(64);
function run(args: string[], input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, 'files', 'width-release', ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('CLI did not exit')); }, 15_000);
    child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

describe('readable files width-release dispatch', () => {
  let server: http.Server;
  let base: string;
  let requests: { method: string | undefined; url: string | undefined; body: unknown }[];
  let conflict: boolean;
  beforeAll(async () => {
    server = http.createServer((request, response) => {
      let text = '';
      request.setEncoding('utf8').on('data', (chunk) => { text += chunk; });
      request.on('end', () => {
        requests.push({ method: request.method, url: request.url, body: text ? JSON.parse(text) : null });
        response.writeHead(conflict ? 409 : 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(conflict
          ? { error: { code: 'WIDTH_RELEASE_CONFLICT', message: 'Reload the file and inspect its sizing.', details: { code: 'WIDTH_RELEASE_CONFLICT', reason: 'owned-declarations-changed', targetId: 'copy' } } }
          : request.method === 'GET' ? { name: 'pages/a b.html', contentSha256: digest, records: [] }
            : { file: { name: 'pages/a b.html' }, widthRelease: { records: [], restoredTargetIds: ['copy'], contentSha256: digest } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  beforeEach(() => { requests = []; conflict = false; });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('dispatches inspect through SUBCOMMAND_MAP.files and emits parsed JSON', async () => {
    const result = await run(['inspect', 'project-1', 'pages/a b.html', '--json', '--daemon-url', base]);
    expect(result.code, result.stderr).toBe(0);
    expect(requests).toEqual([{ method: 'GET', url: '/api/projects/project-1/files/pages/a%20b.html?widthRelease=inspect', body: null }]);
    expect(JSON.parse(result.stdout)).toEqual({ name: 'pages/a b.html', contentSha256: digest, records: [] });
  });

  it.each([false, true])('posts guarded restore (all=%s) to the existing file endpoint', async (all) => {
    const result = await run(['restore', 'project-1', 'pages/a b.html', ...(all ? ['--all'] : ['--target', 'copy']), '--expected-content-sha256', digest, '--json', '--daemon-url', base]);
    expect(result.code, result.stderr).toBe(0);
    expect(requests).toEqual([{ method: 'POST', url: '/api/projects/project-1/files', body: { name: 'pages/a b.html', expectedContentSha256: digest, widthRelease: all ? { kind: 'restore', all: true } : { kind: 'restore', target: { targetId: 'copy' } } } }]);
    expect(JSON.parse(result.stdout).widthRelease.restoredTargetIds).toEqual(['copy']);
  });

  it('accepts the equivalent JSON operation through --prompt-file -', async () => {
    const body = { expectedContentSha256: digest, widthRelease: { kind: 'restore', target: { targetId: 'copy', releaseId: 'wr-1' } } };
    const result = await run(['restore', 'project-1', 'pages/a b.html', '--prompt-file', '-', '--json', '--daemon-url', base], JSON.stringify(body));
    expect(result.code, result.stderr).toBe(0);
    expect(requests[0]?.body).toEqual({ name: 'pages/a b.html', ...body });
  });

  it('preserves the actionable typed conflict in JSON stderr and exits nonzero', async () => {
    conflict = true;
    const result = await run(['restore', 'project-1', 'pages/a b.html', '--target', 'copy', '--expected-content-sha256', digest, '--json', '--daemon-url', base]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'WIDTH_RELEASE_CONFLICT', details: { reason: 'owned-declarations-changed', targetId: 'copy' } } });
    expect(result.stdout).toBe('');
  });

  it('rejects missing hash and ambiguous selectors before sending a write', async () => {
    expect((await run(['restore', 'project-1', 'a.html', '--target', 'copy', '--daemon-url', base])).code).toBe(2);
    expect((await run(['restore', 'project-1', 'a.html', '--target', 'copy', '--all', '--expected-content-sha256', digest, '--daemon-url', base])).code).toBe(2);
    expect(requests).toEqual([]);
  });
});
