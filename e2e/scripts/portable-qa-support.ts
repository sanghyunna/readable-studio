import { spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const scriptRoot = dirname(fileURLToPath(import.meta.url));
export const workspaceRoot = dirname(dirname(scriptRoot));
export const canonicalProductName = 'Readable Studio';
export const previewSelector = '[data-testid="artifact-preview-frame"]:visible, [data-testid="artifact-preview-frame-url-load"]:visible, [data-testid="artifact-preview-frame-srcdoc"]:visible';

export type QaCase = 'full' | 'bad-root';

export type Options = {
  readonly case: QaCase;
  readonly evidenceRoot: string;
  readonly offline: boolean;
  readonly zipPath: string;
};

export type CommandResult = {
  readonly args: readonly string[];
  readonly command: string;
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

export class PortableQaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PortableQaError';
  }
}

export function parseOptions(argv: readonly string[]): Options {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Usage: tsx scripts/portable-qa.ts --zip <portable.zip> --case full|bad-root --evidence <dir> [--offline]\n');
    process.exit(0);
  }
  const values = new Map<string, string>();
  let offline = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--offline') {
      offline = true;
      continue;
    }
    if (token !== '--zip' && token !== '--case' && token !== '--evidence') {
      throw new PortableQaError(`unknown argument: ${token ?? '<missing>'}`);
    }
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) throw new PortableQaError(`missing value for ${token}`);
    values.set(token, value);
    index += 1;
  }
  const zipValue = values.get('--zip');
  const caseValue = values.get('--case');
  const evidenceValue = values.get('--evidence');
  if (zipValue == null || caseValue == null || evidenceValue == null) {
    throw new PortableQaError('--zip, --case, and --evidence are required');
  }
  return {
    case: parseCase(caseValue),
    evidenceRoot: resolveFromWorkspace(evidenceValue),
    offline,
    zipPath: resolveFromWorkspace(zipValue),
  };
}

function parseCase(value: string): QaCase {
  switch (value) {
    case 'full':
    case 'bad-root':
      return value;
    default:
      throw new PortableQaError(`invalid --case: ${value}`);
  }
}

function resolveFromWorkspace(path: string): string {
  return isAbsolute(path) ? path : resolve(workspaceRoot, path);
}

export function validateEvidenceRoot(resolvedPath: string): void {
  const normalized = resolve(resolvedPath);
  const workspace = resolve(workspaceRoot);
  const evidenceBase = resolve(workspace, '.omo', 'evidence');
  const temp = resolve(tmpdir());
  const normalizedLower = normalized.toLowerCase();
  const workspaceLower = workspace.toLowerCase();
  const evidenceBaseLower = evidenceBase.toLowerCase();
  const tempLower = temp.toLowerCase();
  const insideEvidence = normalizedLower.startsWith(evidenceBaseLower + sep);
  const insideTempSubdirectory = normalizedLower.startsWith(tempLower + sep);
  const isGitPath = normalizedLower === `${workspaceLower}${sep}.git` || normalizedLower.startsWith(`${workspaceLower}${sep}.git${sep}`);
  if ((!insideEvidence && !insideTempSubdirectory) || isGitPath) {
    throw new PortableQaError(
      `evidence root ${resolvedPath} is not inside the dedicated evidence directory (${evidenceBase}) or a temp subdirectory; refusing to delete workspace, git, or ancestor paths`,
    );
  }
}

export async function runCommand(
  command: string,
  args: readonly string[],
  input?: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const child = spawn(command, args, {
    cwd: workspaceRoot,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  if (input == null) child.stdin.end();
  else child.stdin.end(input, 'utf8');
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        rejectExit(new PortableQaError(`command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`));
      } else {
        resolveExit(code ?? 1);
      }
    });
  });
  return {
    args,
    command,
    exitCode,
    stderr: Buffer.concat(stderr).toString('utf8'),
    stdout: Buffer.concat(stdout).toString('utf8'),
  };
}

export function toRecord(value: unknown, label = 'value'): Record<string, unknown> {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    throw new PortableQaError(`${label} must be a JSON object`);
  }
  return Object.fromEntries(Object.entries(value));
}

export type CleanupResult = {
  readonly warning: string | null;
  readonly leftoverPath: string | null;
};

export async function cleanupExtractionRoot(
  extractionRoot: string,
  remove: typeof rm = rm,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
): Promise<CleanupResult> {
  const backoff = [250, 500, 1_000, 2_000, 4_000, 6_000];
  let lastError: unknown;
  for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
    try {
      await remove(extractionRoot, { force: true, recursive: true });
      return { leftoverPath: null, warning: null };
    } catch (error) {
      lastError = error;
      if (attempt < backoff.length) await wait(backoff[attempt]!);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  return {
    leftoverPath: extractionRoot,
    warning: `[portable-qa] non-fatal cleanup warning: could not remove ${extractionRoot}: ${detail}`,
  };
}

export function acceptanceExitCode(assertionFailed: boolean, _cleanup: CleanupResult): number {
  return assertionFailed ? 1 : 0;
}

export async function writeEvidence(root: string, name: string, value: unknown): Promise<void> {
  await writeFile(resolve(root, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
