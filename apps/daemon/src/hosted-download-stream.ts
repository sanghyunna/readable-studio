import type { ApiErrorCode } from '@readable-studio/contracts';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, type Writable } from 'node:stream';
import JSZip from 'jszip';

export const HOSTED_DOWNLOAD_LIMITS = Object.freeze({
  bytesGlobal: 16 * 1024 * 1024 * 1024,
  bytesPerUser: 1024 * 1024 * 1024,
  filesPerArchive: 20_000,
  idleTimeoutMs: 30_000,
  streamsGlobal: 32,
  streamsPerUser: 1,
  totalTimeoutMs: 10 * 60_000,
});

export class HostedDownloadError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HostedDownloadError';
    this.code = code;
  }
}

export interface HostedArchiveDownload {
  readonly fileCount: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly sourceBytes: number;
  abort(): void;
  pipeTo(destination: Writable): void;
}

export interface HostedDownloadStreams {
  openFile(input: {
    readonly bytes: number;
    readonly signal?: AbortSignal;
    readonly source: Readable;
    readonly userKey: string;
  }): Readable;
  openArchive(input: {
    readonly archiveName: string;
    readonly relativeRoot?: string;
    readonly rootPath: string;
    readonly signal?: AbortSignal;
    readonly userKey: string;
  }): Promise<HostedArchiveDownload>;
}

interface ArchiveEntry {
  readonly archivePath: string;
  readonly dev: number;
  readonly fullPath: string;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
}

interface Reservation {
  release(): void;
}

export function createHostedDownloadStreams(): HostedDownloadStreams {
  const users = new Map<string, number>();
  let globalBytes = 0;
  let globalStreams = 0;

  function reserve(userKey: string, bytes: number): Reservation {
    if (bytes > HOSTED_DOWNLOAD_LIMITS.bytesPerUser) {
      throw new HostedDownloadError(
        'HOSTED_QUOTA_EXCEEDED',
        'hosted download exceeds the per-user byte limit',
      );
    }
    if (users.has(userKey)) {
      throw new HostedDownloadError(
        'HOSTED_OVERLOADED',
        'a hosted download is already active for this user',
      );
    }
    if (
      globalStreams >= HOSTED_DOWNLOAD_LIMITS.streamsGlobal
      || globalBytes + bytes > HOSTED_DOWNLOAD_LIMITS.bytesGlobal
    ) {
      throw new HostedDownloadError(
        'HOSTED_CAPACITY_EXHAUSTED',
        'hosted download capacity is exhausted',
      );
    }

    users.set(userKey, bytes);
    globalBytes += bytes;
    globalStreams += 1;
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        users.delete(userKey);
        globalBytes -= bytes;
        globalStreams -= 1;
      },
    };
  }

  return {
    openFile(input): Readable {
      validateUserKey(input.userKey);
      if (!Number.isSafeInteger(input.bytes) || input.bytes < 0) {
        input.source.destroy();
        throw new HostedDownloadError('HOSTED_QUOTA_EXCEEDED', 'hosted download size is invalid');
      }
      if (input.signal?.aborted) {
        input.source.destroy();
        throw abortedError();
      }
      try {
        return createBoundedFileStream({
          deadline: Date.now() + HOSTED_DOWNLOAD_LIMITS.totalTimeoutMs,
          reservation: reserve(input.userKey, input.bytes),
          signal: input.signal,
          source: input.source,
        });
      } catch (error) {
        input.source.destroy();
        throw error;
      }
    },
    async openArchive(input): Promise<HostedArchiveDownload> {
      validateUserKey(input.userKey);
      const startedAt = Date.now();
      const deadline = startedAt + HOSTED_DOWNLOAD_LIMITS.totalTimeoutMs;
      if (input.signal?.aborted) throw abortedError();

      const rootPath = await exactRoot(input.rootPath);
      const relativeRoot = safeRelativeRoot(input.relativeRoot ?? '');
      const selectedRoot = path.resolve(rootPath, ...relativeRoot);
      if (!isContained(rootPath, selectedRoot)) {
        throw new HostedDownloadError('BAD_REQUEST', 'archive root escapes its hosted root');
      }
      await assertExactDirectory(selectedRoot, rootPath);

      const entries: ArchiveEntry[] = [];
      const budget = { bytes: 0, visited: 0 };
      await collectEntries(selectedRoot, '', rootPath, entries, budget, deadline, input.signal);
      if (entries.length === 0) {
        throw new HostedDownloadError('FILE_NOT_FOUND', 'archive root contains no files');
      }

      assertWithinDeadline(deadline, input.signal);
      const reservation = reserve(input.userKey, budget.bytes);
      try {
        return createArchiveDownload({
          archiveName: input.archiveName,
          deadline,
          entries,
          reservation,
          rootPath,
          signal: input.signal,
          sourceBytes: budget.bytes,
        });
      } catch (error) {
        reservation.release();
        throw error;
      }
    },
  };
}

