import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
function run(args: string[], input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, 'shortcut', ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI timeout')); }, 15000);
    child.stdout.setEncoding('utf8').on('data', (value) => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', (value) => { stderr += value; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}
describe('readable shortcut', () => {
  let server: http.Server, base: string;
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let text = '';
      req.setEncoding('utf8').on('data', (chunk) => { text += chunk; });
      req.on('end', () => {
        requests.push({ method: req.method!, url: req.url!, body: text ? JSON.parse(text) : null });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.method === 'GET'
          ? { desktop: false, startMenu: false, taskbar: false, startPinned: false, reason: 'unsupported' }
          : { status: 'failed', location: 'desktop', reason: 'unsupported' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  it('dispatches capability query and unsupported create with typed --json output', async () => {
    const capabilities = await run(['capabilities', '--json', '--daemon-url', base]);
    expect(capabilities.code, capabilities.stderr).toBe(0);
    expect(JSON.parse(capabilities.stdout)).toMatchObject({ desktop: false, taskbar: false, reason: 'unsupported' });
    const created = await run(['create', 'desktop', '--json', '--daemon-url', base]);
    expect(created.code, created.stderr).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({ status: 'failed', location: 'desktop', reason: 'unsupported' });
    expect(requests).toEqual([{ method: 'GET', url: '/api/shortcuts', body: null }, { method: 'POST', url: '/api/shortcuts', body: { location: 'desktop' } }]);
  });
  it('accepts --prompt-file - and refuses taskbar pin', async () => {
    const result = await run(['create', '--prompt-file', '-', '--json', '--daemon-url', base], JSON.stringify({ location: 'desktop' }));
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('failed');
    expect((await run(['create', 'taskbar', '--daemon-url', base])).code).toBe(2);
  });
});
