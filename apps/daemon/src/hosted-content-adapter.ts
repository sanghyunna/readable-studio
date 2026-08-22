import type { ArtifactKind, ProjectFileKind } from '@readable-studio/contracts';
import { isSafeId } from './projects.js';

const MAX_RELATIVE_PATH_BYTES = 1_024;
const MAX_FILE_WRITE_BYTES = 3 * 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_WORKSPACE_ENTRIES = 10_000;
const MAX_QUERY_BYTES = 4_096;
const MAX_PATTERN_BYTES = 512;
const MAX_SEARCH_MATCHES = 1_000;
const MAX_SEARCH_SNIPPET_BYTES = 4_096;
const FILE_KINDS = new Set([
  'html', 'image', 'video', 'audio', 'sketch', 'text', 'code', 'pdf',
  'document', 'presentation', 'spreadsheet', 'binary',
]);
const ARTIFACT_KINDS = new Set<ArtifactKind>([
  'html', 'deck', 'react-component', 'markdown-document', 'svg', 'diagram',
  'code-snippet', 'mini-app', 'design-system',
]);

export interface HostedContentAuthority {
  readonly userKey: string;
  readonly generation: number;
}

export type HostedContentReadOperation =
  | { readonly kind: 'files.list'; readonly projectId: string; readonly since?: number }
  | { readonly kind: 'file.read'; readonly projectId: string; readonly path: string }
  | {
      readonly kind: 'files.search';
      readonly projectId: string;
      readonly q: string;
      readonly pattern?: string;
      readonly max: number;
    }
  | { readonly kind: 'folders.list'; readonly projectId: string };

export type HostedContentMutationOperation =
  | {
      readonly kind: 'file.write';
      readonly projectId: string;
      readonly body: {
        readonly name: string;
        readonly content: Buffer;
        readonly encoding: 'utf8' | 'base64';
        readonly overwrite: boolean;
        readonly expectedContentSha256?: string;
      };
    }
  | {
      readonly kind: 'file.rename';
      readonly projectId: string;
      readonly body: { readonly from: string; readonly to: string };
    }
  | { readonly kind: 'file.delete'; readonly projectId: string; readonly path: string }
  | {
      readonly kind: 'folder.create' | 'folder.delete';
      readonly projectId: string;
      readonly body: { readonly path: string };
    };

export type HostedContentOperation = HostedContentReadOperation | HostedContentMutationOperation;

export interface HostedContentSemanticDispatcher {
  read(authority: HostedContentAuthority, operation: HostedContentReadOperation): Promise<unknown>;
  mutateInLane(
    authority: HostedContentAuthority,
    operation: HostedContentMutationOperation,
  ): Promise<unknown>;
}

export interface HostedContentFile {
  readonly name: string;
  readonly path: string;
  readonly type: 'file';
  readonly size: number;
  readonly mtime: number;
  readonly kind: ProjectFileKind;
  readonly mime: string;
  readonly artifactKind?: ArtifactKind;
}

export interface HostedContentFolder {
  readonly name: string;
  readonly path: string;
  readonly type: 'dir';
  readonly size: 0;
  readonly mtime: number;
}

export interface HostedContentSearchMatch {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

export type HostedContentResponse =
  | { readonly files: readonly HostedContentFile[] }
  | { readonly file: HostedContentFile; readonly content?: Buffer }
  | { readonly folders: readonly HostedContentFolder[] }
  | { readonly folder: HostedContentFolder }
  | { readonly query: string; readonly matches: readonly HostedContentSearchMatch[] }
  | {
      readonly file: HostedContentFile;
      readonly oldName: string;
      readonly newName: string;
    }
  | { readonly ok: true };

export class HostedContentAdapterError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'HOSTED_QUOTA_EXCEEDED' | 'INTERNAL_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'HostedContentAdapterError';
  }
}

export function createHostedContentAdapter(dispatcher: HostedContentSemanticDispatcher): {
  dispatch(
    authority: HostedContentAuthority,
    request: unknown,
  ): Promise<HostedContentResponse>;
} {
  return {
    async dispatch(authority, request) {
      const scopedAuthority = validateAuthority(authority);
      const operation = validateRequest(request);
      const result = isMutation(operation)
        ? await dispatcher.mutateInLane(scopedAuthority, operation)
        : await dispatcher.read(scopedAuthority, operation);
      return sanitizeResponse(operation, result);
    },
  };
}