function createBoundedFileStream(input: {
  deadline: number;
  reservation: Reservation;
  signal: AbortSignal | undefined;
  source: Readable;
}): Readable {
  let idleTimer: NodeJS.Timeout | undefined;
  let totalTimer: NodeJS.Timeout | undefined;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
    input.signal?.removeEventListener('abort', onAbort);
    input.reservation.release();
  };
  const output = new Transform({
    transform(chunk, _encoding, callback) {
      resetIdle();
      callback(null, chunk);
    },
    destroy(error, callback) {
      if (!input.source.destroyed) input.source.destroy(error ?? undefined);
      release();
      callback(error);
    },
  });
  const stop = (error?: Error) => output.destroy(error);
  const onAbort = () => stop(abortedError());
  function resetIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => stop(new HostedDownloadError('HOSTED_RUNTIME_UNAVAILABLE', 'hosted download became idle')),
      HOSTED_DOWNLOAD_LIMITS.idleTimeoutMs,
    );
    idleTimer.unref();
  }

  input.source.once('error', (error) => stop(asError(error)));
  output.once('end', release);
  output.once('close', release);
  input.source.pipe(output);
  resetIdle();
  totalTimer = setTimeout(
    () => stop(new HostedDownloadError('HOSTED_RUNTIME_UNAVAILABLE', 'hosted download timed out')),
    Math.max(1, input.deadline - Date.now()),
  );
  totalTimer.unref();
  input.signal?.addEventListener('abort', onAbort, { once: true });
  return output;
}

async function exactRoot(input: string): Promise<string> {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) {
    throw new HostedDownloadError('BAD_REQUEST', 'hosted archive root must be an absolute path');
  }
  const resolved = path.resolve(input);
  await assertExactDirectory(resolved, resolved);
  return resolved;
}

function safeRelativeRoot(input: string): string[] {
  if (typeof input !== 'string' || input.includes('\0')) {
    throw new HostedDownloadError('BAD_REQUEST', 'archive root is invalid');
  }
  if (input === '') return [];
  if (/^(?:[\\/]|[A-Za-z]:)/u.test(input)) {
    throw new HostedDownloadError('BAD_REQUEST', 'archive root must be root-relative');
  }
  const segments = input.split(/[\\/]/u);
  if (segments.some((segment) => !safeArchiveSegment(segment))) {
    throw new HostedDownloadError('BAD_REQUEST', 'archive root contains an unsafe segment');
  }
  return segments;
}

async function collectEntries(
  directory: string,
  relativeDirectory: string,
  rootPath: string,
  entries: ArchiveEntry[],
  budget: { bytes: number; visited: number },
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  assertWithinDeadline(deadline, signal);
  let children;
  try {
    children = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw fileError('cannot read archive directory', error);
  }
  children.sort((left, right) => left.name.localeCompare(right.name));

  for (const child of children) {
    assertWithinDeadline(deadline, signal);
    budget.visited += 1;
    if (budget.visited > HOSTED_DOWNLOAD_LIMITS.filesPerArchive) {
      throw new HostedDownloadError(
        'HOSTED_QUOTA_EXCEEDED',
        'hosted archive exceeds the entry limit',
      );
    }
    if (!safeArchiveSegment(child.name)) {
      throw new HostedDownloadError('BAD_REQUEST', 'archive contains an unsafe file name');
    }

    const fullPath = path.join(directory, child.name);
    const archivePath = relativeDirectory
      ? `${relativeDirectory}/${child.name}`
      : child.name;
    const info = await exactInfo(fullPath, rootPath);
    if (info.isDirectory()) {
      await collectEntries(fullPath, archivePath, rootPath, entries, budget, deadline, signal);
      continue;
    }
    if (!info.isFile()) {
      throw new HostedDownloadError('BAD_REQUEST', 'archive contains a non-regular file');
    }
    if (!Number.isSafeInteger(info.size) || info.size < 0) {
      throw new HostedDownloadError('HOSTED_QUOTA_EXCEEDED', 'archive file size is invalid');
    }
    budget.bytes += info.size;
    if (!Number.isSafeInteger(budget.bytes) || budget.bytes > HOSTED_DOWNLOAD_LIMITS.bytesPerUser) {
      throw new HostedDownloadError(
        'HOSTED_QUOTA_EXCEEDED',
        'hosted archive exceeds the per-user byte limit',
      );
    }
    entries.push({
      archivePath,
      dev: info.dev,
      fullPath,
      ino: info.ino,
      mtimeMs: info.mtimeMs,
      size: info.size,
    });
  }
}

