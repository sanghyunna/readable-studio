import { createServer, type IncomingMessage } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

type Status = { state: string; received: number; total: number; version: string | null; error: string | null; extraction?: { completed: number; total: number } };
const status = (state: string, extra: Partial<Status> = {}): Status => ({ state, received: 0, total: 0, version: '1.4.0', error: null, ...extra });

/** Fake daemon whose /api/update/events streams `events`, then ends the stream unless `keepOpen`. */
async function fakeEvents(events: Status[], keepOpen = false) {
  const requests: string[] = [];
  let eventsClosed!: () => void;
  const closed = new Promise<void>((resolve) => { eventsClosed = resolve; });
  const server = createServer((req: IncomingMessage, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url !== '/api/update/events') { res.statusCode = 404; res.end('{}'); return; }
    req.on('close', () => eventsClosed());
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (!keepOpen) res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests,
    closed,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function runCli(args: string[], nodeOptions?: string) {
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  if (nodeOptions) env.NODE_OPTIONS = nodeOptions;
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [
      fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args,
    ], { env, windowsHide: true, timeout: 20000 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    }).stdin?.end('');
  });
}
const lines = (stdout: string) => stdout.trim().split('\n').map((line) => JSON.parse(line));

describe.concurrent('readable update status --watch', () => {
  const downloading = status('downloading', { received: 1048576, total: 4194304 });
  it.each([
    ['ready', [downloading, status('verifying'), status('ready')], 0],
    ['failed', [downloading, status('failed', { error: 'unreachable' })], 1],
    ['cancelled', [downloading, status('idle', { version: null })], 1],
    ['no download', [status('idle', { version: null })], 0],
  ] as const)('follows the event stream to %s and emits one JSON object per status', async (_name, events, code) => {
    const daemon = await fakeEvents([...events], true);
    try {
      const result = await runCli(['update', 'status', '--watch', '--json', '--daemon-url', daemon.url]);
      expect(result.code).toBe(code);
      expect(lines(result.stdout)).toEqual(events);
      expect(daemon.requests).toEqual(['GET /api/update/events']);
    } finally { await daemon.close(); }
  }, 30000);

  it('prints human progress and exits 1 when the download fails', async () => {
    const daemon = await fakeEvents([downloading, status('failed', { error: 'unreachable' })], true);
    try {
      const result = await runCli(['update', 'status', '--watch', '--daemon-url', daemon.url]);
      expect(result.code).toBe(1);
      expect(() => JSON.parse(result.stdout)).toThrow();
      expect(result.stdout.trim().split('\n')).toHaveLength(2);
    } finally { await daemon.close(); }
  }, 30000);
  it('R9-01 shows a retained ready package apply error instead of claiming readiness', async () => {
    const daemon = await fakeEvents([status('ready', { error: 'helper-not-acknowledged' })]);
    const failed = await fakeEvents([status('failed', { error: 'helper-not-acknowledged' })]);
    try {
      const result = await runCli(['update', 'status', '--watch', '--daemon-url', daemon.url]);
      const expected = await runCli(['update', 'status', '--watch', '--daemon-url', failed.url]);
      expect(result.stdout).toBe(expected.stdout);
    } finally { await daemon.close(); await failed.close(); }
  }, 30000);
  it.each([false, true])('R10-02 exits non-zero for terminal apply errors, json=%s', async (json) => {
    const event = status('ready', { error: 'helper-not-acknowledged' });
    const daemon = await fakeEvents([event], true);
    try {
      const result = await runCli(['update', 'status', '--watch', ...(json ? ['--json'] : []), '--daemon-url', daemon.url]);
      expect(result.code).toBe(1);
      if (json) expect(lines(result.stdout)).toEqual([event]);
      else expect(result.stdout).toContain('Update failed');
    } finally { await daemon.close(); }
  }, 30000);

  it.each([false, true])('R12-01 follows an active apply through helper failure, json=%s', async (json) => {
    const events = [
      status('ready', { extraction: { completed: 0, total: 4 } }),
      status('ready', { extraction: { completed: 4, total: 4 } }),
      status('ready', { error: 'helper-not-acknowledged' }),
    ];
    const daemon = await fakeEvents(events, true);
    try {
      const result = await runCli(['update', 'status', '--watch', ...(json ? ['--json'] : []), '--daemon-url', daemon.url]);
      expect(result.code).toBe(1);
      if (json) expect(lines(result.stdout)).toEqual(events);
      else expect(result.stdout.trim().split('\n')).toHaveLength(2);
    } finally { await daemon.close(); }
  }, 30000);

  it.each([false, true])('R12-01 follows an active apply through successful handoff, json=%s', async (json) => {
    const events = [
      status('ready', { extraction: { completed: 0, total: 0 } }),
      status('ready', { extraction: { completed: 4, total: 4 } }),
      status('ready'),
    ];
    const daemon = await fakeEvents(events, true);
    try {
      const result = await runCli(['update', 'status', '--watch', ...(json ? ['--json'] : []), '--daemon-url', daemon.url]);
      expect(result.code).toBe(0);
      if (json) expect(lines(result.stdout)).toEqual(events);
      else expect(result.stdout.trim().split('\n')).toHaveLength(2);
    } finally { await daemon.close(); }
  }, 30000);

  it('exits 64 when the stream ends before a terminal state', async () => {
    const daemon = await fakeEvents([downloading]);
    try {
      const result = await runCli(['update', 'status', '--watch', '--json', '--daemon-url', daemon.url]);
      expect(result.code).toBe(64);
      expect(lines(result.stdout)).toEqual([downloading, { error: 'daemon-not-running' }]);
    } finally { await daemon.close(); }
  }, 30000);

  it('exits 130 on Ctrl+C, detaches from the stream and does not cancel the download', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'readable-update-watch-'));
    const preload = join(dir, 'sigint-after-first-status.mjs');
    // Raise SIGINT in-process once the first status line is written: deterministic on Windows too.
    writeFileSync(preload, `const write = process.stdout.write.bind(process.stdout); let sent = false;
process.stdout.write = (chunk, ...rest) => { const result = write(chunk, ...rest);
  if (!sent && String(chunk).includes('"downloading"')) { sent = true; setImmediate(() => process.emit('SIGINT', 'SIGINT')); }
  return result; };\n`);
    const daemon = await fakeEvents([downloading], true);
    try {
      const result = await runCli(['update', 'status', '--watch', '--json', '--daemon-url', daemon.url], `--import=${pathToFileURL(preload).href}`);
      await daemon.closed;
      expect(result.code).toBe(130);
      expect(lines(result.stdout)).toEqual([downloading]);
      expect(daemon.requests).toEqual(['GET /api/update/events']);
    } finally { await daemon.close(); }
  }, 30000);

  it('rejects --watch on other actions and documents it in update help', async () => {
    const refused = await runCli(['update', 'download', '--watch', '--json', '--daemon-url', 'http://127.0.0.1:1']);
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stdout).error).toBe('usage');
    const help = await runCli(['update', '--help']);
    expect(help.stdout).toContain('status --watch');
  }, 30000);
});