function validateAuthority(authority: HostedContentAuthority): HostedContentAuthority {
  if (typeof authority?.userKey !== 'string') throw badRequest('hosted content authority is invalid');
  const bytes = Buffer.from(authority.userKey, 'utf8');
  if (
    bytes.length < 1
    || bytes.length > 1_024
    || bytes.toString('utf8') !== authority.userKey
    || /[\u0000-\u001f\u007f]/u.test(authority.userKey)
    || !Number.isSafeInteger(authority.generation)
    || authority.generation < 1
  ) throw badRequest('hosted content authority is invalid');
  return Object.freeze({ userKey: authority.userKey, generation: authority.generation });
}

function validateRequest(request: unknown): HostedContentOperation {
  const value = record(request, 'hosted content request');
  if (value.kind === 'file.read' || value.kind === 'file.delete') {
    exactKeys(value, ['kind', 'projectId', 'path']);
    return {
      kind: value.kind,
      projectId: opaqueId(value.projectId, 'projectId'),
      path: relativePath(value.path, 'path'),
    };
  }
  if (value.kind === 'files.list') {
    optionalKeys(value, ['kind', 'projectId'], ['since']);
    const since = optionalInteger(value.since, 'since', 0, Number.MAX_SAFE_INTEGER);
    return {
      kind: value.kind,
      projectId: opaqueId(value.projectId, 'projectId'),
      ...(since === undefined ? {} : { since }),
    };
  }
  if (value.kind === 'files.search') {
    optionalKeys(value, ['kind', 'projectId', 'q'], ['pattern', 'max']);
    const pattern = optionalBoundedString(value.pattern, 'pattern', 0, MAX_PATTERN_BYTES);
    const max = optionalInteger(value.max, 'max', 1, MAX_SEARCH_MATCHES) ?? 200;
    return {
      kind: value.kind,
      projectId: opaqueId(value.projectId, 'projectId'),
      q: boundedString(value.q, 'q', 1, MAX_QUERY_BYTES),
      ...(pattern === undefined ? {} : { pattern }),
      max,
    };
  }
  if (value.kind === 'folders.list') {
    exactKeys(value, ['kind', 'projectId']);
    return { kind: value.kind, projectId: opaqueId(value.projectId, 'projectId') };
  }
  if (value.kind === 'file.write') {
    exactKeys(value, ['kind', 'projectId', 'body']);
    const body = record(value.body, 'file write body');
    optionalKeys(body, ['name', 'content'], ['encoding', 'overwrite', 'expectedContentSha256']);
    const encoding = body.encoding === undefined ? 'utf8' : body.encoding;
    if (encoding !== 'utf8' && encoding !== 'base64') throw badRequest('encoding is invalid');
    const content = decodeContent(body.content, encoding);
    if (content.length > MAX_FILE_WRITE_BYTES) {
      throw new HostedContentAdapterError(
        'HOSTED_QUOTA_EXCEEDED',
        'file content exceeds its hosted bound',
      );
    }
    if (body.overwrite !== undefined && typeof body.overwrite !== 'boolean') {
      throw badRequest('overwrite must be a boolean');
    }
    const expectedContentSha256 = body.expectedContentSha256;
    if (expectedContentSha256 !== undefined
      && (typeof expectedContentSha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(expectedContentSha256))) {
      throw badRequest('expectedContentSha256 is invalid');
    }
    return {
      kind: value.kind,
      projectId: opaqueId(value.projectId, 'projectId'),
      body: {
        name: relativePath(body.name, 'name'),
        content,
        encoding,
        overwrite: body.overwrite ?? true,
        ...(expectedContentSha256 === undefined
          ? {}
          : { expectedContentSha256: expectedContentSha256.toLowerCase() }),
      },
    };
  }
  if (value.kind === 'file.rename') {
    exactKeys(value, ['kind', 'projectId', 'body']);
    const body = record(value.body, 'file rename body');
    exactKeys(body, ['from', 'to']);
    return {
      kind: value.kind,
      projectId: opaqueId(value.projectId, 'projectId'),
      body: { from: relativePath(body.from, 'from'), to: relativePath(body.to, 'to') },
    };
  }
  if (value.kind === 'folder.create' || value.kind === 'folder.delete') {
    exactKeys(value, ['kind', 'projectId', 'body']);
    const body = record(value.body, 'folder body');
    exactKeys(body, ['path']);
    return {
      kind: value.kind,
      projectId: opaqueId(value.projectId, 'projectId'),
      body: { path: relativePath(body.path, 'path') },
    };
  }
  throw badRequest('hosted content operation is not enabled');
}

