import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  lintArtifact,
  renderFindingsForAgent,
  type LintFinding,
} from './lint-artifact.js';

export const HOSTED_ARTIFACT_LIMITS = Object.freeze({
  aggregateBytesPerUser: 256 * 1024 * 1024,
  artifactsPerUser: 4_096,
  htmlBytes: 3 * 1024 * 1024,
  outputBytes: 100 * 1024 * 1024,
});

const ARTIFACT_ID_PATTERN = /^oda_[A-Za-z0-9_-]{43}$/u;
const MAX_LABEL_BYTES = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export class HostedArtifactAdapterError extends Error {
  readonly code: 'BAD_REQUEST' | 'HOSTED_QUOTA_EXCEEDED' | 'INTERNAL_ERROR' | 'NOT_FOUND';

  constructor(code: HostedArtifactAdapterError['code'], message: string) {
    super(message);
    this.name = 'HostedArtifactAdapterError';
    this.code = code;
  }
}

export interface HostedArtifactSaveResponse {
  readonly artifactId: string;
  readonly url: string;
  readonly lint: readonly LintFinding[];
}

export interface HostedArtifactLintResponse {
  readonly findings: readonly LintFinding[];
  readonly agentMessage: string;
}

export interface HostedArtifactDownload {
  readonly artifactId: string;
  readonly contentType: 'text/html; charset=utf-8';
  readonly fileName: 'artifact.html';
  readonly size: number;
  readonly stream: fs.ReadStream;
}

export interface HostedArtifactAdapter {
  save(request: unknown): HostedArtifactSaveResponse;
  lint(request: unknown): HostedArtifactLintResponse;
  openDownload(artifactId: string): HostedArtifactDownload;
  dispose(): void;
}

type StoredArtifact = {
  readonly directory: string;
  readonly file: string;
  readonly identity: FileIdentity;
};

type FileIdentity = {
  readonly birthtimeMs: number;
  readonly ctimeMs: number;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
};

interface AdmissionLimits {
  readonly aggregateBytesPerUser: number;
  readonly artifactsPerUser: number;
}

