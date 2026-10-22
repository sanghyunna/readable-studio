import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { daemonRoot, sourceStamp } from '../scripts/write-build-stamp.js';

export function verifyDaemonBuild(root = daemonRoot): void {
  const cli = path.join(root, 'dist', 'cli.js');
  if (!existsSync(cli)) {
    const npmExecPath = process.env.npm_execpath;
    const useNode = typeof npmExecPath === 'string' && /\.(?:js|cjs)$/i.test(npmExecPath);
    const command = useNode ? process.execPath : process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    const args = useNode ? [npmExecPath!, 'run', 'build'] : ['run', 'build'];
    const result = spawnSync(command, args, {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      throw result.error ?? new Error(`Daemon build exited with status ${result.status}`);
    }
  }
  if (process.env.READABLE_VERIFY_DAEMON_STAMP !== '1') return;

  const producer = 'pnpm --filter @readable-studio/daemon build';
  const fail = (reason: string): never => {
    throw new Error(`Daemon test prerequisite: ${reason}. Run "${producer}" before Vitest. The producer must finish with "pnpm --filter @readable-studio/daemon exec tsx scripts/write-build-stamp.ts". Tests never build dist.`);
  };
  const stampPath = path.join(root, 'dist', '.source-stamp.json');
  if (!existsSync(stampPath)) fail('dist/.source-stamp.json is missing (stale build)');
  let stamp: unknown;
  try {
    stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
  } catch {
    fail('dist/.source-stamp.json is unreadable (stale build)');
  }
  if (typeof stamp !== 'object' || stamp === null || !('sha256' in stamp) || stamp.sha256 !== sourceStamp(root)) {
    fail('dist source stamp does not match src/**, tsconfig.json and package.json (stale build)');
  }
}

const STALE_RUN_ROOT_MS = 6 * 60 * 60 * 1000;
const TEARDOWN_ATTEMPTS = 15;
const TEARDOWN_RETRY_MS = 500;

function removeStaleRunRoots(parent: string): void {
  try {
    const cutoff = Date.now() - STALE_RUN_ROOT_MS;
    for (const name of readdirSync(parent)) {
      if (!name.startsWith('rdv-run-')) continue;
      try {
        const dir = path.join(parent, name);
        if (statSync(dir).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // Best effort: another run may own it or still hold files.
      }
    }
  } catch {
    // Best effort.
  }
}

export default function setup(): () => Promise<void> {
  verifyDaemonBuild();
  removeStaleRunRoots(tmpdir());
  // One run-level parent: fork workers inherit TEMP/TMP/TMPDIR, so their per-fork
  // roots land inside it and a single rmSync here cleans every one of them, even
  // when Vitest kills workers before their exit hooks run.
  const runRoot = mkdtempSync(path.join(tmpdir(), 'rdv-run-'));
  process.env.TEMP = runRoot;
  process.env.TMP = runRoot;
  process.env.TMPDIR = runRoot;
  return async () => {
    // Forks may still hold SQLite files while teardown starts; retry for at most ~7.5s.
    for (let attempt = 1; attempt <= TEARDOWN_ATTEMPTS; attempt++) {
      try {
        rmSync(runRoot, { recursive: true, force: true, maxRetries: 3 });
        return;
      } catch {
        if (attempt === TEARDOWN_ATTEMPTS) return;
        await new Promise<void>((resolve) => setTimeout(resolve, TEARDOWN_RETRY_MS));
      }
    }
  };
}
