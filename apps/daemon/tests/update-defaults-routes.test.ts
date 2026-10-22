import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { Server } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { DatabricksClient } from '../src/databricks/client.js';
import { startServer } from '../src/server.js';

const fixture = vi.hoisted(() => ({ requests: [] as string[] }));
const serverUrl = 'https://readable-studio-updates-123.aws.databricksapps.com';
const manifest = { version: '1.3.5', fileName: 'Readable-Studio-win-x64-portable.zip', size: 4, sha256: 'a'.repeat(64), notes: '', publishedAt: '2026-10-22T00:00:00Z' };
vi.mock('../src/update-http.js', () => ({ createUpdateHttpClient: () => ({
  fetch: async (url: string) => { fixture.requests.push(url); return Response.json(manifest); },
  destroy: async () => {},
}) }));

it('exposes the default over HTTP and CLI, checks it automatically, and preserves an explicit CLI opt-out', async () => {
  const dataDir = process.env.READABLE_DATA_DIR;
  if (!dataDir) throw new Error('Test setup must isolate READABLE_DATA_DIR');
  await writeFile(join(dataDir, 'app-config.json'), JSON.stringify({ autoUpdate: { enabled: false, serverUrl: null } }));
  const calls: string[][] = [];
  vi.spyOn(DatabricksClient.prototype, 'probe').mockResolvedValue({ cli: 'ready', version: '0.250.0', cliSource: 'path' });
  vi.spyOn(DatabricksClient.prototype, 'json').mockImplementation(async (args) => {
    calls.push([...args]);
    if (args[0] === 'apps' && args[1] === 'get') return { name: 'readable-studio-updates', url: new URL(serverUrl).host };
    if (args[0] === 'apps' && args[1] === 'list') return [{ url: new URL(serverUrl).host }];
    if (args[0] === 'auth' && args[1] === 'profiles') return { profiles: [{ name: 'CURRENT', host: 'https://workspace.azuredatabricks.net' }] };
    if (args[0] === 'auth' && args[1] === 'token') return { access_token: 'fixture-only-bearer', expiry: new Date(Date.now() + 3_600_000).toISOString() };
    throw new Error('Unexpected fake CLI command');
  });
  const started = await startServer({ port: 0, returnServer: true });
  if (typeof started !== 'object' || started === null || !('url' in started) || typeof started.url !== 'string'
    || !('server' in started) || !(started.server instanceof Server)) throw new Error('Expected an HTTP daemon');
  const base = started.url;
  const server = started.server;
  const cli = (args: string[]) => promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
    fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'update', ...args, '--json', '--daemon-url', base,
  ], { env: { ...process.env }, windowsHide: true, timeout: 15_000 });
  try {
    const config = await (await fetch(`${base}/api/app-config`)).json();
    expect(config).toMatchObject({ config: { autoUpdate: { enabled: true, serverUrl } } });
    expect(JSON.parse((await cli(['config'])).stdout)).toEqual({ enabled: true, serverUrl });
    const check = await (await fetch(`${base}/api/update/check?automatic=1`)).json();
    expect(check).toMatchObject({ latest: '1.3.5', releaseUrl: serverUrl });
    expect(fixture.requests).toEqual([`${serverUrl}/api/v1/latest`]);
    expect(calls.filter((args) => args[0] === 'apps' && args[1] === 'get')).toEqual([
      ['apps', 'get', 'readable-studio-updates', '--output', 'json'],
      ['apps', 'get', 'readable-studio-updates', '--profile', 'CURRENT', '--output', 'json'],
    ]);
    expect(JSON.parse((await cli(['config', '--disable'])).stdout)).toEqual({ enabled: false, serverUrl });
    expect(JSON.parse(await readFile(join(dataDir, 'app-config.json'), 'utf8')).autoUpdate).toEqual({ enabled: false, serverUrl });
    expect(await (await fetch(`${base}/api/app-config`)).json()).toMatchObject({ config: { autoUpdate: { enabled: false, serverUrl } } });
    expect(await (await fetch(`${base}/api/update/check?automatic=1`)).json()).toEqual({ unavailable: 'disabled' });
    expect(fixture.requests).toHaveLength(1);
  } finally {
    if ('shutdown' in started && typeof started.shutdown === 'function') await started.shutdown();
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    vi.restoreAllMocks();
  }
}, 60_000);