async function assertExactDirectory(candidate: string, rootPath: string): Promise<void> {
  const info = await exactInfo(candidate, rootPath);
  if (!info.isDirectory()) {
    throw new HostedDownloadError('BAD_REQUEST', 'archive root is not a directory');
  }
}

async function exactInfo(candidate: string, rootPath: string) {
  if (!isContained(rootPath, candidate)) {
    throw new HostedDownloadError('BAD_REQUEST', 'archive path escapes its hosted root');
  }
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) {
      throw new HostedDownloadError('BAD_REQUEST', 'links are not eligible for hosted archives');
    }
    const canonical = await realpath(candidate);
    if (!samePath(canonical, candidate) || !isContained(rootPath, canonical)) {
      throw new HostedDownloadError(
        'BAD_REQUEST',
        'link or reparse-point paths are not eligible for hosted archives',
      );
    }
    return info;
  } catch (error) {
    if (error instanceof HostedDownloadError) throw error;
    throw fileError('archive path does not exist', error);
  }
}

function createArchiveDownload(input: {
  archiveName: string;
  deadline: number;
  entries: readonly ArchiveEntry[];
  reservation: Reservation;
  rootPath: string;
  signal: AbortSignal | undefined;
  sourceBytes: number;
}): HostedArchiveDownload {
  const zip = new JSZip();
  const sources: Readable[] = [];
  for (const entry of input.entries) {
    const source = exactFileStream(entry, input.rootPath);
    sources.push(source);
    zip.file(entry.archivePath, source, {
      binary: true,
      date: new Date(entry.mtimeMs),
    });
  }

  const generated = zip.generateNodeStream({
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    streamFiles: true,
    type: 'nodebuffer',
  }) as Readable;

  let idleTimer: NodeJS.Timeout | undefined;
  let totalTimer: NodeJS.Timeout | undefined;
  let finished = false;
  let piped = false;
  const output = new Transform({
    transform(chunk, _encoding, callback) {
      resetIdle();
      callback(null, chunk);
    },
  });

  const release = () => {
    if (finished) return;
    finished = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
    input.signal?.removeEventListener('abort', onAbort);
    input.reservation.release();
  };
  const stop = (error?: Error) => {
    for (const source of sources) {
      if (!source.destroyed) source.destroy();
    }
    if (!generated.destroyed) generated.destroy(error);
    if (!output.destroyed) output.destroy(error);
    release();
  };
  const onAbort = () => stop(abortedError());
  function resetIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => stop(new HostedDownloadError('HOSTED_RUNTIME_UNAVAILABLE', 'hosted archive download became idle')),
      HOSTED_DOWNLOAD_LIMITS.idleTimeoutMs,
    );
    idleTimer.unref();
  }

  generated.once('error', (error) => stop(asError(error)));
  output.once('end', release);
  output.once('close', release);
  output.once('error', release);
  generated.pipe(output);
  resetIdle();
  const totalRemaining = Math.max(1, input.deadline - Date.now());
  totalTimer = setTimeout(
    () => stop(new HostedDownloadError('HOSTED_RUNTIME_UNAVAILABLE', 'hosted archive download timed out')),
    totalRemaining,
  );
  totalTimer.unref();
  input.signal?.addEventListener('abort', onAbort, { once: true });

  const headers = Object.freeze({
    'Cache-Control': 'no-store',
    'Content-Disposition': contentDisposition(input.archiveName),
    'Content-Type': 'application/zip',
    'X-Content-Type-Options': 'nosniff',
  });

  return Object.freeze({
    fileCount: input.entries.length,
    headers,
    sourceBytes: input.sourceBytes,
    abort() {
      stop();
    },
    pipeTo(destination: Writable) {
      if (piped) throw new TypeError('hosted archive download can only be piped once');
      piped = true;
      const close = () => stop();
      destination.once('close', close);
      destination.once('error', close);
      output.once('error', (error) => destination.destroy(asError(error)));
      output.pipe(destination);
    },
  });
}

