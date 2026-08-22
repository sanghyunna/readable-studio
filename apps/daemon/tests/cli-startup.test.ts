import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { posixProcessGroupTarget, spawnWaitingForOutputLine } from './child-readiness.js';

const execFileAsync = promisify(execFile);
const daemonRoot = fileURLToPath(new URL('..', import.meta.url));
// Exercise the same built entry users launch. Spawning cli.ts through tsx made
// readiness depend on cold transpilation of the daemon graph rather than bind.
const cliEntry = fileURLToPath(new URL('../bin/readable.mjs', import.meta.url));

const READY_PATTERN = /\[readable\] listening on (http:\/\/[^\s]+) \(headless\)/u;
// This is a deadlock guard for cold Windows CI/workstation startup, not a startup SLO.
const REAL_DAEMON_COLD_START_DEADLOCK_GUARD_MS = 60_000;
const REAL_DAEMON_POST_START_ASSERTION_AND_CLEANUP_BUDGET_MS = 15_000;
const REAL_DAEMON_LIFECYCLE_TEST_TIMEOUT_MS =
  REAL_DAEMON_COLD_START_DEADLOCK_GUARD_MS + REAL_DAEMON_POST_START_ASSERTION_AND_CLEANUP_BUDGET_MS;

function expectReadinessListenersReleased(launched: ReturnType<typeof spawnWaitingForOutputLine>): void {
  expect(launched.child.stdout.listenerCount('data')).toBe(0);
  expect(launched.child.stderr.listenerCount('data')).toBe(0);
  expect(launched.child.listenerCount('error')).toBe(0);
  expect(launched.child.listenerCount('close')).toBe(0);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function forceTerminateKnownPid(pid: number): Promise<void> {
  if (!processIsAlive(pid)) return;
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  process.kill(pid, 'SIGKILL');
}

describe('CLI startup boundaries', () => {
  it(
    'keeps readable daemon start alive until SIGTERM and reports the actual listening port',
    runRealDaemonLifecycleAssertion,
    REAL_DAEMON_LIFECYCLE_TEST_TIMEOUT_MS,
  );

  it.each([
    ['doctor', ['doctor', '--help']],
    ['config', ['config', 'get', 'apiProtocol', '--daemon-url', 'http://127.0.0.1:9']],
    ['diagnostics', ['diagnostics', 'export', '--daemon-url', 'http://127.0.0.1:9']],
  ])('initializes flag constants before dispatching readable %s', async (_name, args) => {
    let output = '';
    try {
      const result = await execFileAsync(
        process.execPath,
        [cliEntry, ...args],
        {
          cwd: daemonRoot,
          env: { ...process.env },
        },
      );
      output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    } catch (error: unknown) {
      const failed = error as { stdout?: string; stderr?: string };
      output = `${failed.stdout ?? ''}${failed.stderr ?? ''}`;
    }

    expect(output).not.toContain('ReferenceError');
    expect(output).not.toContain('before initialization');
    expect(output).not.toContain('CONFIG_STRING_FLAGS');
    expect(output).not.toContain('DIAGNOSTICS_STRING_FLAGS');
  });

  it('targets the original POSIX process group after its leader closes', () => {
    expect(posixProcessGroupTarget(42)).toBe(-42);
  });

  it('captures immediate readiness and transfers idempotent termination ownership', async () => {
    const launched = spawnWaitingForOutputLine(
      process.execPath,
      ['-e', "process.stdout.write('[readable] listening on http://127.0.0.1:1 (headless)\\n'); setInterval(() => {}, 1000)"],
      {},
      READY_PATTERN,
    );
    await expect(launched.line).resolves.toContain('http://127.0.0.1:1');
    const firstTermination = launched.terminate();
    const secondTermination = launched.terminate();
    expect(secondTermination).toBe(firstTermination);
    await firstTermination;
    expect(launched.child.exitCode !== null || launched.child.signalCode !== null).toBe(true);
    expectReadinessListenersReleased(launched);
  });

  it('terminates a silent owned child before timeout rejection settles', async () => {
    const launched = spawnWaitingForOutputLine(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {},
      READY_PATTERN,
      0,
    );
    await expect(launched.line).rejects.toThrow(/timed out waiting for stdout/u);
    expect(launched.child.exitCode !== null || launched.child.signalCode !== null).toBe(true);
    expectReadinessListenersReleased(launched);
  });

  it('waits for close so early-exit diagnostics include final stderr', async () => {
    const launched = spawnWaitingForOutputLine(
      process.execPath,
      ['-e', "process.stderr.write('final stderr line\\n', () => process.exit(7))"],
      {},
      READY_PATTERN,
    );
    await expect(launched.line).rejects.toThrow(/final stderr line/u);
    expect(launched.child.exitCode).toBe(7);
    expectReadinessListenersReleased(launched);
  });

  it('terminates early-close descendants before readiness rejection settles', async () => {
    const source = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: process.platform === 'win32', stdio: 'ignore' });",
      "child.unref();",
      "process.stderr.write(`[readiness-owned-descendant:${child.pid}]\\n`, () => process.exit(9));",
    ].join(' ');
    const launched = spawnWaitingForOutputLine(
      process.execPath,
      ['-e', source],
      {},
      READY_PATTERN,
    );
    let descendantPid = Number.NaN;
    try {
      let diagnostic = '';
      try {
        await launched.line;
        throw new Error('readiness unexpectedly resolved');
      } catch (error) {
        diagnostic = error instanceof Error ? error.message : String(error);
      }
      descendantPid = Number(/\[readiness-owned-descendant:(\d+)\]/u.exec(diagnostic)?.[1]);
      expect(launched.child.exitCode).toBe(9);
      expect(Number.isInteger(descendantPid)).toBe(true);
      expect(processIsAlive(descendantPid)).toBe(false);
      expectReadinessListenersReleased(launched);
    } finally {
      if (Number.isInteger(descendantPid)) await forceTerminateKnownPid(descendantPid);
    }
  });

  it('terminates descendants before owned timeout rejection settles', async () => {
    const source = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "process.stderr.write(`descendant=${child.pid}\\n`);",
      "setInterval(() => {}, 1000);",
    ].join(' ');
    const launched = spawnWaitingForOutputLine(
      process.execPath,
      ['-e', source],
      {},
      READY_PATTERN,
      100,
    );
    let diagnostic = '';
    try {
      await launched.line;
      throw new Error('readiness unexpectedly resolved');
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
    }
    const descendantPid = Number(/descendant=(\d+)/u.exec(diagnostic)?.[1]);
    expect(Number.isInteger(descendantPid)).toBe(true);
    expect(processIsAlive(descendantPid)).toBe(false);
    expectReadinessListenersReleased(launched);
  });
});

