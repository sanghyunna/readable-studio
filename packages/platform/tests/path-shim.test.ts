import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createCommandInvocation } from '../src/index.js';

it.each(['cmd', 'bat'])('resolves the shim directory when a bare .%s command is found on PATH', async (extension) => {
  // Given: an npm-style shim outside the child working directory.
  const root = await mkdtemp(join(tmpdir(), 'path-shim-'));
  try {
    const bin = join(root, 'toolchain with spaces');
    const cwd = join(root, 'app');
    await mkdir(bin);
    await mkdir(cwd);
    await writeFile(join(bin, `path-probe.${extension}`), '@echo off\r\necho %~dp0\r\n');
    const env = { ...process.env, PATH: `${bin};${process.env.PATH ?? ''}` };
    const invocation = createCommandInvocation({ command: `path-probe.${extension}`, args: ['--version'], env });
    // When: the shim runs through the same hidden execFile path as packaging.
    const { stdout } = await promisify(execFile)(invocation.command, invocation.args, {
      cwd, env, windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments, timeout: 10_000,
    });
    // Then: npm's relative module paths are anchored at its installation.
    expect(stdout.trim()).toBe(`${bin}\\`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('installs an empty staged app when npm.cmd is resolved from PATH', async () => {
  // Given: a fresh packaged-app directory without a local npm installation.
  const cwd = await mkdtemp(join(tmpdir(), 'npm-staged-app-'));
  try {
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'staged-app', version: '1.0.0', private: true }));
    const invocation = createCommandInvocation({ command: 'npm.cmd', args: ['install', '--omit=dev', '--package-lock'] });
    // When: the build's exact npm invocation executes without a console window.
    await promisify(execFile)(invocation.command, invocation.args, {
      cwd, env: process.env, windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments, timeout: 30_000,
    });
    // Then: npm completes and writes the staged app's lockfile.
    expect(JSON.parse(await readFile(join(cwd, 'package-lock.json'), 'utf8'))).toMatchObject({ name: 'staged-app', lockfileVersion: 3 });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 40_000);
