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
  const data = { current: '1.2.1', latest: '1.3.0', isNewer: true, assetName: 'Readable-Studio-win-x64-portable.zip', assetSize: 1234, sha256: 'a'.repeat(64), releaseUrl: 'https://github.com/sanghyunna/readable-studio/releases/tag/v1.3.0', notes: 'notes', checkedAt: '2026-10-01T00:00:00.000Z' };
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
