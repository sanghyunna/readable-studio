import type { ApiErrorCode } from '@readable-studio/contracts';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

interface Limits {
  readonly bytesGlobal: number;
  readonly bytesPerProject: number;
  readonly filesPerProject: number;
}

export const HOSTED_CONTENT_QUOTA_LIMITS: Readonly<Limits> = Object.freeze({
  bytesGlobal: 32 * 1024 * 1024 * 1024,
  bytesPerProject: 1024 * 1024 * 1024,
  filesPerProject: 10_000,
});

export interface HostedContentUsage {
  readonly bytes: number;
  readonly files: number;
}

export type HostedContentQuotaOperation =
  | { readonly kind: 'write'; readonly path: string; readonly bytes: number }
  | { readonly kind: 'growth'; readonly bytes: number; readonly files: number }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string }
  | { readonly kind: 'delete'; readonly path: string }
  | { readonly kind: 'folder.create' | 'folder.delete'; readonly path: string };

export class HostedContentQuotaError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HostedContentQuotaError';
    this.code = code;
  }
}

export interface HostedContentQuota {
  scanWorkspace(rootPath: string): Promise<HostedContentUsage>;
  runMutation<T>(
    input: {
      readonly allWorkspaceRoots: readonly string[];
      readonly operation: HostedContentQuotaOperation;
      readonly workspaceRoot: string;
    },
    mutate: () => T | Promise<T>,
  ): Promise<T>;
}

interface WorkspaceScan extends HostedContentUsage {
  readonly directories: ReadonlySet<string>;
  readonly fileBytes: ReadonlyMap<string, number>;
  readonly rootPath: string;
}

