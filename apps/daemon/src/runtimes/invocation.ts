import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { createCommandInvocation } from '@readable-studio/platform';
import type { RuntimeExecOptions } from './types.js';

const execFileP = promisify(execFile);

export function createAgentCommandInvocation(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  // Worker environments and plain objects lose Windows' case-insensitive lookup.
  const shell = process.platform === 'win32'
    ? Object.entries(env).find(([key]) => key.toUpperCase() === 'COMSPEC')?.[1]
      ?? Object.entries(process.env).find(([key]) => key.toUpperCase() === 'COMSPEC')?.[1]
    : undefined;
  return createCommandInvocation({ command, args, env: shell ? { ...env, ComSpec: shell } : env });
}

// Agent probes (model-list / version / help / auth-status) are short read-only
// metadata calls that never need the caller's project files. Default them to a
// neutral working directory instead of inheriting the daemon process cwd.
//
// This matters because some agent CLIs are bun-based (OpenCode) and run a
// `bun install` on startup in their cwd to set up local plugins. When the daemon
// is launched from a pnpm workspace (e.g. a dev checkout), inheriting that cwd
// let an `opencode models` probe drop a workspace `bun.lock` + `node_modules/.bun`
// over the repo, wiping its pnpm store and breaking `next dev`. A probe writing a
// stray lockfile under the OS temp dir is harmless. Actual agent runs spawn
// elsewhere with an explicit project cwd and are unaffected.
export function execAgentFile(
  command: string,
  args: string[],
  options: RuntimeExecOptions = {},
) {
  const invocation = createAgentCommandInvocation(command, args, options.env);
  return execFileP(invocation.command, invocation.args, {
    ...options,
    windowsHide: true,
    cwd: options.cwd ?? os.tmpdir(),
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}
