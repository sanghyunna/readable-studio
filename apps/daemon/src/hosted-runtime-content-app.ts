import fs from 'node:fs';
import path from 'node:path';

import type { HostedArtifactAdapter } from './hosted-artifact-adapter.js';
import {
  createHostedContentAdapter,
  type HostedContentMutationOperation,
  type HostedContentReadOperation,
} from './hosted-content-adapter.js';
import {
  type HostedContentQuota,
  type HostedContentQuotaOperation,
} from './hosted-content-quota.js';
import type { HostedDownloadStreams } from './hosted-download-stream.js';
import {
  beginHostedUploadIntake,
  type HostedMultipartFileDescriptor,
  type HostedUploadedFile,
} from './hosted-upload-adapter.js';
import { buildProjectExportManifestResponse } from './project-export-manifest.js';
import {
  createProjectFolder,
  deleteProjectFile,
  deleteProjectFolder,
  listFiles,
  listProjectFolders,
  readProjectFile,
  renameProjectFile,
  searchProjectFiles,
  writeProjectFile,
  ProjectFileContentConflictError,
} from './projects.js';
import { HostedRuntimeError } from './hosted-runtime-error.js';

export type HostedRuntimeContentOperation =
  | { readonly kind: 'content:dispatch'; readonly request: unknown }
  | {
      readonly kind: 'archive:open';
      readonly projectId: string;
      readonly relativeRoot?: string;
      readonly signal?: AbortSignal;
    }
  | { readonly kind: 'upload:begin'; readonly projectId: string }
  | { readonly kind: 'export:manifest'; readonly projectId: string }
  | { readonly kind: 'artifact:save'; readonly request: unknown }
  | { readonly kind: 'artifact:lint'; readonly request: unknown }
  | {
      readonly kind: 'artifact:download';
      readonly artifactId: string;
      readonly signal?: AbortSignal;
    };

export interface HostedRuntimeUploadIntake {
  readonly stagingRoot: string;
  cleanup(): Promise<void>;
  finalize(input: {
    readonly fields: Readonly<Record<string, unknown>>;
    readonly files: readonly HostedMultipartFileDescriptor[];
  }): Promise<{ readonly files: readonly HostedUploadedFile[] }>;
}

export interface HostedRuntimeContentContext {
  readonly contentQuota: HostedContentQuota;
  readonly downloadStreams: HostedDownloadStreams;
  readonly generation: number;
  readonly userKey: string;
  activeProjectRoots(): readonly string[];
  artifactAdapter(): HostedArtifactAdapter;
  enqueueMutation<T>(execute: () => T | Promise<T>): Promise<T>;
  projectsRoot(): string;
  ready(): Promise<void>;
  requireProject(projectId: string): unknown;
  uploadsRoot(): string;
  validateProjectId(projectId: string): void;
}

export async function executeHostedRuntimeContentOperation(
  context: HostedRuntimeContentContext,
  operation: HostedRuntimeContentOperation,
): Promise<unknown> {
  switch (operation.kind) {
    case 'content:dispatch':
      await context.ready();
      return executeContentDispatch(context, operation.request);
    case 'archive:open':
      context.validateProjectId(operation.projectId);
      await context.ready();
      context.requireProject(operation.projectId);
      return context.downloadStreams.openArchive({
        archiveName: operation.projectId,
        rootPath: exactOwnedProjectRoot(context.projectsRoot(), operation.projectId),
        userKey: context.userKey,
        ...(operation.relativeRoot === undefined ? {} : { relativeRoot: operation.relativeRoot }),
        ...(operation.signal === undefined ? {} : { signal: operation.signal }),
      });
    case 'upload:begin':
      context.validateProjectId(operation.projectId);
      await context.ready();
      context.requireProject(operation.projectId);
      return createUploadIntake(context, operation.projectId);
    case 'export:manifest': {
      context.validateProjectId(operation.projectId);
      await context.ready();
      const project = context.requireProject(operation.projectId);
      const projectsRoot = context.projectsRoot();
      exactOwnedProjectRoot(projectsRoot, operation.projectId);
      try {
        return buildProjectExportManifestResponse({
          files: await listFiles(projectsRoot, operation.projectId),
          project,
          projectId: operation.projectId,
        });
      } catch (error) {
        throw projectContentError(error);
      }
    }
    case 'artifact:save':
      return context.enqueueMutation(() => context.artifactAdapter().save(operation.request));
    case 'artifact:lint':
      await context.ready();
      return context.artifactAdapter().lint(operation.request);
    case 'artifact:download': {
      await context.ready();
      const download = context.artifactAdapter().openDownload(operation.artifactId);
      return Object.freeze({
        ...download,
        stream: context.downloadStreams.openFile({
          bytes: download.size,
          ...(operation.signal === undefined ? {} : { signal: operation.signal }),
          source: download.stream,
          userKey: context.userKey,
        }),
      });
    }
  }
}

