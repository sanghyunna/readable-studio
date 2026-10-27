import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

const daemonRoot = path.resolve(import.meta.dirname, '..');
const requests: { method: string | undefined; url: string | undefined; body: string }[] = [];
const payload = { projectId: 'p', conversationId: 'c', agentId: 'pi', runId: 'run', snapshot: {
  state: 'estimated', usedTokens: 90_000, limitTokens: 200_000, source: 'pi', limitSource: 'metadata',
  model: 'fixture-model', sessionId: 'session', updatedAt: 1,
} };
let server: http.Server;
let base: string;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { requests.push({ method: req.method, url: req.url, body });
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload)); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture address');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

function run(args: string[], stdin = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = execFile(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'chat', 'context-usage', ...args,
      '--daemon-url', base, '--json'], { cwd: daemonRoot, timeout: 15_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stdout, stderr });
    });
    child.stdin?.end(stdin);
  });
}

it('queries the same read-only endpoint with explicit selectors and preserves JSON state', async () => {
  const result = await run(['--project', 'p', '--conversation', 'c', '--agent', 'pi', '--model', 'fixture-model']);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(payload);
  expect(requests.at(-1)).toEqual({ method: 'GET', url: '/api/projects/p/conversations/c/context-usage?agentId=pi&model=fixture-model', body: '' });
});

it('accepts JSON selectors from a file or stdin, and rejects malformed input before any request', async () => {
  const selectors = JSON.stringify({ projectId: 'p', conversationId: 'c', agentId: 'pi', model: 'fixture-model' });
  const directory = await mkdtemp(path.join(tmpdir(), 'context-cli-'));
  try {
    const file = path.join(directory, 'selectors.json');
    await writeFile(file, selectors, 'utf8');
    for (const result of [await run(['--prompt-file', file]), await run(['--prompt-file', '-'], selectors)]) {
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(payload);
    }
    const count = requests.length;
    expect((await run(['--prompt-file', '-'], '{"projectId":"p","agentId":3}')).code).toBe(1);
    expect(requests).toHaveLength(count);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