function sanitizeResponse(
  operation: HostedContentOperation,
  input: unknown,
): HostedContentResponse {
  try {
    if (operation.kind === 'file.delete' || operation.kind === 'folder.delete') {
      if (record(input, 'file delete response').ok !== true) throw badRequest('invalid response');
      return { ok: true };
    }
    if (operation.kind === 'file.read') {
      const value = record(input, 'file read response');
      if (!Buffer.isBuffer(value.buffer)) throw badRequest('invalid response');
      const file = responseFile(value);
      if (value.buffer.length !== file.size) throw badRequest('invalid response');
      return { file, content: Buffer.from(value.buffer) };
    }
    if (operation.kind === 'files.list') {
      const values = responseArray(input, MAX_WORKSPACE_ENTRIES);
      return { files: values.map((value) => responseFile(record(value, 'file response'))) };
    }
    if (operation.kind === 'files.search') {
      const values = responseArray(input, operation.max);
      return {
        query: operation.q,
        matches: values.map((value) => responseSearchMatch(record(value, 'search response'))),
      };
    }
    if (operation.kind === 'folders.list') {
      const values = responseArray(input, MAX_WORKSPACE_ENTRIES);
      return { folders: values.map((value) => responseFolder(record(value, 'folder response'))) };
    }
    if (operation.kind === 'file.write') {
      return { file: responseFile(record(record(input, 'file write response').file, 'file response')) };
    }
    if (operation.kind === 'file.rename') {
      const value = record(input, 'file rename response');
      const oldName = responseRelativePath(value.oldName, 'oldName');
      const newName = responseRelativePath(value.newName, 'newName');
      if (oldName !== operation.body.from || newName !== operation.body.to) throw badRequest('invalid response');
      return {
        file: responseFile(record(value.file, 'file response')),
        oldName,
        newName,
      };
    }
    if (operation.kind === 'folder.create') {
      return { folder: responseFolder(record(record(input, 'folder response').folder, 'folder')) };
    }
    throw badRequest('invalid response');
  } catch (error) {
    if (error instanceof HostedContentAdapterError) {
      throw internalError('hosted content semantic response is invalid');
    }
    throw error;
  }
}

function responseFile(value: Record<string, unknown>): HostedContentFile {
  const name = responseRelativePath(value.name, 'file name');
  const filePath = responseRelativePath(value.path ?? value.name, 'file path');
  if (name !== filePath || (value.type !== undefined && value.type !== 'file')) {
    throw badRequest('invalid response');
  }
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0 || (value.size as number) > MAX_FILE_BYTES) {
    throw badRequest('invalid response');
  }
  if (typeof value.mtime !== 'number' || !Number.isFinite(value.mtime) || value.mtime < 0) {
    throw badRequest('invalid response');
  }
  if (!FILE_KINDS.has(String(value.kind))
    || typeof value.mime !== 'string'
    || Buffer.byteLength(value.mime, 'utf8') > 256
    || /[\u0000-\u001f\u007f]/u.test(value.mime)) throw badRequest('invalid response');
  const artifactKind = value.artifactKind;
  if (artifactKind !== undefined && !ARTIFACT_KINDS.has(artifactKind as ArtifactKind)) {
    throw badRequest('invalid response');
  }
  return {
    name,
    path: filePath,
    type: 'file',
    size: value.size as number,
    mtime: value.mtime,
    kind: value.kind as ProjectFileKind,
    mime: value.mime,
    ...(artifactKind === undefined ? {} : { artifactKind: artifactKind as ArtifactKind }),
  };
}

function responseFolder(value: Record<string, unknown>): HostedContentFolder {
  const name = responseRelativePath(value.name, 'folder name');
  const folderPath = responseRelativePath(value.path, 'folder path');
  if (name !== folderPath || value.type !== 'dir' || value.size !== 0) throw badRequest('invalid response');
  if (typeof value.mtime !== 'number' || !Number.isFinite(value.mtime) || value.mtime < 0) {
    throw badRequest('invalid response');
  }
  return { name, path: folderPath, type: 'dir', size: 0, mtime: value.mtime };
}

