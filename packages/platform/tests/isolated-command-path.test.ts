import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { createCommandInvocation, spawnIsolatedAgent } from '../src/index.js';

afterEach(() => vi.unstubAllEnvs());

it('uses an absolute system shell when the packaged environment omits ComSpec', () => {
  // Given: packaged sidecars forward SystemRoot but not ComSpec.
  vi.stubEnv('ComSpec', undefined);
  const env = { SystemRoot: process.env.SystemRoot };
  // When: an installed npm agent shim is converted to its executable invocation.
  const invocation = createCommandInvocation({ command: 'C:\\agent\\codex.cmd', env });
  // Then: native isolation receives an absolute executable, not cmd.exe.
  expect(invocation.command).toBe(win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'));
});

it.each([
  { directory: 'project', args: [] },
  { directory: 'project', args: ['--version'] },
  { directory: 'project with spaces', args: ['--version'] },
])('starts an isolated npm-style shim with packaged environment: $directory $args', async ({ directory, args }) => {
  // Given: a real shim in the isolated fixture, with ComSpec omitted.
  vi.stubEnv('ComSpec', undefined);
  const root = await mkdtemp(win32.join(tmpdir(), 'isolated-shell-'));
  try {
    const cwd = win32.join(root, directory);
    const shim = win32.join(cwd, 'agent.cmd');
    await mkdir(cwd);
    await writeFile(shim, '@echo off\r\necho isolated-started\r\n');
    // When: the actual native helper launches the shim under AppContainer.
    const child = await spawnIsolatedAgent({ command: shim, args, cwd, env: { ...process.env, TEMP: cwd, TMP: cwd }, readExecutePaths: [], writablePaths: [cwd] });
    const completed = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
    child.stdin.end();
    // Then: the contained executable actually runs, without disabling isolation.
    expect(await completed).toEqual({ code: 0, stdout: 'isolated-started\r\n', stderr: '' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

it('honors uppercase COMSPEC from a plain Windows environment object', () => {
  // Given: a shell override different from the inherited default.
  const shell = 'D:\\Windows\\System32\\cmd.exe';
  // When: a shim invocation is constructed from the plain child environment.
  const invocation = createCommandInvocation({ command: 'C:\\agent\\codex.cmd', env: { COMSPEC: shell } });
  // Then: Windows case-insensitive variable semantics are preserved.
  expect(invocation.command).toBe(shell);
});

it.each(['command', 'cwd', 'readExecutePaths', 'writablePaths'] as const)(
  'identifies the rejected %s path in native diagnostics',
  async (field) => {
    // Given: a malformed native request, rejected before ACLs or child launch.
    const helper = fileURLToPath(new URL('../dist/native/win32/agent-isolator.exe', import.meta.url));
    const request = {
      command: helper, args: [], cwd: process.cwd(), env: {},
      readExecutePaths: [], writablePaths: [process.cwd()], windowsVerbatimArguments: false,
      [field]: field.endsWith('Paths') ? ['relative-private-path'] : 'relative-private-path',
    };
    // When: the helper validates the exact wire request.
    const child = spawn(helper, ['--exec'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    const result = new Promise<string>((resolve, reject) => {
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('close', () => resolve(stderr));
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
    // Then: operator diagnostics identify both the argument and rejected value.
    const stderr = await result;
    expect(stderr).toContain(field);
    expect(stderr).toContain('relative-private-path');
  },
);
