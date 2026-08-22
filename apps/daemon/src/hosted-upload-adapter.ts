import type { ApiErrorCode } from '@readable-studio/contracts';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';

import { decodeMultipartFilename, sanitizeName } from './projects.js';

export const HOSTED_UPLOAD_LIMITS = Object.freeze({
  dirBytes: 1_024,
  fileBytes: 20 * 1024 * 1024,
  files: 12,
  requestBytes: 100 * 1024 * 1024,
  timeoutMs: 120_000,
});

export class HostedUploadError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HostedUploadError';
    this.code = code;
  }
}

/** The Express-independent subset produced by multer disk storage. */
export interface HostedMultipartFileDescriptor {
  readonly fieldname: string;
  readonly mimetype: string;
  readonly originalname: string;
  readonly path: string;
  readonly size: number;
}

export interface HostedUploadedFile {
  readonly mime: string;
  readonly name: string;
  readonly originalName: string;
  readonly size: number;
}

export interface HostedUploadIntake {
  /** Use as the destination of a request-scoped multer disk storage instance. */
  readonly stagingRoot: string;
  cleanup(): Promise<void>;
  finalize(input: HostedUploadFinalizeInput): Promise<{ readonly files: readonly HostedUploadedFile[] }>;
}

export interface HostedUploadFinalizeInput {
  readonly commitInLane: <T>(commit: () => Promise<T>) => Promise<T>;
  readonly destinationRoot: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly files: readonly HostedMultipartFileDescriptor[];
}

interface ValidatedFile {
  readonly descriptor: HostedMultipartFileDescriptor;
  readonly stagedPath: string;
}

interface PromotedFile {
  readonly stagedPath: string;
  readonly targetPath: string;
}

