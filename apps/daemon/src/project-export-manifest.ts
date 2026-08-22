import nodePath from 'node:path';

export function buildProjectExportManifestResponse({
  project,
  projectId,
  files,
}: {
  project: any;
  projectId: string;
  files: any[];
}) {
  const sortedFiles = [...files].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const filesByName = new Map(sortedFiles.map((file) => [file.name, file]));
  const reasons = new Map<string, Set<string>>();
  const supportingNames = new Set<string>();
  const artifactNames = new Set<string>();
  const artifacts = [];

  const note = (name: unknown, reason: string) => {
    if (typeof name !== 'string' || !filesByName.has(name)) return;
    if (!reasons.has(name)) reasons.set(name, new Set());
    reasons.get(name)?.add(reason);
  };

  for (const file of sortedFiles) {
    const manifest = file.artifactManifest && typeof file.artifactManifest === 'object'
      ? file.artifactManifest
      : null;
    if (!manifest || isInferredArtifactManifest(manifest)) continue;
    artifactNames.add(file.name);
    note(file.name, 'artifact-manifest');

    const artifactSupporting = new Set<string>();
    const addManifestRef = (
      ref: unknown,
      reason: string,
      options: { allowProjectRootFallback?: boolean; preferProjectRoot?: boolean } = {},
    ) => {
      const ownerRelative = normalizeManifestProjectRef(ref, file.name);
      const projectRoot = normalizeManifestProjectRootRef(ref);
      const candidates = options.preferProjectRoot
        ? [projectRoot, ownerRelative]
        : [
            ownerRelative,
            ...(options.allowProjectRootFallback ? [projectRoot] : []),
          ];
      const normalized = candidates.find((candidate) => candidate && filesByName.has(candidate));
      if (!normalized || normalized === file.name) return;
      supportingNames.add(normalized);
      artifactSupporting.add(normalized);
      note(normalized, reason);
    };
    addManifestRef(manifest.entry, 'artifact-entry', { preferProjectRoot: true });
    if (typeof manifest.primary === 'string') {
      addManifestRef(manifest.primary, 'artifact-primary', { preferProjectRoot: true });
    }
    if (Array.isArray(manifest.supportingFiles)) {
      for (const ref of manifest.supportingFiles) {
        addManifestRef(ref, 'artifact-supporting-file', { allowProjectRootFallback: true });
      }
    }

    artifacts.push({
      file: file.name,
      title: typeof manifest.title === 'string' && manifest.title.trim()
        ? manifest.title
        : file.name,
      kind: typeof manifest.kind === 'string' ? manifest.kind : (file.artifactKind ?? null),
      renderer: typeof manifest.renderer === 'string' ? manifest.renderer : null,
      status: typeof manifest.status === 'string' ? manifest.status : null,
      exports: Array.isArray(manifest.exports)
        ? manifest.exports.filter((value: unknown): value is string => typeof value === 'string')
        : [],
      supportingFiles: Array.from(artifactSupporting).sort((a, b) => a.localeCompare(b)),
      updatedAt: typeof manifest.updatedAt === 'string' ? manifest.updatedAt : null,
    });
  }

  const entryFile = chooseExportManifestEntryFile(project, sortedFiles, filesByName);
  note(entryFile, 'project-entry-file');

  return {
    schema: 'readable-studio.project-export-manifest.v1',
    projectId,
    projectName: typeof project?.name === 'string' ? project.name : null,
    generatedAt: new Date().toISOString(),
    entryFile,
    files: sortedFiles.map((file) => ({
      ...file,
      included: true,
      role: roleForExportManifestFile(file, {
        entryFile,
        artifactNames,
        supportingNames,
      }),
      reasons: Array.from(reasons.get(file.name) ?? ['visible-project-file'])
        .sort((a, b) => a.localeCompare(b)),
    })),
    artifacts,
  };
}

function isInferredArtifactManifest(manifest: any): boolean {
  return manifest?.metadata
    && typeof manifest.metadata === 'object'
    && manifest.metadata.inferred === true;
}

function chooseExportManifestEntryFile(
  project: any,
  files: any[],
  filesByName: Map<string, any>,
): string | null {
  const metadataEntry = typeof project?.metadata?.entryFile === 'string'
    ? project.metadata.entryFile
    : null;
  if (metadataEntry && filesByName.has(metadataEntry)) return metadataEntry;
  for (const file of files) {
    const manifest = file.artifactManifest;
    if (!manifest || typeof manifest !== 'object' || isInferredArtifactManifest(manifest)) continue;
    if (manifest.primary === true) return file.name;
    if (typeof manifest.primary === 'string') {
      const rootPrimary = normalizeManifestProjectRootRef(manifest.primary);
      if (rootPrimary && filesByName.has(rootPrimary)) return rootPrimary;
      const ownerRelativePrimary = normalizeManifestProjectRef(manifest.primary, file.name);
      if (ownerRelativePrimary && filesByName.has(ownerRelativePrimary)) return ownerRelativePrimary;
    }
    const rootEntry = normalizeManifestProjectRootRef(manifest.entry);
    if (rootEntry && filesByName.has(rootEntry)) return rootEntry;
    const ownerRelativeEntry = normalizeManifestProjectRef(manifest.entry, file.name);
    if (ownerRelativeEntry && filesByName.has(ownerRelativeEntry)) return ownerRelativeEntry;
  }
  return files.find((file) => /(^|\/)index\.html?$/i.test(file.name))?.name
    ?? files.find((file) => file.kind === 'html')?.name
    ?? files[0]?.name
    ?? null;
}

function normalizeManifestProjectRootRef(ref: unknown): string | null {
  return normalizeManifestProjectRef(ref, '');
}

function normalizeManifestProjectRef(ref: unknown, ownerFile: string): string | null {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  const value = ref.trim();
  if (value.includes('\0') || value.startsWith('/')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  const ownerDir = nodePath.posix.dirname(ownerFile);
  const joined = ownerDir === '.' ? value : `${ownerDir}/${value}`;
  const normalized = nodePath.posix.normalize(joined).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../')) return null;
  if (normalized.split('/').some((segment) => segment === '..' || segment === '.')) return null;
  return normalized;
}

function roleForExportManifestFile(
  file: any,
  refs: {
    entryFile: string | null;
    artifactNames: Set<string>;
    supportingNames: Set<string>;
  },
) {
  if (file.name === refs.entryFile) return 'entry';
  if (refs.artifactNames.has(file.name)) return 'artifact';
  if (refs.supportingNames.has(file.name)) return 'supporting';
  if (file.kind === 'image' || file.kind === 'video' || file.kind === 'audio') return 'asset';
  if (file.kind === 'code' || file.kind === 'text') return 'source';
  return 'other';
}