function exactFileStream(entry: ArchiveEntry, rootPath: string): Readable {
  return Readable.from((async function* readExactFile() {
    let handle;
    try {
      const before = await exactInfo(entry.fullPath, rootPath);
      if (!sameFile(before, entry)) throw changedFileError();
      handle = await open(entry.fullPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const opened = await handle.stat();
      const after = await exactInfo(entry.fullPath, rootPath);
      if (!opened.isFile() || !sameFile(opened, entry) || !sameFile(after, entry)) {
        throw changedFileError();
      }
      if (entry.size === 0) return;

      let bytes = 0;
      const stream = handle.createReadStream({ autoClose: false, end: entry.size - 1, start: 0 });
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > entry.size) throw changedFileError();
        yield chunk;
      }
      if (bytes !== entry.size) throw changedFileError();
    } catch (error) {
      if (error instanceof HostedDownloadError) throw error;
      throw fileError('cannot read hosted archive file', error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  })());
}

function sameFile(
  info: { dev: number; ino: number; isFile(): boolean; mtimeMs: number; size: number },
  entry: ArchiveEntry,
): boolean {
  return info.isFile()
    && info.dev === entry.dev
    && info.ino === entry.ino
    && info.mtimeMs === entry.mtimeMs
    && info.size === entry.size;
}

function changedFileError(): HostedDownloadError {
  return new HostedDownloadError('HOSTED_RUNTIME_UNAVAILABLE', 'archive file changed during download');
}

function assertWithinDeadline(deadline: number, signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedError();
  if (Date.now() >= deadline) {
    throw new HostedDownloadError('HOSTED_RUNTIME_UNAVAILABLE', 'hosted archive download timed out');
  }
}

function validateUserKey(userKey: string): void {
  const encoded = typeof userKey === 'string' ? Buffer.from(userKey, 'utf8') : null;
  if (
    encoded == null
    || encoded.length < 1
    || encoded.length > 1_024
    || encoded.toString('utf8') !== userKey
  ) {
    throw new TypeError('hosted archive identity is invalid');
  }
}

function safeArchiveSegment(segment: string): boolean {
  return segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && !/[\\/:\u0000-\u001f\u007f]/u.test(segment);
}

function isContained(rootPath: string, candidate: string): boolean {
  const relative = path.relative(rootPath, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    let normalized = path.resolve(value);
    if (process.platform === 'win32') {
      normalized = normalized
        .replace(/^\\\\\?\\UNC\\/iu, '\\\\')
        .replace(/^\\\\\?\\/u, '')
        .toLowerCase();
    }
    return normalized.replace(/[\\/]+$/u, '');
  };
  return normalize(left) === normalize(right);
}

function contentDisposition(input: string): string {
  const requested = typeof input === 'string' ? path.basename(input) : '';
  const base = requested.replace(/\.zip$/iu, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, '_')
    .replace(/\s+/gu, '-')
    .replace(/^[.-]+|[.-]+$/gu, '')
    .slice(0, 80) || 'download';
  const filename = `${base}.zip`;
  const fallback = filename.replace(/[^\x20-\x7e]/gu, '_').replace(/"/gu, '_');
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function fileError(message: string, cause: unknown): HostedDownloadError {
  const code = isMissing(cause) ? 'FILE_NOT_FOUND' : 'HOSTED_RUNTIME_UNAVAILABLE';
  return new HostedDownloadError(code, message, cause);
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function abortedError(): HostedDownloadError {
  return new HostedDownloadError('HOSTED_RUNTIME_UNAVAILABLE', 'hosted archive download was aborted');
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