function responseSearchMatch(value: Record<string, unknown>): HostedContentSearchMatch {
  const file = responseRelativePath(value.file, 'search file');
  if (!Number.isSafeInteger(value.line) || (value.line as number) < 1) throw badRequest('invalid response');
  if (typeof value.snippet !== 'string'
    || Buffer.byteLength(value.snippet, 'utf8') > MAX_SEARCH_SNIPPET_BYTES
    || Buffer.from(value.snippet, 'utf8').toString('utf8') !== value.snippet) throw badRequest('invalid response');
  return { file, line: value.line as number, snippet: value.snippet };
}

function isMutation(operation: HostedContentOperation): operation is HostedContentMutationOperation {
  return ['file.write', 'file.rename', 'file.delete', 'folder.create', 'folder.delete']
    .includes(operation.kind);
}

function record(input: unknown, name: string): Record<string, unknown> {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest(`${name} must be an object`);
  }
  return input as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  optionalKeys(value, keys, []);
}

function optionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))) {
    throw badRequest('hosted content request contains unsupported fields');
  }
}

function optionalInteger(
  input: unknown,
  name: string,
  min: number,
  max: number,
): number | undefined {
  if (input === undefined) return undefined;
  if (!Number.isSafeInteger(input) || (input as number) < min || (input as number) > max) {
    throw badRequest(`${name} is outside its hosted bound`);
  }
  return input as number;
}

function boundedString(input: unknown, name: string, min: number, max: number): string {
  if (typeof input !== 'string') throw badRequest(`${name} must be a string`);
  const bytes = Buffer.from(input, 'utf8');
  if (bytes.length < min || bytes.length > max || bytes.toString('utf8') !== input || input.includes('\0')) {
    throw badRequest(`${name} is outside its hosted bound`);
  }
  return input;
}

function optionalBoundedString(
  input: unknown,
  name: string,
  min: number,
  max: number,
): string | undefined {
  return input === undefined ? undefined : boundedString(input, name, min, max);
}

function decodeContent(input: unknown, encoding: 'utf8' | 'base64'): Buffer {
  if (typeof input !== 'string') throw badRequest('content must be a string');
  if (encoding === 'utf8') {
    const content = Buffer.from(input, 'utf8');
    if (content.toString('utf8') !== input) throw badRequest('content must be valid UTF-8');
    return content;
  }
  if (input.length % 4 !== 0 || (input !== '' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(input))) {
    throw badRequest('content must be canonical base64');
  }
  const content = Buffer.from(input, 'base64');
  if (content.toString('base64') !== input) throw badRequest('content must be canonical base64');
  return content;
}

function responseArray(input: unknown, max: number): unknown[] {
  if (!Array.isArray(input) || input.length > max) throw badRequest('invalid response');
  return input;
}

function opaqueId(input: unknown, name: string): string {
  if (!isSafeId(input)) throw badRequest(`${name} is invalid`);
  return input as string;
}

function relativePath(input: unknown, name: string): string {
  if (typeof input !== 'string') throw badRequest(`${name} must be a canonical relative path`);
  const bytes = Buffer.from(input, 'utf8');
  if (
    bytes.length < 1
    || bytes.length > MAX_RELATIVE_PATH_BYTES
    || bytes.toString('utf8') !== input
    || input.startsWith('/')
    || input.includes('\\')
    || /^[A-Za-z]:/u.test(input)
    || /%(?:00|2e|2f|5c|25(?:00|2e|2f|5c))/iu.test(input)
    || /[\u0000-\u001f\u007f]/u.test(input)
    || input.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) throw badRequest(`${name} must be a canonical relative path`);
  return input;
}

function responseRelativePath(input: unknown, name: string): string {
  try {
    return relativePath(input, name);
  } catch {
    throw badRequest('invalid response');
  }
}

function badRequest(message: string): HostedContentAdapterError {
  return new HostedContentAdapterError('BAD_REQUEST', message);
}

function internalError(message: string): HostedContentAdapterError {
  return new HostedContentAdapterError('INTERNAL_ERROR', message);
}
