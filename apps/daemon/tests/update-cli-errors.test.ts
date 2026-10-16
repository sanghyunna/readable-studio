import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type Route = [status: number, body: unknown];
type Recorded = { method: string; url: string; body: unknown };

/** Fake daemon: `routes` maps "METHOD /path" to a canned response and records every request. */
async function fakeDaemon(routes: Record<string, Route>) {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method!, url: req.url!, body: body ? JSON.parse(body) : null });
      const [status, payload] = routes[`${req.method} ${req.url}`] ?? [404, { error: 'not-found' }];
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function runCli(args: string[], stdin?: string) {
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(process.execPath, [
      fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args,
    ], { env, windowsHide: true, timeout: 20000 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
    child.stdin?.end(stdin ?? '');
  });
}

const disabled = { config: { autoUpdate: { enabled: false, serverUrl: null } } };
const enabled = { config: { autoUpdate: { enabled: true, serverUrl: 'https://updates.databricksapps.com' } } };
const host = 'https://adb-1.azuredatabricks.net';

describe.concurrent('readable update CLI failure handling', () => {
  it('lists update and Databricks login in root help', async () => {
    const { code, stdout } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/readable update <check\|/);
    expect(stdout).toMatch(/readable databricks <[^>]*\blogin\b/);
  }, 30000);

  it('prints update usage for -h with exit 0', async () => {
    const result = await runCli(['update', '-h']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/readable update check/);
  }, 30000);

  it.each([['--json'], []])('exits 1 when check is unavailable (%s) and points not-logged-in at login with the host', async (...extra) => {
    const daemon = await fakeDaemon({ 'GET /api/update/check': [200, { unavailable: 'not-logged-in', host }] });
    try {
      const result = await runCli(['update', 'check', ...extra, '--daemon-url', daemon.url]);
      expect(result.code).toBe(1);
      if (extra.length) expect(JSON.parse(result.stdout)).toEqual({ unavailable: 'not-logged-in', host });
      else expect(result.stderr).toContain(`readable databricks login --host ${host}`);
    } finally { await daemon.close(); }
  }, 30000);

  it('keeps the host from a failed health check and skips saving', async () => {
    const daemon = await fakeDaemon({ 'GET /api/app-config': [200, disabled], 'POST /api/update/health': [400, { error: 'not-logged-in', host }] });
    try {
      const result = await runCli(['update', 'config', '--enable', '--server-url', 'https://updates.databricksapps.com', '--json', '--daemon-url', daemon.url]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({ error: 'not-logged-in', host });
      expect(daemon.requests.map((r) => `${r.method} ${r.url}`)).not.toContain('PUT /api/app-config');
    } finally { await daemon.close(); }
  }, 30000);

  it('validates a new server URL like Connect even while disabled', async () => {
    const daemon = await fakeDaemon({ 'GET /api/app-config': [200, disabled], 'POST /api/update/health': [400, { error: 'unreachable' }] });
    try {
      const result = await runCli(['update', 'config', '--server-url', 'https://bogus-qa.invalid', '--json', '--daemon-url', daemon.url]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({ error: 'unreachable' });
      expect(daemon.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /api/app-config', 'POST /api/update/health']);
    } finally { await daemon.close(); }
  }, 30000);

  it('clears the server URL with --server-url "" and rejects clearing while enabled', async () => {
    const off = await fakeDaemon({ 'GET /api/app-config': [200, { config: { autoUpdate: { enabled: false, serverUrl: 'https://updates.databricksapps.com' } } }], 'PUT /api/app-config': [200, {}] });
    const on = await fakeDaemon({ 'GET /api/app-config': [200, enabled] });
    try {
      const cleared = await runCli(['update', 'config', '--server-url', '', '--json', '--daemon-url', off.url]);
      expect(cleared.code).toBe(0);
      expect(JSON.parse(cleared.stdout)).toEqual({ enabled: false, serverUrl: null });
      expect(off.requests.at(-1)).toEqual({ method: 'PUT', url: '/api/app-config', body: { autoUpdate: { enabled: false, serverUrl: null } } });
      const refused = await runCli(['update', 'config', '--server-url', '', '--json', '--daemon-url', on.url]);
      expect(refused.code).toBe(1);
      expect(JSON.parse(refused.stdout)).toEqual({ error: 'not-configured' });
      expect(on.requests.map((r) => r.method)).toEqual(['GET']);
    } finally { await off.close(); await on.close(); }
  }, 30000);

  it.each([
    [['--server-url', 'http://example.com'], 'invalid-server-url'],
    [['--server-url', 'not a url'], 'invalid-server-url'],
    [['--prompt-file', 'BAD_JSON'], 'invalid-config-file'],
    [['--prompt-file', 'MISSING'], 'invalid-config-file'],
    [['--prompt-file', 'WRONG_TYPE'], 'invalid-config-file'],
  ])('rejects %j with a stable usage code and no mutation', async (flags, error) => {
    const dir = mkdtempSync(join(tmpdir(), 'readable-update-cli-'));
    const files: Record<string, string> = { BAD_JSON: join(dir, 'bad.json'), MISSING: join(dir, 'missing.json'), WRONG_TYPE: join(dir, 'wrong.json') };
    writeFileSync(files.BAD_JSON!, '{nope');
    writeFileSync(files.WRONG_TYPE!, JSON.stringify({ enabled: 'yes' }));
    const daemon = await fakeDaemon({ 'GET /api/app-config': [200, disabled] });
    try {
      const result = await runCli(['update', 'config', ...flags.map((flag) => files[flag] ?? flag), '--json', '--daemon-url', daemon.url]);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout)).toEqual({ error });
      expect(daemon.requests.map((r) => r.method)).toEqual(['GET']);
    } finally { await daemon.close(); }
  }, 30000);

  it('reports an unknown flag as a usage error without a stack trace', async () => {
    const result = await runCli(['update', 'config', '--bogus', '--json']);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).error).toBe('usage');
    expect(result.stderr).not.toMatch(/\n\s+at /);
  }, 30000);

  it.each([['check'], ['config'], ['status'], ['download']])('uses one daemon-not-running code for %s', async (action) => {
    const result = await runCli(['update', action!, '--json', '--daemon-url', 'http://127.0.0.1:1']);
    expect(result.code).toBe(64);
    expect(JSON.parse(result.stdout)).toEqual({ error: 'daemon-not-running' });
  }, 30000);

  it('renders human status and refusal text instead of raw JSON or bare codes', async () => {
    const daemon = await fakeDaemon({
      'GET /api/update/status': [200, { state: 'downloading', received: 1048576, total: 4194304, version: '1.4.0', error: null }],
      'POST /api/update/download': [409, { error: 'unsupported-layout' }],
    });
    try {
      const status = await runCli(['update', 'status', '--daemon-url', daemon.url]);
      expect(status.code).toBe(0);
      expect(() => JSON.parse(status.stdout)).toThrow();
      const download = await runCli(['update', 'download', '--daemon-url', daemon.url]);
      expect(download.code).toBe(1);
      expect(download.stderr.trim()).not.toBe('unsupported-layout');
      expect(download.stderr.trim().length).toBeGreaterThan('unsupported-layout'.length);
    } finally { await daemon.close(); }
  }, 30000);
});
