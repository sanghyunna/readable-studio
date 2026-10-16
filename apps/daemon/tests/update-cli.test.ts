import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each([['--version'], ['version'], ['--version', '--json'], ['version', '--json']].map((args) => ({ args })))('prints the local runtime version for $args, without a daemon', async ({ args }) => {
  const env: NodeJS.ProcessEnv = { ...process.env, READABLE_APP_VERSION: '1.9.3' }; delete env.NODE_OPTIONS;
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
    fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args,
  ], { env, windowsHide: true, timeout: 15000 });
  if (args.includes('--json')) expect(JSON.parse(stdout)).toEqual({ version: '1.9.3' });
  else expect(stdout.trim()).toBe('1.9.3');
}, 20000);

it('dispatches update apply --json through the runnable CLI', async () => {
  const result = { status: 'applying', targetVersion: '1.3.0' };
  const requests: string[] = [];
  const server = createServer((req, res) => { requests.push(`${req.method} ${req.url}`); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const env = { ...process.env }; delete env.NODE_OPTIONS;
    const { stdout } = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'update', 'apply', '--json', '--daemon-url', `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    ], { env, windowsHide: true, timeout: 15000 });
    expect(JSON.parse(stdout)).toEqual(result);
    expect(requests).toEqual(['POST /api/update/apply']);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}, 20000);

it('dispatches update check --json and emits the contract object verbatim', async () => {
  const data = { current: '1.3.3', latest: '1.3.4', isNewer: true, assetName: 'Readable-Studio-win-x64-portable.zip', assetSize: 1234, sha256: 'a'.repeat(64), releaseUrl: 'https://updates.databricksapps.com', notes: 'notes', checkedAt: '2026-10-01T00:00:00.000Z' };
  const requests: string[] = [];
  const server = createServer((req, res) => { requests.push(`${req.method} ${req.url}`); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const env = { ...process.env }; delete env.NODE_OPTIONS;
    const { stdout } = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'update', 'check', '--json', '--daemon-url', `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    ], { env, windowsHide: true, timeout: 15000 });
    expect(JSON.parse(stdout)).toEqual(data);
    expect(requests).toEqual(['GET /api/update/check']);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}, 20000);

it.each([['download', 'POST'], ['status', 'GET'], ['cancel', 'POST']])('dispatches update %s --json', async (action, method) => {
  const requests: string[] = [];
  const result = { state: 'idle', received: 0, total: 0, version: null, error: null };
  const server = createServer((req, res) => { requests.push(`${req.method} ${req.url}`); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const env = { ...process.env }; delete env.NODE_OPTIONS;
    const { stdout } = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'update', action!, '--json', '--daemon-url', `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    ], { env, windowsHide: true, timeout: 15000 });
    expect(JSON.parse(stdout)).toEqual(result);
    expect(requests).toEqual([`${method} /api/update/${action}`]);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}, 20000);

it('config validates health before enabling and persists normalized server URL', async () => {
  const requests: { method: string; url: string; body: unknown }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method!, url: req.url!, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.method === 'GET' ? { config: { autoUpdate: { enabled: false, serverUrl: null } } } : { ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const env = { ...process.env }; delete env.NODE_OPTIONS;
    const { stdout } = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'update', 'config', '--enable', '--server-url', 'https://updates.databricksapps.com/', '--json', '--daemon-url', `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    ], { env, windowsHide: true, timeout: 15000 });
    expect(JSON.parse(stdout)).toEqual({ enabled: true, serverUrl: 'https://updates.databricksapps.com' });
    expect(requests).toEqual([
      { method: 'GET', url: '/api/app-config', body: null },
      { method: 'POST', url: '/api/update/health', body: { serverUrl: 'https://updates.databricksapps.com' } },
      { method: 'PUT', url: '/api/app-config', body: { autoUpdate: { enabled: true, serverUrl: 'https://updates.databricksapps.com' } } },
    ]);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}, 20000);

it('config accepts JSON preferences through --prompt-file - without health requests when disabling', async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ config: { autoUpdate: { enabled: true, serverUrl: 'https://updates.databricksapps.com' } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const env = { ...process.env }; delete env.NODE_OPTIONS;
    const execution = promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'update', 'config', '--prompt-file', '-', '--json', '--daemon-url', `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    ], { env, windowsHide: true, timeout: 15000 });
    execution.child.stdin?.end(JSON.stringify({ enabled: false, serverUrl: null }));
    const { stdout } = await execution;
    expect(JSON.parse(stdout)).toEqual({ enabled: false, serverUrl: null });
    expect(requests).toEqual(['GET /api/app-config', 'PUT /api/app-config']);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}, 20000);