export function createHostedContentQuota(
  overrides: Partial<Limits> = {},
): HostedContentQuota {
  const limits = validateLimits({ ...HOSTED_CONTENT_QUOTA_LIMITS, ...overrides });
  let queue = Promise.resolve();

  async function locked<T>(work: () => Promise<T>): Promise<T> {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  return {
    async scanWorkspace(rootPath) {
      const scan = await scanExact(rootPath, limits);
      return { bytes: scan.bytes, files: scan.files };
    },

    runMutation(input, mutate) {
      if (typeof mutate !== 'function') throw new TypeError('hosted content mutation is required');
      return locked(async () => {
        const roots = uniqueRoots(input.allWorkspaceRoots);
        const targetRoot = await exactRoot(input.workspaceRoot);
        if (!roots.some((root) => samePath(root, targetRoot))) {
          throw new HostedContentQuotaError('BAD_REQUEST', 'workspace root is outside the quota set');
        }

        const scans = new Map<string, WorkspaceScan>();
        let globalBytes = 0;
        for (const root of roots) {
          let scan: WorkspaceScan;
          try {
            scan = await scanExact(root, limits);
          } catch (error) {
            if (
              !samePath(root, targetRoot)
              && error instanceof HostedContentQuotaError
              && error.code === 'FILE_NOT_FOUND'
            ) {
              try {
                await exactRoot(root);
              } catch (rootError) {
                if (
                  rootError instanceof HostedContentQuotaError
                  && rootError.code === 'FILE_NOT_FOUND'
                ) continue;
              }
            }
            throw error;
          }
          scans.set(comparablePath(scan.rootPath), scan);
          globalBytes += scan.bytes;
          if (!Number.isSafeInteger(globalBytes) || globalBytes > limits.bytesGlobal) {
            throw new HostedContentQuotaError(
              'HOSTED_CAPACITY_EXHAUSTED',
              'hosted workspace process capacity is exhausted',
            );
          }
        }

        const current = scans.get(comparablePath(targetRoot));
        if (current == null) {
          throw new HostedContentQuotaError('BAD_REQUEST', 'workspace root is outside the quota set');
        }
        const projected = projectMutation(current, input.operation);
        if (projected.bytes > limits.bytesPerProject || projected.files > limits.filesPerProject) {
          throw new HostedContentQuotaError(
            'HOSTED_QUOTA_EXCEEDED',
            'hosted project workspace quota is exceeded',
          );
        }
        if (globalBytes - current.bytes + projected.bytes > limits.bytesGlobal) {
          throw new HostedContentQuotaError(
            'HOSTED_CAPACITY_EXHAUSTED',
            'hosted workspace process capacity is exhausted',
          );
        }
        return mutate();
      });
    },
  };
}

function projectMutation(
  current: WorkspaceScan,
  operation: HostedContentQuotaOperation,
): HostedContentUsage {
  if (operation.kind === 'growth') {
    if (
      !Number.isSafeInteger(operation.bytes)
      || operation.bytes < 0
      || !Number.isSafeInteger(operation.files)
      || operation.files < 0
    ) {
      throw new HostedContentQuotaError('BAD_REQUEST', 'workspace growth is invalid');
    }
    return {
      bytes: current.bytes + operation.bytes,
      files: current.files + operation.files,
    };
  }
  if (operation.kind === 'write') {
    const relative = canonicalRelativePath(operation.path);
    if (!Number.isSafeInteger(operation.bytes) || operation.bytes < 0) {
      throw new HostedContentQuotaError('BAD_REQUEST', 'write size is invalid');
    }
    assertNoFileAncestor(current, relative);
    if (current.directories.has(relative)) {
      throw new HostedContentQuotaError('CONFLICT', 'write target is a directory');
    }
    const previous = current.fileBytes.get(relative);
    return {
      bytes: current.bytes - (previous ?? 0) + operation.bytes,
      files: current.files + (previous === undefined ? 1 : 0),
    };
  }
  if (operation.kind === 'rename') {
    const from = canonicalRelativePath(operation.from);
    const to = canonicalRelativePath(operation.to);
    if (!current.fileBytes.has(from)) {
      throw new HostedContentQuotaError('FILE_NOT_FOUND', 'rename source does not exist');
    }
    assertNoFileAncestor(current, to);
    if (from !== to && (current.fileBytes.has(to) || current.directories.has(to))) {
      throw new HostedContentQuotaError('CONFLICT', 'rename target already exists');
    }
    return { bytes: current.bytes, files: current.files };
  }
  if (operation.kind === 'delete') {
    const relative = canonicalRelativePath(operation.path);
    const bytes = current.fileBytes.get(relative);
    if (bytes === undefined) {
      throw new HostedContentQuotaError('FILE_NOT_FOUND', 'delete target does not exist');
    }
    return { bytes: current.bytes - bytes, files: current.files - 1 };
  }

  const relative = canonicalRelativePath(operation.path);
  if (operation.kind === 'folder.create') {
    assertNoFileAncestor(current, relative);
    if (current.fileBytes.has(relative)) {
      throw new HostedContentQuotaError('CONFLICT', 'folder target is a file');
    }
    return { bytes: current.bytes, files: current.files };
  }
  if (!current.directories.has(relative)) {
    throw new HostedContentQuotaError('FILE_NOT_FOUND', 'folder target does not exist');
  }
  let removedBytes = 0;
  let removedFiles = 0;
  const prefix = `${relative}/`;
  for (const [file, bytes] of current.fileBytes) {
    if (!file.startsWith(prefix)) continue;
    removedBytes += bytes;
    removedFiles += 1;
  }
  return { bytes: current.bytes - removedBytes, files: current.files - removedFiles };
}

async function scanExact(input: string, limits: Limits): Promise<WorkspaceScan> {
  const rootPath = await exactRoot(input);
  const fileBytes = new Map<string, number>();
  const directories = new Set<string>();
  const pending: Array<{ absolute: string; relative: string }> = [{ absolute: rootPath, relative: '' }];
  let bytes = 0;
  let entries = 0;

  while (pending.length > 0) {
    const directory = pending.pop()!;
    let children;
    try {
      children = await readdir(directory.absolute, { withFileTypes: true });
    } catch (error) {
      throw fileError('cannot scan hosted workspace', error);
    }
    for (const child of children) {
      entries += 1;
      if (entries > limits.filesPerProject * 2) {
        throw new HostedContentQuotaError(
          'HOSTED_QUOTA_EXCEEDED',
          'hosted workspace entry quota is exceeded',
        );
      }
      const relative = directory.relative ? `${directory.relative}/${child.name}` : child.name;
      const absolute = path.join(directory.absolute, child.name);
      const info = await exactInfo(absolute, rootPath);
      if (info.isDirectory()) {
        directories.add(relative);
        pending.push({ absolute, relative });
        continue;
      }
      if (!info.isFile()) {
        throw new HostedContentQuotaError('BAD_REQUEST', 'hosted workspace contains a special file');
      }
      if (!Number.isSafeInteger(info.size) || info.size < 0) {
        throw new HostedContentQuotaError('HOSTED_QUOTA_EXCEEDED', 'hosted workspace file size is invalid');
      }
      fileBytes.set(relative, info.size);
      bytes += info.size;
      if (fileBytes.size > limits.filesPerProject || bytes > limits.bytesPerProject) {
        throw new HostedContentQuotaError(
          'HOSTED_QUOTA_EXCEEDED',
          'hosted project workspace quota is exceeded',
        );
      }
    }
  }
  return { bytes, directories, fileBytes, files: fileBytes.size, rootPath };
}

async function exactRoot(input: string): Promise<string> {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) {
    throw new HostedContentQuotaError('BAD_REQUEST', 'hosted workspace root is invalid');
  }
  const rootPath = path.resolve(input);
  const info = await exactInfo(rootPath, rootPath);
  if (!info.isDirectory()) {
    throw new HostedContentQuotaError('BAD_REQUEST', 'hosted workspace root is not a directory');
  }
  return await realpath(rootPath);
}