export function createHostedArtifactAdapter(options: {
  /** Server-owned test seam; callers may only reduce the fixed production bounds. */
  readonly admissionLimits?: Partial<AdmissionLimits>;
  readonly artifactsRoot: string;
}): HostedArtifactAdapter {
  const admissionLimits = validateAdmissionLimits(options.admissionLimits);
  const artifactsRoot = exactDirectory(options.artifactsRoot);
  const loaded = loadStoredArtifacts(artifactsRoot, admissionLimits);
  const artifacts = loaded.artifacts;
  let aggregateBytes = loaded.aggregateBytes;
  let disposed = false;

  const save = (request: unknown): HostedArtifactSaveResponse => {
    requireOpen();
    const html = saveHtml(request);
    const htmlBytes = Buffer.byteLength(html, 'utf8');
    const lint = lintArtifact(html);
    const currentRoot = exactDirectory(artifactsRoot);
    if (
      artifacts.size >= admissionLimits.artifactsPerUser
      || aggregateBytes + htmlBytes > admissionLimits.aggregateBytesPerUser
    ) {
      throw new HostedArtifactAdapterError(
        'HOSTED_QUOTA_EXCEEDED',
        'hosted artifact storage quota is exceeded',
      );
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const artifactId = `oda_${randomBytes(32).toString('base64url')}`;
      if (artifacts.has(artifactId)) continue;
      const directory = path.join(currentRoot, artifactId);
      try {
        fs.mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw internalError('hosted artifact directory could not be created');
      }

      try {
        const exactArtifactRoot = exactDirectory(directory, currentRoot);
        const file = path.join(exactArtifactRoot, 'index.html');
        fs.writeFileSync(file, html, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        const info = exactRegularFile(file, exactArtifactRoot);
        if (info.size !== htmlBytes || info.size > HOSTED_ARTIFACT_LIMITS.outputBytes) {
          throw internalError('hosted artifact output is invalid');
        }
        artifacts.set(artifactId, {
          directory: exactArtifactRoot,
          file,
          identity: fileIdentity(info),
        });
        aggregateBytes += info.size;
        return Object.freeze({
          artifactId,
          url: `/api/artifacts/${artifactId}/download`,
          lint: Object.freeze(lint),
        });
      } catch (error) {
        try {
          removeExactArtifactDirectory(directory, currentRoot);
        } catch {
          throw internalError('hosted artifact cleanup failed');
        }
        if (error instanceof HostedArtifactAdapterError) throw error;
        throw internalError('hosted artifact could not be saved');
      }
    }
    throw internalError('hosted artifact identifier could not be allocated');
  };

  const lint = (request: unknown): HostedArtifactLintResponse => {
    requireOpen();
    const html = lintHtml(request);
    const findings = lintArtifact(html);
    return Object.freeze({
      findings: Object.freeze(findings),
      agentMessage: renderFindingsForAgent(findings),
    });
  };

  const openDownload = (artifactId: string): HostedArtifactDownload => {
    requireOpen();
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) throw notFound();
    const artifact = artifacts.get(artifactId);
    if (!artifact) throw notFound();

    let descriptor: number | null = null;
    try {
      const currentRoot = exactDirectory(artifactsRoot);
      const directory = exactDirectory(artifact.directory, currentRoot);
      const before = exactRegularFile(artifact.file, directory);
      if (before.size > HOSTED_ARTIFACT_LIMITS.outputBytes) {
        throw new HostedArtifactAdapterError(
          'HOSTED_QUOTA_EXCEEDED',
          'hosted artifact output exceeds its byte limit',
        );
      }
      if (!sameIdentity(artifact.identity, before)) throw notFound();

      const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
      descriptor = fs.openSync(artifact.file, fs.constants.O_RDONLY | noFollow);
      const opened = fs.fstatSync(descriptor);
      const after = exactRegularFile(artifact.file, directory);
      if (
        !opened.isFile()
        || opened.isSymbolicLink()
        || !sameIdentity(artifact.identity, opened)
        || !sameIdentity(artifact.identity, after)
      ) throw notFound();

      const stream = fs.createReadStream('', {
        autoClose: true,
        fd: descriptor,
      });
      descriptor = null;
      return Object.freeze({
        artifactId,
        contentType: 'text/html; charset=utf-8' as const,
        fileName: 'artifact.html' as const,
        size: opened.size,
        stream,
      });
    } catch (error) {
      if (descriptor != null) fs.closeSync(descriptor);
      if (
        error instanceof HostedArtifactAdapterError
        && error.code === 'HOSTED_QUOTA_EXCEEDED'
      ) throw error;
      throw notFound();
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    artifacts.clear();
    aggregateBytes = 0;
  };

  const requireOpen = (): void => {
    if (disposed) throw internalError('hosted artifact adapter is closed');
  };

  return { save, lint, openDownload, dispose };
}

function saveHtml(request: unknown): string {
  const value = record(request);
  exactKeys(value, ['html'], ['identifier', 'title']);
  optionalLabel(value.identifier);
  optionalLabel(value.title);
  return html(value.html);
}

function lintHtml(request: unknown): string {
  const value = record(request);
  exactKeys(value, ['html'], []);
  return html(value.html);
}

function record(request: unknown): Record<string, unknown> {
  if (request == null || typeof request !== 'object' || Array.isArray(request)) {
    throw badRequest('hosted artifact request must be an object');
  }
  return request as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))
  ) throw badRequest('hosted artifact request contains unsupported fields');
}

function optionalLabel(value: unknown): void {
  if (value === undefined) return;
  if (
    typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') > MAX_LABEL_BYTES
    || CONTROL_CHARACTERS.test(value)
  ) throw badRequest('hosted artifact label is invalid');
}

function html(value: unknown): string {
  if (typeof value !== 'string') throw badRequest('hosted artifact HTML must be a string');
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length < 1 || bytes.toString('utf8') !== value) {
    throw badRequest('hosted artifact HTML must be valid non-empty UTF-8');
  }
  if (bytes.length > HOSTED_ARTIFACT_LIMITS.htmlBytes) {
    throw new HostedArtifactAdapterError(
      'HOSTED_QUOTA_EXCEEDED',
      'hosted artifact HTML exceeds its byte limit',
    );
  }
  return value;
}

