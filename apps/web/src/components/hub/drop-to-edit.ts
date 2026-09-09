// Gate in front of the Hub drop-to-edit entry point.
//
// The workspace opens exactly two formats as an editable document: HTML
// (HtmlViewer with direct editing) and Markdown (MarkdownViewer). Everything
// else the viewer only previews, so the zone refuses it up front with a
// visible reason instead of creating a project the user cannot edit.

export const HUB_DROP_EDITABLE_EXTENSIONS = ['.html', '.htm', '.md'] as const;

/** Accept attribute for the keyboard/file-picker path; same set as the drop. */
export const HUB_DROP_ACCEPT = HUB_DROP_EDITABLE_EXTENSIONS.join(',');

export type HubDropDecision =
  | { kind: 'accept'; file: File }
  | { kind: 'empty' }
  | { kind: 'multiple'; count: number }
  | { kind: 'unsupported'; name: string };

export function isHubEditableDocumentName(name: string): boolean {
  const lower = name.toLowerCase();
  return HUB_DROP_EDITABLE_EXTENSIONS.some((ext) => lower.endsWith(ext) && lower.length > ext.length);
}

export function classifyHubDrop(files: readonly File[]): HubDropDecision {
  if (files.length === 0) return { kind: 'empty' };
  if (files.length > 1) return { kind: 'multiple', count: files.length };
  const file = files[0]!;
  if (!isHubEditableDocumentName(file.name)) return { kind: 'unsupported', name: file.name };
  return { kind: 'accept', file };
}

/** Project name for a dropped document: the file name without its extension. */
export function documentProjectName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed) return 'Document';
  const dot = trimmed.lastIndexOf('.');
  const stem = dot > 0 ? trimmed.slice(0, dot).trim() : trimmed;
  return stem || trimmed;
}

/** Result of driving the existing import path with one dropped document. */
export type HubImportFileOutcome =
  | { ok: true }
  | { ok: false; message?: string };