async function executeContentDispatch(
  context: HostedRuntimeContentContext,
  request: unknown,
): Promise<unknown> {
  const authority = { generation: context.generation, userKey: context.userKey };
  return createHostedContentAdapter({
    read: (_authority, operation) => executeContentRead(context, operation),
    mutateInLane: (_authority, operation) => context.enqueueMutation(
      () => executeContentMutation(context, operation),
    ),
  }).dispatch(authority, request);
}

async function executeContentRead(
  context: HostedRuntimeContentContext,
  operation: HostedContentReadOperation,
): Promise<unknown> {
  context.requireProject(operation.projectId);
  const projectsRoot = context.projectsRoot();
  exactOwnedProjectRoot(projectsRoot, operation.projectId);
  try {
    switch (operation.kind) {
      case 'files.list':
        return await listFiles(projectsRoot, operation.projectId, {
          ...(operation.since === undefined ? {} : { since: operation.since }),
        });
      case 'file.read':
        return await readProjectFile(projectsRoot, operation.projectId, operation.path);
      case 'files.search':
        return await searchProjectFiles(projectsRoot, operation.projectId, operation.q, {
          max: operation.max,
          ...(operation.pattern === undefined ? {} : { pattern: operation.pattern }),
        });
      case 'folders.list':
        return await listProjectFolders(projectsRoot, operation.projectId);
    }
  } catch (error) {
    throw projectContentError(error);
  }
}

async function executeContentMutation(
  context: HostedRuntimeContentContext,
  operation: HostedContentMutationOperation,
): Promise<unknown> {
  context.requireProject(operation.projectId);
  const projectsRoot = context.projectsRoot();
  const projectRoot = exactOwnedProjectRoot(projectsRoot, operation.projectId);
  return context.contentQuota.runMutation({
    allWorkspaceRoots: context.activeProjectRoots(),
    operation: contentQuotaOperation(operation),
    workspaceRoot: projectRoot,
  }, async () => {
    try {
      switch (operation.kind) {
        case 'file.write':
          return {
            file: await writeProjectFile(
              projectsRoot,
              operation.projectId,
              operation.body.name,
              operation.body.content,
              {
                expectedContentSha256: operation.body.expectedContentSha256,
                overwrite: operation.body.overwrite,
              },
            ),
          };
        case 'file.rename':
          return await renameProjectFile(
            projectsRoot,
            operation.projectId,
            operation.body.from,
            operation.body.to,
          );
        case 'file.delete':
          await deleteProjectFile(projectsRoot, operation.projectId, operation.path);
          return { ok: true };
        case 'folder.create':
          return {
            folder: await createProjectFolder(
              projectsRoot,
              operation.projectId,
              operation.body.path,
            ),
          };
        case 'folder.delete':
          await deleteProjectFolder(projectsRoot, operation.projectId, operation.body.path);
          return { ok: true };
      }
    } catch (error) {
      throw projectContentError(error);
    }
  });
}

function contentQuotaOperation(
  operation: HostedContentMutationOperation,
): HostedContentQuotaOperation {
  switch (operation.kind) {
    case 'file.write':
      return { bytes: operation.body.content.length, kind: 'write', path: operation.body.name };
    case 'file.rename':
      return { from: operation.body.from, kind: 'rename', to: operation.body.to };
    case 'file.delete':
      return { kind: 'delete', path: operation.path };
    case 'folder.create':
    case 'folder.delete':
      return { kind: operation.kind, path: operation.body.path };
  }
}

