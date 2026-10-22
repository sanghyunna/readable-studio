import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const scriptRoot = dirname(fileURLToPath(import.meta.url));
export const workspaceRoot = dirname(dirname(scriptRoot));
export const canonicalProductName = 'Readable Studio';
export const previewSelector = '[data-testid="artifact-preview-frame"]:visible, [data-testid="artifact-preview-frame-url-load"]:visible, [data-testid="artifact-preview-frame-srcdoc"]:visible';

export type QaCase = 'full' | 'launch' | 'bad-root';

export type Options = {
  readonly case: QaCase;
  readonly evidenceRoot: string;
  readonly offline: boolean;
  readonly zipPath: string;
  readonly mode?: 'tree-precheck' | 'zip-gate';
  readonly treePath?: string;
  readonly sealedManifestPath?: string;
  readonly zipReceiptPath?: string;
  readonly runId?: string;
};

export function createQaNamespaces(mode: Options['mode']) {
  const prefix = `qa-${mode ?? 'legacy'}-${randomUUID().replaceAll('-', '')}`;
  return {
    launcher: `${prefix}-launcher`,
    primary: `${prefix}-a`,
    secondary: `${prefix}-b`,
    badRoot: `${prefix}-bad-root`,
    malformed: `${prefix}-malformed`,
    foreignRoot: `${prefix}-foreign-root`,
    foreignData: `${prefix}-foreign-data`,
  };
}

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
    process.stdout.write('Usage: tsx scripts/portable-qa.ts --zip <portable.zip> --case full|launch|bad-root --evidence <dir> [--offline] [--mode tree-precheck|zip-gate --sealed-manifest <file> --tree <dir> | --zip-receipt <file> --run-id <id>]\n');
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
    if (!['--zip', '--case', '--evidence', '--mode', '--tree', '--sealed-manifest', '--zip-receipt', '--run-id'].includes(token ?? '')) {
      throw new PortableQaError(`unknown argument: ${token ?? '<missing>'}`);
    }
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) throw new PortableQaError(`missing value for ${token}`);
    values.set(token!, value);
    index += 1;
  }
  const zipValue = values.get('--zip');
  const caseValue = values.get('--case');
  const evidenceValue = values.get('--evidence');
  const mode = values.get('--mode');
  if (mode != null && mode !== 'tree-precheck' && mode !== 'zip-gate') throw new PortableQaError(`invalid --mode: ${mode}`);
  if ((zipValue == null && mode !== 'tree-precheck') || caseValue == null || evidenceValue == null) {
    throw new PortableQaError('--zip, --case, and --evidence are required');
  }
  const manifest = values.get('--sealed-manifest');
  const tree = values.get('--tree');
  const receipt = values.get('--zip-receipt');
  const runId = values.get('--run-id');
  if (mode != null && (manifest == null || (mode === 'tree-precheck' ? tree == null : receipt == null || runId == null))) {
    throw new PortableQaError('tree-precheck requires --tree and --sealed-manifest; zip-gate requires --sealed-manifest, --zip-receipt, and --run-id');
  }
  if (mode != null && caseValue !== 'full' && caseValue !== 'launch') throw new PortableQaError('sealed QA modes require --case full or launch');
  return {
    case: parseCase(caseValue),
    evidenceRoot: resolveFromWorkspace(evidenceValue),
    offline,
    zipPath: zipValue == null ? '' : resolveFromWorkspace(zipValue),
    ...(mode == null ? {} : { mode }),
    ...(tree == null ? {} : { treePath: resolveFromWorkspace(tree) }),
    ...(manifest == null ? {} : { sealedManifestPath: resolveFromWorkspace(manifest) }),
    ...(receipt == null ? {} : { zipReceiptPath: resolveFromWorkspace(receipt) }),
    ...(runId == null ? {} : { runId }),
  };
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// Wire contract only: e2e never imports the packaging implementation.
export async function verifyZipReceipt(zipPath: string, receiptPath: string, runId: string): Promise<string> {
  const receipt = toRecord(JSON.parse(await readFile(receiptPath, 'utf8')), 'ZIP receipt');
  if (receipt.v !== 1 || receipt.runId !== runId || receipt.node !== 'zip' ||
      typeof receipt.inputHash !== 'string' || typeof receipt.outputRoot !== 'string' ||
      !isAbsolute(receipt.outputRoot) || !Array.isArray(receipt.files) || receipt.files.length !== 1) {
    throw new PortableQaError('invalid ZIP receipt identity');
  }
  const manifestHash = createHash('sha256').update(JSON.stringify(receipt.files)).digest('hex');
  if (receipt.manifestHash !== manifestHash) throw new PortableQaError('invalid ZIP receipt manifest hash');
  const file = toRecord(receipt.files[0], 'ZIP receipt file');
  // build-portable.ps1 moves the sealed archive into its drop directory.
  // The file name, size and full digest bind a relocated copy to this receipt.
  if (file.path !== basename(zipPath)) {
    throw new PortableQaError('ZIP receipt points at a different archive');
  }
  const metadata = await stat(zipPath);
  const hash = await sha256File(zipPath);
  if (!metadata.isFile() || metadata.size !== file.size || hash !== file.sha256) {
    throw new PortableQaError('ZIP modified after receipt');
  }
  return hash;
}

function parseCase(value: string): QaCase {
  switch (value) {
    case 'full':
    case 'launch':
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
