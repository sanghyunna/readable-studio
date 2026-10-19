import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type Recorded = { method: string; url: string; body: unknown };

/** Fake daemon answering POST /api/update/connection with a canned report. */
async function fakeDaemon(report: unknown) {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method!, url: req.url!, body: body ? JSON.parse(body) : null });
      const known = req.method === 'POST' && req.url === '/api/update/connection';
      res.statusCode = known ? 200 : 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(known ? report : { error: 'not-found' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function runCli(args: string[]) {
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [
      fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args,
    ], { env, windowsHide: true, timeout: 20000 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

const serverUrl = 'https://updates-1.aws.databricksapps.com';
const success = {
  ok: true, serverUrl, host: 'https://adb-1.azuredatabricks.net', profile: 'DEFAULT', latest: '1.3.4', timeoutMs: 25000, elapsedMs: 812,
  cli: { path: 'C:\\app\\vendor\\databricks\\databricks.exe', source: 'bundled', version: '0.250.0' },
  steps: [
    { step: 'url', ok: true, detail: serverUrl, elapsedMs: 0 },
    { step: 'cli', ok: true, detail: 'C:\\app\\vendor\\databricks\\databricks.exe (bundled, v0.250.0)', elapsedMs: 120 },
    { step: 'health', ok: true, detail: 'GET /api/v1/health -> 200', elapsedMs: 300, httpStatus: 200 },
  ],
};
const stopped = { ok: false, serverUrl, failure: 'app-stopped', timeoutMs: 25000, elapsedMs: 400,
  steps: [{ step: 'health', ok: false, detail: 'GET /api/v1/health -> 503', elapsedMs: 380, httpStatus: 503 }] };

describe.concurrent('readable update diagnose', () => {
  it('prints the JSON report and exits 0 when connected', async () => {
    const daemon = await fakeDaemon(success);
    try {
      const result = await runCli(['update', 'diagnose', '--server-url', serverUrl, '--json', '--daemon-url', daemon.url]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(success);
      expect(daemon.requests).toEqual([{ method: 'POST', url: '/api/update/connection', body: { serverUrl } }]);
    } finally { await daemon.close(); }
  }, 30000);

  it('prints each step and the reason with next action, exiting 1 on failure', async () => {
    const daemon = await fakeDaemon(stopped);
    try {
      const result = await runCli(['update', 'diagnose', '--daemon-url', daemon.url]);
      expect(result.code).toBe(1);
      expect(result.stdout).toContain('GET /api/v1/health -> 503');
      expect(result.stderr).toMatch(/stopped/i);
      expect(result.stderr).toMatch(/admin/i);
      expect(daemon.requests[0]!.body).toEqual({});
    } finally { await daemon.close(); }
  }, 30000);

  it('lists diagnose in update usage', async () => {
    const result = await runCli(['update', '--help']);
    expect(result.stdout).toMatch(/readable update diagnose/);
  }, 30000);
});
