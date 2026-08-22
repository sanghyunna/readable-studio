import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export type FakeAgentOptions = {
  isolated?: boolean;
  setAgentHome?: boolean;
  deleteEnv?: string[];
  winInterpreter?: string;
};

export async function writeExecutableScript(
  dir: string,
  name: string,
  script: string,
  options?: { winInterpreter?: string },
): Promise<string> {
  const trackedScript = shouldTrackPid(script)
    ? scriptWithPidTracking(script, path.join(dir, `${name}-pids.txt`))
    : script;
  if (process.platform === 'win32') {
    const runner = path.join(dir, `${name}-runner.cjs`);
    await writeFile(runner, trackedScript);
    const bin = path.join(dir, `${name}.cmd`);
    const interpreter = options?.winInterpreter ?? process.execPath;
    await writeFile(bin, `@echo off\r\n"${interpreter}" "${runner}" %*\r\n`);
    return bin;
  }

  const bin = path.join(dir, name);
  await writeFile(bin, trackedScript.startsWith('#!') ? trackedScript : `#!/usr/bin/env node\n${trackedScript}`);
  await chmod(bin, 0o755);
  return bin;
}

export async function cleanupFakeAgentDir(dir: string): Promise<void> {
  await killTrackedFakeAgentProcesses(dir);
  await removeFakeAgentDirWithRetry(dir);
}

export async function withFakeAgent<T>(
  binName: string,
  script: string,
  run: () => Promise<T>,
  options?: FakeAgentOptions,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'readable-fake-agent-'));
  const originalPath = process.env.PATH;
  const originalAgentHome = process.env.READABLE_AGENT_HOME;
  const deletedEnv = new Map<string, string | undefined>(
    (options?.deleteEnv ?? []).map((key) => [key, process.env[key]]),
  );

  try {
    await writeExecutableScript(
      dir,
      binName,
      script,
      options?.winInterpreter == null ? undefined : { winInterpreter: options.winInterpreter },
    );
    process.env.PATH = options?.isolated
      ? dir
      : originalPath == null || originalPath === ''
        ? dir
        : `${dir}${path.delimiter}${originalPath}`;

    if (options?.setAgentHome) {
      process.env.READABLE_AGENT_HOME = dir;
    }

    for (const key of deletedEnv.keys()) {
      delete process.env[key];
    }

    return await run();
  } finally {
    if (originalPath == null) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }

    if (originalAgentHome == null) {
      delete process.env.READABLE_AGENT_HOME;
    } else {
      process.env.READABLE_AGENT_HOME = originalAgentHome;
    }

    for (const [key, value] of deletedEnv) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    await cleanupFakeAgentDir(dir);
  }
}

export function namedPipePath(name: string): string {
  return process.platform === 'win32'
    ? '\\\\.\\pipe\\' + name
    : `/tmp/readable-studio/ipc/${name}.sock`;
}

function scriptWithPidTracking(script: string, pidLogPath: string): string {
  const tracking = [
    "const __odFakeAgentFs = require('node:fs');",
    `try { __odFakeAgentFs.appendFileSync(${JSON.stringify(pidLogPath)}, String(process.pid) + '\\n'); } catch {}`,
  ].join('\n');
  if (!script.startsWith('#!')) {
    return [tracking, script].join('\n');
  }

  const lineEnd = script.indexOf('\n');
  if (lineEnd === -1) {
    return `${script}\n${tracking}`;
  }

  return `${script.slice(0, lineEnd + 1)}${tracking}\n${script.slice(lineEnd + 1)}`;
}

function shouldTrackPid(script: string): boolean {
  if (!script.startsWith('#!')) {
    return true;
  }

  const firstLineEnd = script.indexOf('\n');
  const firstLine = firstLineEnd === -1 ? script : script.slice(0, firstLineEnd);
  return /\bnode(?:\.exe)?\b/i.test(firstLine);
}

async function killTrackedFakeAgentProcesses(dir: string): Promise<void> {
  const pids = await readTrackedPids(dir);
  await Promise.all([...pids].map((pid) => killPidTree(pid)));
}

async function readTrackedPids(dir: string): Promise<Set<number>> {
  const pids = new Set<number>();
  let entries: Awaited<ReturnType<typeof readFakeAgentDirEntries>>;
  try {
    entries = await readFakeAgentDirEntries(dir);
  } catch {
    return pids;
  }

  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('-pids.txt'))
    .map(async (entry) => {
      try {
        const raw = await readFile(path.join(dir, entry.name), 'utf8');
        for (const line of raw.split(/\r?\n/)) {
          const pid = Number(line.trim());
          if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
            pids.add(pid);
          }
        }
      } catch {
        // Best effort only; stale pid logs should never make cleanup hang.
      }
    }));

  return pids;
}

async function readFakeAgentDirEntries(dir: string) {
  return readdir(dir, { withFileTypes: true, encoding: 'utf8' });
}

async function killPidTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await execFileP('taskkill', ['/PID', String(pid), '/T', '/F'], {
      timeout: 5_000,
      windowsHide: true,
    }).catch(() => undefined);
    return;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already exited.
  }
}

async function removeFakeAgentDirWithRetry(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(String(code))) {
        throw error;
      }
      await delay(50 * (attempt + 1));
    }
  }

  console.warn(
    `[fake-agent] failed to remove temp dir ${dir}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
