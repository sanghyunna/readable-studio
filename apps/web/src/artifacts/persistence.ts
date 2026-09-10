import { fetchProjectFileText } from '../providers/registry';
import type { AgentEvent, ProjectFile } from '../types';

export interface ArtifactPersistenceRun {
  startedAt?: number;
  completedAt?: number;
  messageId: string;
  preTurnFileNames?: string[];
  events?: AgentEvent[];
  replay?: boolean;
}

// Only document-edge whitespace/BOM is discarded. Never collapse whitespace
// inside HTML, scripts, styles, or preformatted text.
export function normalizePersistedArtifactHtml(html: string): string {
  return html.replace(/^\uFEFF/, '').trim();
}

/** A root artifact can only reuse the root index, with current-turn evidence
 * and a fresh read of the complete persisted document. Names are candidates,
 * never evidence of equality. */
export async function resolvePersistedHtmlArtifact(
  projectId: string,
  html: string,
  identifier: string,
  candidateName: string,
  files: ProjectFile[],
  run: ArtifactPersistenceRun,
): Promise<ProjectFile | null> {
  const currentFiles = files.filter((file) => typeof run.startedAt === 'number'
    && file.mtime >= run.startedAt
    && (run.completedAt === undefined || file.mtime <= run.completedAt
      || file.artifactManifest?.metadata?.messageId === run.messageId));
  const index = currentFiles.find((file) => file.name === 'index.html' && (!file.path || file.path === file.name));
  const candidates: ProjectFile[] = [];
  if (index && (index.artifactManifest?.metadata?.messageId === run.messageId
    || (run.preTurnFileNames !== undefined && !run.preTurnFileNames.includes(index.name))
    || successfullyWroteIndex(run.events ?? []))) candidates.push(index);
  if (run.replay) {
    candidates.push(...currentFiles.filter((file) => file !== index && /^[^/\\\\]+\.html$/i.test(file.name)
      && (file.artifactManifest?.metadata?.messageId === run.messageId
        || file.artifactManifest?.metadata?.identifier === identifier
        || file.name === candidateName)));
  }
  for (const file of candidates) {
    const stored = await fetchProjectFileText(projectId, file.name, { cache: 'no-store' });
    if (stored !== null && normalizePersistedArtifactHtml(stored) === normalizePersistedArtifactHtml(html)) return file;
  }
  return null;
}

function successfullyWroteIndex(events: AgentEvent[]): boolean {
  const writes = new Set<string>();
  for (const event of events) {
    if (event.kind === 'tool_use' && ['Write', 'write', 'Edit'].includes(event.name)) {
      const input = event.input as { file_path?: unknown; filePath?: unknown } | null;
      const path = input?.file_path ?? input?.filePath;
      if (path === 'index.html' || path === './index.html') writes.add(event.id);
    }
    if (event.kind === 'tool_result' && !event.isError && writes.has(event.toolUseId)) return true;
  }
  return false;
}
