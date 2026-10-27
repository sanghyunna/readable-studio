import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const requests: Record<string, unknown>[] = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.method === 'POST' && req.url === '/api/runs') requests.push(JSON.parse(body));
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ runId: 'fixture-run' }));
});
let baseUrl: string;
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function runCli(args: string[], input = '') {
  const env: NodeJS.ProcessEnv = { ...process.env, READABLE_DAEMON_URL: baseUrl };
  delete env.NODE_OPTIONS;
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args], {
      env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe('CLI per-run references', () => {
  it('sends repeated skill and template references with plugin selection and a stdin prompt', async () => {
    const result = await runCli([
      'run', 'start', '--project', 'fixture-project', '--skill', 'primary-skill', '--plugin', 'functional-plugin',
      '--reference', 'functional-skill', '--reference=selected-template', '--reference', 'functional-skill',
      '--prompt-file', '-', '--json',
    ], 'User source text');
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ runId: 'fixture-run' });
    expect(requests.at(-1)).toMatchObject({
      projectId: 'fixture-project', skillId: 'primary-skill', pluginId: 'functional-plugin',
      skillIds: ['functional-skill', 'selected-template'], message: 'User source text',
    });
  });

  it('documents run-only references and rejects a missing reference value', async () => {
    const help = await runCli(['run', '--help']);
    expect(help.stdout).toContain('--reference <id>');
    expect(help.stdout).toContain('this run only');
    const count = requests.length;
    const invalid = await runCli(['run', 'start', '--project', 'fixture-project', '--reference', '--json']);
    expect(invalid.code).not.toBe(0);
    expect(invalid.stderr).toContain('--reference requires a value');
    expect(requests).toHaveLength(count);
  });

  it('keeps flag-like prompt text as user content', async () => {
    const result = await runCli(['run', 'start', '--project', 'fixture-project', '--message', '--reference=literal', '--json']);
    expect(result.code, result.stderr).toBe(0);
    expect(requests.at(-1)?.message).toBe('--reference=literal');
    expect(requests.at(-1)).not.toHaveProperty('skillIds');
  });
});