async function createUploadIntake(
  context: HostedRuntimeContentContext,
  projectId: string,
): Promise<HostedRuntimeUploadIntake> {
  const intake = await beginHostedUploadIntake({ uploadsRoot: context.uploadsRoot() });
  return Object.freeze({
    stagingRoot: intake.stagingRoot,
    cleanup: () => intake.cleanup(),
    finalize: ({ fields, files }: {
      readonly fields: Readonly<Record<string, unknown>>;
      readonly files: readonly HostedMultipartFileDescriptor[];
    }) => intake.finalize({
      commitInLane: async (commit) => {
        const bytes = files.reduce((total, file) => total + file.size, 0);
        return context.enqueueMutation(() => {
          context.requireProject(projectId);
          const projectRoot = exactOwnedProjectRoot(context.projectsRoot(), projectId);
          return context.contentQuota.runMutation({
            allWorkspaceRoots: context.activeProjectRoots(),
            operation: { bytes, files: files.length, kind: 'growth' },
            workspaceRoot: projectRoot,
          }, commit);
        });
      },
      destinationRoot: exactOwnedProjectRoot(context.projectsRoot(), projectId),
      fields,
      files,
    }),
  });
}

export function createOwnedProjectRoot(projectsRoot: string, projectId: string): void {
  const root = fs.realpathSync(projectsRoot);
  const target = path.join(root, projectId);
  fs.mkdirSync(target);
  const stat = fs.lstatSync(target);
  const resolved = fs.realpathSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFsPath(path.dirname(resolved), root)) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* preserve primary failure */ }
    throw new HostedRuntimeError('HOSTED_RUNTIME_UNAVAILABLE', 'hosted project root is invalid');
  }
}

export function exactOwnedProjectRoot(projectsRoot: string, projectId: string): string {
  const root = fs.realpathSync(projectsRoot);
  const target = path.join(root, projectId);
  const stat = fs.lstatSync(target);
  const resolved = fs.realpathSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFsPath(path.dirname(resolved), root)) {
    throw new HostedRuntimeError('HOSTED_RUNTIME_UNAVAILABLE', 'hosted project root is invalid');
  }
  return resolved;
}

export function removeOwnedProjectRoot(projectsRoot: string, projectId: string): void {
  const root = fs.realpathSync(projectsRoot);
  const target = path.join(root, projectId);
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  const resolved = fs.realpathSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFsPath(path.dirname(resolved), root)) {
    throw new HostedRuntimeError('HOSTED_RUNTIME_UNAVAILABLE', 'hosted project root is invalid');
  }
  fs.rmSync(resolved, { recursive: true, force: false });
}

export function ownedRelativeFile(
  projectsRoot: string,
  projectId: string,
  relativePath: string,
): boolean {
  try {
    const projectRoot = fs.realpathSync(path.join(projectsRoot, projectId));
    let current = projectRoot;
    for (const segment of relativePath.split('/')) {
      current = path.join(current, segment);
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    }
    const stat = fs.statSync(current);
    const resolved = fs.realpathSync(current);
    const relative = path.relative(projectRoot, resolved);
    return stat.isFile()
      && relative !== ''
      && !path.isAbsolute(relative)
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`);
  } catch {
    return false;
  }
}

function projectContentError(error: unknown): Error {
  if (error instanceof HostedRuntimeError) return error;
  if (error instanceof ProjectFileContentConflictError) {
    return new HostedRuntimeError('CONFLICT', error.message);
  }
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new HostedRuntimeError('FILE_NOT_FOUND', 'hosted project content was not found');
  }
  if (code === 'EEXIST') {
    return new HostedRuntimeError('CONFLICT', 'hosted project content already exists');
  }
  if (code === 'EINVAL' || code === 'EISDIR') {
    return new HostedRuntimeError('BAD_REQUEST', 'hosted project content request is invalid');
  }
  return new HostedRuntimeError(
    'HOSTED_RUNTIME_UNAVAILABLE',
    'hosted project content operation failed',
  );
}

function sameFsPath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
