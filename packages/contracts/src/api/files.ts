import type { WidthReleaseRecord, WidthReleaseSelection } from '@readable-studio/html-edit';
export type { WidthReleaseCause, WidthReleaseConflict, WidthReleaseDeclaration, WidthReleaseFamily, WidthReleaseProvenance, WidthReleaseRecord, WidthReleaseSelection } from '@readable-studio/html-edit';
import type { OkResponse } from '../common.js';
import type { ArtifactKind, ArtifactManifest } from './artifacts.js';

/** Maximum size accepted by the project attachment upload endpoint (200 MiB). */
export const MAX_PROJECT_UPLOAD_FILE_SIZE = 200 * 1024 * 1024;

export type ProjectFileKind =
  | 'html'
  | 'image'
  | 'video'
  | 'audio'
  | 'sketch'
  | 'text'
  | 'code'
  | 'pdf'
  | 'document'
  | 'presentation'
  | 'spreadsheet'
  | 'binary';

// Surfaced when the daemon's stub-guard runs in `warn` mode and detects a
// likely regression (the agent emitted a placeholder body that is much
// smaller than a prior artifact sharing the same `metadata.identifier`).
// In `reject` mode the daemon returns `422 ARTIFACT_REGRESSION` instead and
// no `ProjectFile` is produced.
export interface ProjectFileStubGuardWarning {
  code: 'ARTIFACT_REGRESSION';
  message: string;
  identifier: string;
  newSize: number;
  priorSize: number;
  priorName: string;
}

export interface ProjectFile {
  name: string;
  path?: string;
  type?: 'file' | 'dir';
  size: number;
  mtime: number;
  kind: ProjectFileKind;
  mime: string;
  artifactKind?: ArtifactKind;
  artifactManifest?: ArtifactManifest;
  stubGuardWarning?: ProjectFileStubGuardWarning;
}

export interface ProjectFolder {
  name: string;
  path: string;
  type: 'dir';
  size: 0;
  mtime: number;
}

export interface ProjectFilesResponse {
  files: ProjectFile[];
}

export interface ProjectFoldersResponse {
  folders: ProjectFolder[];
}

export type ProjectExportManifestFileRole =
  | 'entry'
  | 'artifact'
  | 'supporting'
  | 'asset'
  | 'source'
  | 'other';

export interface ProjectExportManifestFile extends ProjectFile {
  included: boolean;
  role: ProjectExportManifestFileRole;
  reasons: string[];
}

export interface ProjectExportManifestArtifact {
  file: string;
  title: string;
  kind: ArtifactKind | null;
  renderer: string | null;
  status: string | null;
  exports: string[];
  supportingFiles: string[];
  updatedAt: string | null;
}

export interface ProjectExportManifestResponse {
  schema: 'readable-studio.project-export-manifest.v1';
  projectId: string;
  projectName: string | null;
  generatedAt: string;
  entryFile: string | null;
  files: ProjectExportManifestFile[];
  artifacts: ProjectExportManifestArtifact[];
}

export interface ProjectPreviewUrlResponse {
  url: string;
  file: string;
  csp: string;
  iframeSandbox: string;
  opaqueOrigin: true;
}

export interface ProjectFileResponse {
  file: ProjectFile;
}

/** GET /api/projects/:id/files/:relpath?widthRelease=inspect */
export interface ProjectFileWidthReleaseResponse {
  name: string;
  contentSha256: string;
  records: WidthReleaseRecord[];
}

export type RestoreProjectFileWidthReleaseOperation =
  | { kind: 'restore'; target: { targetId: string; tag?: string; releaseId?: string }; all?: never }
  | { kind: 'restore'; all: true; target?: never };

/** POST /api/projects/:id/files. Mutually exclusive with content/upload fields. */
export interface RestoreProjectFileWidthReleaseRequest {
  name: string;
  expectedContentSha256: string;
  widthRelease: RestoreProjectFileWidthReleaseOperation;
}

export interface RestoreProjectFileWidthReleaseResponse extends ProjectFileResponse {
  widthRelease: {
    records: WidthReleaseRecord[];
    restoredTargetIds: string[];
    contentSha256: string;
    selection?: WidthReleaseSelection;
  };
}

export interface ProjectFolderResponse {
  folder: ProjectFolder;
}

export interface UploadProjectFilesResponse extends ProjectFilesResponse {}

export interface DeleteProjectFileResponse extends OkResponse {}

export interface DeleteProjectFolderResponse extends OkResponse {}

export interface RenameProjectFileRequest {
  from: string;
  to: string;
}

export interface RenameProjectFileResponse {
  file: ProjectFile;
  oldName: string;
  newName: string;
}
