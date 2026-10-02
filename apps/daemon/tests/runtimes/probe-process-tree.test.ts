import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { expect, test, vi } from 'vitest';
import { execAgentFile } from '../../src/runtimes/invocation.js';
import * as probeLifetime from '../../src/runtimes/probe-lifetime.js';
const { withProbeLifetime } = probeLifetime;

const exec = promisify(execFile);
async function alive(pid: number): Promise<boolean> {
  const { stdout } = await exec('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 });
  return String(stdout).includes(`"${pid}"`);
}

// The fake agent emits readiness only after its descendant is running; no sleeps.
test.runIf(process.platform === 'win32').each(['timeout', 'abort'] as const)(
  'a %s probe leaves no blocked descendant behind', async (mode) => {
    const controller = new AbortController();
    const pending = execAgentFile(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: true });
      child.once('spawn', () => console.log(child.pid));
      setInterval(() => {}, 1000);
    `], { timeout: mode === 'timeout' ? 2000 : 10000, signal: controller.signal });
    const rejected = pending.catch(error => error);
    const stdout = pending.child.stdout!;
    const ready = await once(stdout, 'data', { signal: AbortSignal.timeout(10000) });
    const descendant = Number(String(ready[0]).trim());
    expect(descendant).toBeGreaterThan(0);
    expect(await alive(descendant)).toBe(true);
    try {
      if (mode === 'abort') controller.abort();
      const error = await rejected;
      expect(error).toBeInstanceOf(Error);
      expect(await alive(pending.child.pid!)).toBe(false);
      expect(await alive(descendant)).toBe(false);
    } finally {
      if (await alive(descendant)) await exec('taskkill.exe', ['/T', '/F', '/PID', String(descendant)], { windowsHide: true, timeout: 5000 });
    }
  }, 15000,
);

test.runIf(process.platform === 'win32')('scan cancellation joins custom transport tree cleanup before returning', async () => {
  const controller = new AbortController();
  let child!: ReturnType<typeof spawn>;
  const pending = withProbeLifetime(controller.signal, () => {
    child = spawn(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true });
      descendant.once('spawn', () => console.log(descendant.pid));
      setInterval(() => {}, 1000);
    `], { windowsHide: true });
    return new Promise<void>((resolve, reject) => {
      child.once('close', () => resolve());
      child.once('error', reject);
    });
  });
  const rejected = pending.catch(error => error);
  const [data] = await once(child.stdout!, 'data', { signal: AbortSignal.timeout(10000) });
  const descendant = Number(String(data).trim());
  try {
    expect(await alive(descendant)).toBe(true);
    controller.abort();
    expect(await rejected).toBe(controller.signal.reason);
    expect(await alive(child.pid!)).toBe(false);
    expect(await alive(descendant)).toBe(false);
  } finally {
    if (await alive(descendant)) await exec('taskkill.exe', ['/T', '/F', '/PID', String(descendant)], { windowsHide: true, timeout: 5000 });
  }
}, 15000);

test.runIf(process.platform === 'win32')('daemon shutdown joins every in-flight probe tree before exit', async () => {
  vi.resetModules();
  const { execAgentFile: shutdownExec } = await import('../../src/runtimes/invocation.js');
  const { shutdownProbes } = await import('../../src/runtimes/probe-lifetime.js');
  const pending = shutdownExec(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: true });
    child.once('spawn', () => console.log(child.pid));
    setInterval(() => {}, 1000);
  `], { timeout: 60000, env: { ...process.env, READABLE_PACKAGED_NAMESPACE: 'probe-fix' } });
  const settled = pending.catch(error => error);
  const [data] = await once(pending.child.stdout!, 'data', { signal: AbortSignal.timeout(10000) });
  const descendant = Number(String(data).trim());
  try {
    expect(await alive(descendant)).toBe(true);
    await shutdownProbes();
    expect(await alive(pending.child.pid!)).toBe(false);
    expect(await alive(descendant)).toBe(false);
    await settled;
  } finally {
    for (const pid of [pending.child.pid!, descendant]) {
      if (await alive(pid)) await exec('taskkill.exe', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: 5000 });
    }
    await settled;
  }
}, 15000);

test('a probe waiting for stdin receives EOF and returns before its timeout', async () => {
  const result = await execAgentFile(process.execPath, ['-e', `
    process.stdin.resume();
    process.stdin.once('end', () => console.log('eof'));
  `], { timeout: 2000 });
  expect(String(result.stdout).trim()).toBe('eof');
});