async function exactInfo(candidate: string, rootPath: string) {
  if (!isContained(rootPath, candidate)) {
    throw new HostedContentQuotaError('BAD_REQUEST', 'hosted workspace path escapes its root');
  }
  try {
    const before = await lstat(candidate);
    if (before.isSymbolicLink()) {
      throw new HostedContentQuotaError('BAD_REQUEST', 'hosted workspace contains a link');
    }
    const canonical = await realpath(candidate);
    if (!samePath(canonical, candidate) || !isContained(rootPath, canonical)) {
      throw new HostedContentQuotaError(
        'BAD_REQUEST',
        'hosted workspace contains a link or reparse point',
      );
    }
    const after = await lstat(candidate);
    if (!sameFileState(before, after)) {
      throw new HostedContentQuotaError(
        'HOSTED_RUNTIME_UNAVAILABLE',
        'hosted workspace changed during quota scan',
      );
    }
    return after;
  } catch (error) {
    if (error instanceof HostedContentQuotaError) throw error;
    throw fileError('hosted workspace path is unavailable', error);
  }
}

function sameFileState(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.mode === right.mode;
}

function uniqueRoots(inputs: readonly string[]): string[] {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 64) {
    throw new HostedContentQuotaError('BAD_REQUEST', 'hosted workspace root set is invalid');
  }
  const roots = new Map<string, string>();
  for (const input of inputs) {
    if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) {
      throw new HostedContentQuotaError('BAD_REQUEST', 'hosted workspace root set is invalid');
    }
    const root = path.resolve(input);
    roots.set(comparablePath(root), root);
  }
  return [...roots.values()];
}

function canonicalRelativePath(input: unknown): string {
  if (typeof input !== 'string'
    || input.length < 1
    || Buffer.byteLength(input, 'utf8') > 1_024
    || Buffer.from(input, 'utf8').toString('utf8') !== input
    || input.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(input)
    || /^[A-Za-z]:/u.test(input)
    || /%(?:00|2e|2f|5c|25(?:00|2e|2f|5c))/iu.test(input)
    || path.posix.isAbsolute(input)
    || input.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) throw new HostedContentQuotaError('BAD_REQUEST', 'hosted content path is invalid');
  return input;
}

function assertNoFileAncestor(scan: WorkspaceScan, relative: string): void {
  const segments = relative.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    if (scan.fileBytes.has(segments.slice(0, index).join('/'))) {
      throw new HostedContentQuotaError('CONFLICT', 'hosted content parent is a file');
    }
  }
}

function validateLimits(input: Limits): Limits {
  for (const [key, maximum] of Object.entries(HOSTED_CONTENT_QUOTA_LIMITS)) {
    const value = input[key as keyof Limits];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new TypeError(`hosted content quota ${key} is invalid`);
    }
  }
  return Object.freeze(input);
}

function isContained(rootPath: string, candidate: string): boolean {
  const relative = path.relative(rootPath, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function comparablePath(input: string): string {
  let normalized = path.resolve(input);
  if (process.platform === 'win32') {
    normalized = normalized
      .replace(/^\\\\\?\\UNC\\/iu, '\\\\')
      .replace(/^\\\\\?\\/u, '')
      .toLowerCase();
  }
  return normalized.replace(/[\\/]+$/u, '');
}

function fileError(message: string, cause: unknown): HostedContentQuotaError {
  const missing = typeof cause === 'object'
    && cause !== null
    && 'code' in cause
    && (cause.code === 'ENOENT' || cause.code === 'ENOTDIR');
  return new HostedContentQuotaError(missing ? 'FILE_NOT_FOUND' : 'HOSTED_RUNTIME_UNAVAILABLE', message, cause);
}