export async function beginHostedUploadIntake(input: {
  readonly uploadsRoot: string;
}): Promise<HostedUploadIntake> {
  const uploadsRoot = await exactDirectory(input.uploadsRoot);
  const stagingRoot = await mkdtemp(path.join(uploadsRoot, '.intake-'));
  await assertDirectExactDirectory(stagingRoot, uploadsRoot);
  let settled = false;

  async function cleanup(): Promise<void> {
    if (settled) return;
    await removeExactStaging(stagingRoot, uploadsRoot);
    settled = true;
  }

  return Object.freeze({
    stagingRoot,
    cleanup,
    async finalize(finalizeInput: HostedUploadFinalizeInput) {
      if (settled) throw new TypeError('hosted upload intake is already settled');
      const promoted: PromotedFile[] = [];
      const createdDirectories: string[] = [];
      let committed = false;
      try {
        const dir = uploadDirectory(finalizeInput.fields);
        const files = await validateFiles(finalizeInput.files, stagingRoot);
        const destinationRoot = await exactDirectory(finalizeInput.destinationRoot);
        const result = await finalizeInput.commitInLane(async () => {
          if (committed) throw new TypeError('hosted upload commit ran more than once');
          committed = true;
          const destinationState = await ensureExactSubdirectory(
            await exactDirectory(destinationRoot),
            dir,
          );
          createdDirectories.push(...destinationState.created);
          const destination = destinationState.path;
          const uploaded: HostedUploadedFile[] = [];
          for (const file of files) {
            await assertExactStagedFile(file, stagingRoot);
            const originalName = decodeMultipartFilename(file.descriptor.originalname);
            const filename = `${randomUUID()}-${sanitizeName(originalName)}`;
            const relativeName = dir === '' ? filename : `${dir}/${filename}`;
            if (Buffer.byteLength(relativeName, 'utf8') > HOSTED_UPLOAD_LIMITS.dirBytes) {
              throw badRequest('uploaded file path exceeds the hosted bound');
            }
            const targetPath = path.join(destination, filename);
            await exactDirectory(destination);
            await assertMissingDirectChild(targetPath, destination);
            await rename(file.stagedPath, targetPath);
            promoted.push({ stagedPath: file.stagedPath, targetPath });
            await assertDirectExactFile(targetPath, destination, file.descriptor.size);
            uploaded.push(Object.freeze({
              mime: boundedMime(file.descriptor.mimetype),
              name: relativeName,
              originalName,
              size: file.descriptor.size,
            }));
          }
          await rmdir(stagingRoot);
          settled = true;
          return Object.freeze({ files: Object.freeze(uploaded) });
        });
        return result;
      } catch (error) {
        const failures: unknown[] = [error];
        for (const file of promoted.reverse()) {
          try {
            await rm(file.targetPath, { force: true });
          } catch (rollbackError) {
            failures.push(rollbackError);
          }
        }
        for (const directory of createdDirectories.reverse()) {
          try {
            await rmdir(directory);
          } catch (rollbackError) {
            failures.push(rollbackError);
          }
        }
        try {
          if (!settled) await cleanup();
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
        if (failures.length === 1) throw error;
        throw new HostedUploadError(
          'HOSTED_RUNTIME_UNAVAILABLE',
          'hosted upload rollback or cleanup failed',
          new AggregateError(failures),
        );
      }
    },
  });
}

function uploadDirectory(fields: Readonly<Record<string, unknown>>): string {
  if (fields == null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw badRequest('multipart fields are invalid');
  }
  const keys = Object.keys(fields);
  if (keys.some((key) => key !== 'dir')) {
    throw badRequest('multipart request contains unsupported fields');
  }
  const input = fields.dir;
  if (input === undefined || input === '') return '';
  if (typeof input !== 'string') throw badRequest('dir must be a string');
  const bytes = Buffer.from(input, 'utf8');
  if (
    bytes.length < 1
    || bytes.length > HOSTED_UPLOAD_LIMITS.dirBytes
    || bytes.toString('utf8') !== input
    || input.startsWith('/')
    || input.includes('\\')
    || input.includes('\0')
    || /^[A-Za-z]:/u.test(input)
  ) {
    throw badRequest('dir must be a canonical relative path');
  }
  const segments = input.split('/');
  if (segments.some((segment) => !safeSegment(segment))) {
    throw badRequest('dir must be a canonical relative path');
  }
  return input;
}

async function validateFiles(
  input: readonly HostedMultipartFileDescriptor[],
  stagingRoot: string,
): Promise<readonly ValidatedFile[]> {
  if (!Array.isArray(input) || input.length < 1 || input.length > HOSTED_UPLOAD_LIMITS.files) {
    throw badRequest('multipart upload must contain 1 to 12 files');
  }
  const paths = new Set<string>();
  const files: ValidatedFile[] = [];
  let totalBytes = 0;
  for (const descriptor of input) {
    if (
      descriptor == null
      || typeof descriptor !== 'object'
      || descriptor.fieldname !== 'files'
      || typeof descriptor.originalname !== 'string'
      || descriptor.originalname.length < 1
      || descriptor.originalname.includes('\0')
      || Buffer.from(descriptor.originalname, 'utf8').toString('utf8') !== descriptor.originalname
      || !Number.isSafeInteger(descriptor.size)
      || descriptor.size < 0
      || typeof descriptor.path !== 'string'
      || typeof descriptor.mimetype !== 'string'
    ) {
      throw badRequest('multipart file descriptor is invalid');
    }
    if (descriptor.size > HOSTED_UPLOAD_LIMITS.fileBytes) {
      throw payloadTooLarge('uploaded file exceeds 20 MiB');
    }
    totalBytes += descriptor.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > HOSTED_UPLOAD_LIMITS.requestBytes) {
      throw payloadTooLarge('multipart upload exceeds 100 MiB');
    }
    const stagedPath = path.resolve(descriptor.path);
    if (paths.has(canonicalPath(stagedPath))) {
      throw badRequest('multipart upload repeats a staged file');
    }
    paths.add(canonicalPath(stagedPath));
    const file = { descriptor, stagedPath };
    await assertExactStagedFile(file, stagingRoot);
    files.push(file);
  }
  return Object.freeze(files);
}

async function assertExactStagedFile(file: ValidatedFile, stagingRoot: string): Promise<void> {
  await assertDirectExactFile(file.stagedPath, stagingRoot, file.descriptor.size);
}