function exactDirectory(input: string, parent?: string): string {
  try {
    if (!path.isAbsolute(input)) throw new Error('not absolute');
    const expected = path.resolve(input);
    const info = fs.lstatSync(expected);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('not a real directory');
    const resolved = fs.realpathSync(expected);
    if (!samePath(expected, resolved)) throw new Error('directory is a reparse point');
    if (parent != null && !directChild(parent, resolved)) throw new Error('directory escaped root');
    return resolved;
  } catch {
    throw internalError('hosted artifact root is invalid');
  }
}

function exactRegularFile(input: string, parent: string): fs.Stats {
  const expected = path.resolve(input);
  const info = fs.lstatSync(expected);
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || !samePath(fs.realpathSync(expected), expected)
    || !directChild(parent, expected)
  ) throw new Error('hosted artifact is not an exact regular file');
  return info;
}

function loadStoredArtifacts(
  artifactsRoot: string,
  limits: AdmissionLimits,
): { artifacts: Map<string, StoredArtifact>; aggregateBytes: number } {
  const artifacts = new Map<string, StoredArtifact>();
  let aggregateBytes = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(artifactsRoot, { withFileTypes: true });
  } catch {
    throw internalError('hosted artifact root could not be read');
  }

  for (const entry of entries) {
    if (!ARTIFACT_ID_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw internalError('hosted artifact root contains an invalid entry');
    }
    const directory = exactDirectory(path.join(artifactsRoot, entry.name), artifactsRoot);
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      throw internalError('hosted artifact directory could not be read');
    }
    if (
      children.length !== 1
      || children[0]?.name !== 'index.html'
      || !children[0].isFile()
      || children[0].isSymbolicLink()
    ) {
      removeExactArtifactDirectory(directory, artifactsRoot);
      continue;
    }

    const file = path.join(directory, 'index.html');
    const info = exactRegularFile(file, directory);
    if (info.size > HOSTED_ARTIFACT_LIMITS.outputBytes) {
      throw new HostedArtifactAdapterError(
        'HOSTED_QUOTA_EXCEEDED',
        'hosted artifact output exceeds its byte limit',
      );
    }
    aggregateBytes += info.size;
    if (
      artifacts.size >= limits.artifactsPerUser
      || !Number.isSafeInteger(aggregateBytes)
      || aggregateBytes > limits.aggregateBytesPerUser
    ) {
      throw new HostedArtifactAdapterError(
        'HOSTED_QUOTA_EXCEEDED',
        'hosted artifact storage quota is exceeded',
      );
    }
    artifacts.set(entry.name, {
      directory,
      file,
      identity: fileIdentity(info),
    });
  }
  return { artifacts, aggregateBytes };
}

function validateAdmissionLimits(overrides: Partial<AdmissionLimits> | undefined): AdmissionLimits {
  const limits = { ...HOSTED_ARTIFACT_LIMITS, ...overrides };
  for (const key of ['aggregateBytesPerUser', 'artifactsPerUser'] as const) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > HOSTED_ARTIFACT_LIMITS[key]) {
      throw new TypeError(`hosted artifact ${key} limit is invalid`);
    }
  }
  return limits;
}

function directChild(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative.length > 0
    && !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !relative.includes(path.sep);
}

function samePath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

function fileIdentity(info: fs.Stats): FileIdentity {
  return {
    birthtimeMs: info.birthtimeMs,
    ctimeMs: info.ctimeMs,
    dev: info.dev,
    ino: info.ino,
    mtimeMs: info.mtimeMs,
    size: info.size,
  };
}

function sameIdentity(expected: FileIdentity, actual: fs.Stats): boolean {
  return expected.birthtimeMs === actual.birthtimeMs
    && expected.ctimeMs === actual.ctimeMs
    && expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.mtimeMs === actual.mtimeMs
    && expected.size === actual.size;
}

function removeExactArtifactDirectory(directory: string, root: string): void {
  const exact = exactDirectory(directory, root);
  fs.rmSync(exact, { recursive: true, force: true });
  if (fs.existsSync(directory)) throw internalError('hosted artifact directory could not be removed');
}

function badRequest(message: string): HostedArtifactAdapterError {
  return new HostedArtifactAdapterError('BAD_REQUEST', message);
}

function internalError(message: string): HostedArtifactAdapterError {
  return new HostedArtifactAdapterError('INTERNAL_ERROR', message);
}

function notFound(): HostedArtifactAdapterError {
  return new HostedArtifactAdapterError('NOT_FOUND', 'hosted artifact is not available');
}