async function runRealDaemonLifecycleAssertion(): Promise<void> {
  const scratchRoot = join(daemonRoot, '.tmp');
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(join(scratchRoot, 'cli-daemon-lifecycle-'));
  const dataDir = join(root, 'data');
  const resourceRoot = join(root, 'resources');
  await Promise.all([
    mkdir(dataDir),
    mkdir(resourceRoot),
  ]);
  const launched = spawnWaitingForOutputLine(
    process.execPath,
    [
      cliEntry,
      'daemon',
      'start',
      '--headless',
      '--port',
      '0',
    ],
    {
      cwd: daemonRoot,
      env: {
        ...process.env,
        READABLE_BIND_HOST: '127.0.0.1',
        READABLE_DATA_DIR: dataDir,
        READABLE_RESOURCE_ROOT: resourceRoot,
      },
    },
    READY_PATTERN,
    REAL_DAEMON_COLD_START_DEADLOCK_GUARD_MS,
  );

  try {
    const line = await launched.line;
    const match = line.match(/(http:\/\/[^\s]+)/u);
    const daemonUrl = match?.[1];
    expect(daemonUrl).toBeTruthy();
    const parsed = new URL(daemonUrl!);
    expect(Number(parsed.port)).toBeGreaterThan(0);

    const healthResp = await fetch(`${daemonUrl}/api/health`);
    expect(healthResp.status).toBe(200);

    const statusResp = await fetch(`${daemonUrl}/api/daemon/status`);
    expect(statusResp.status).toBe(200);
    const status = await statusResp.json() as { bindHost: string; port: number; installedPlugins: number };
    expect(status.bindHost).toBe('127.0.0.1');
    expect(status.port).toBe(Number(parsed.port));
    expect(status.installedPlugins).toBe(0);

    const pluginsResp = await fetch(`${daemonUrl}/api/plugins`);
    expect(pluginsResp.status).toBe(200);
    const plugins = await pluginsResp.json() as { plugins: unknown[] };
    expect(plugins.plugins).toEqual([]);
    expect(launched.child.exitCode).toBeNull();
  } finally {
    await launched.terminate();
    await rm(root, { recursive: true, force: true });
  }
}
