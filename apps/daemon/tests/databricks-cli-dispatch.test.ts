import { execFile } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const daemonRoot = resolve(testDirectory, '..');
const repositoryRoot = resolve(daemonRoot, '../..');
const cliEntry = resolve(daemonRoot, 'src/cli.ts');
const tsxCli = resolve(repositoryRoot, 'node_modules/tsx/dist/cli.mjs');

async function runCli(args: string[], daemonUrl?: string) {
  try {
    const result = await execFileAsync(process.execPath, [tsxCli, cliEntry, ...args], {
      cwd: daemonRoot,
      env: { ...process.env, ...(daemonUrl ? { READABLE_DAEMON_URL: daemonUrl } : {}) },
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: result.code ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }
}

describe('readable databricks dispatcher', () => {
  it('forwards help to the Databricks handler', async () => {
    const result = await runCli(['databricks', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('forwards status JSON and preserves the handler exit code', async () => {
    let request: { method?: string; url?: string } | undefined;
    const server = http.createServer((req, res) => {
      request = {
        ...(req.method !== undefined ? { method: req.method } : {}),
        ...(req.url !== undefined ? { url: req.url } : {}),
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        cli: 'missing', version: null, auth: 'unchecked', enabledCount: 0, issues: [], profiles: [],
      }));
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Databricks test server has no TCP address');

    try {
      const result = await runCli(['databricks', 'status', '--json'], `http://127.0.0.1:${address.port}`);

      expect(result.exitCode).toBe(1);
      expect(request).toEqual({ method: 'GET', url: '/api/databricks/status' });
      expect(JSON.parse(result.stdout)).toMatchObject({ cli: 'missing' });
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    }
  });
});