async function exactDirectory(input: string): Promise<string> {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) {
    throw badRequest('hosted upload root is invalid');
  }
  const expected = path.resolve(input);
  let info;
  let canonical;
  try {
    [info, canonical] = await Promise.all([lstat(expected), realpath(expected)]);
  } catch (error) {
    throw unavailable('hosted upload root is unavailable', error);
  }
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(expected, canonical)) {
    throw badRequest('hosted upload root must be an exact directory');
  }
  return expected;
}

async function assertDirectExactDirectory(candidate: string, parent: string): Promise<void> {
  if (!isDirectChild(parent, candidate)) throw badRequest('upload staging root escapes its owner');
  const exact = await exactDirectory(candidate);
  if (!samePath(exact, candidate)) throw badRequest('upload staging root is invalid');
}

async function assertDirectExactFile(
  candidate: string,
  parent: string,
  expectedSize: number,
): Promise<void> {
  if (!isDirectChild(parent, candidate)) {
    throw badRequest('multipart file escapes its staging or destination root');
  }
  try {
    const [info, canonical] = await Promise.all([lstat(candidate), realpath(candidate)]);
    if (
      !info.isFile()
      || info.isSymbolicLink()
      || info.size !== expectedSize
      || !samePath(candidate, canonical)
    ) {
      throw badRequest('multipart file must be an exact regular file');
    }
  } catch (error) {
    if (error instanceof HostedUploadError) throw error;
    throw unavailable('multipart staged file is unavailable', error);
  }
}

async function ensureExactSubdirectory(
  root: string,
  relative: string,
): Promise<{ readonly created: readonly string[]; readonly path: string }> {
  let current = root;
  const created: string[] = [];
  if (relative === '') return { created, path: current };
  try {
    for (const segment of relative.split('/')) {
      const target = path.join(current, segment);
      try {
        await mkdir(target);
        created.push(target);
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw unavailable('cannot create upload destination', error);
      }
      await assertDirectExactDirectory(target, current);
      current = target;
    }
    return { created, path: current };
  } catch (error) {
    const failures: unknown[] = [error];
    for (const directory of created.reverse()) {
      try {
        await rmdir(directory);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length === 1) throw error;
    throw new HostedUploadError(
      'HOSTED_RUNTIME_UNAVAILABLE',
      'hosted upload destination cleanup failed',
      new AggregateError(failures),
    );
  }
}

async function assertMissingDirectChild(candidate: string, parent: string): Promise<void> {
  if (!isDirectChild(parent, candidate)) throw badRequest('upload destination escapes its root');
  try {
    await lstat(candidate);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    throw unavailable('cannot inspect upload destination', error);
  }
  throw new HostedUploadError('CONFLICT', 'upload destination already exists');
}

async function removeExactStaging(stagingRoot: string, uploadsRoot: string): Promise<void> {
  await assertDirectExactDirectory(stagingRoot, uploadsRoot);
  await rm(stagingRoot, { force: true, recursive: true });
}

function safeSegment(segment: string): boolean {
  return segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && !/[\u0000-\u001f\u007f:]/u.test(segment);
}

function boundedMime(input: string): string {
  const bytes = Buffer.from(input, 'utf8');
  return bytes.length <= 256 && bytes.toString('utf8') === input && !/[\r\n\0]/u.test(input)
    ? input
    : 'application/octet-stream';
}

function isDirectChild(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative.length > 0
    && !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !relative.includes(path.sep);
}

function canonicalPath(input: string): string {
  let value = path.resolve(input).replace(/[\\/]+$/u, '');
  if (process.platform === 'win32') {
    value = value.replace(/^\\\\\?\\UNC\\/iu, '\\\\').replace(/^\\\\\?\\/u, '').toLowerCase();
  }
  return value;
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function badRequest(message: string): HostedUploadError {
  return new HostedUploadError('BAD_REQUEST', message);
}

function payloadTooLarge(message: string): HostedUploadError {
  return new HostedUploadError('PAYLOAD_TOO_LARGE', message);
}

function unavailable(message: string, cause: unknown): HostedUploadError {
  return new HostedUploadError('HOSTED_RUNTIME_UNAVAILABLE', message, cause);
}
