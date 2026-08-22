export type StandaloneHtmlSource =
  | { kind: 'project'; projectId: string; filePath: string }
  | { kind: 'plugin'; pluginId: string; exampleName?: string }
  | { kind: 'design-system'; designSystemId: string; view: 'showcase' | 'preview' }
  | { kind: 'inline'; html: string };

export interface StandaloneHtmlExportRequest {
  source: StandaloneHtmlSource;
}

export interface StandaloneHtmlExportSummary {
  outputBytes: number;
  externalReferenceCount: number;
  missingLocalReferenceCount: number;
  skippedSystemFontCount: number;
}

export const STANDALONE_HTML_EXPORT_HEADERS = {
  externalReferenceCount: 'x-readable-studio-external-reference-count',
  missingLocalReferenceCount: 'x-readable-studio-missing-local-reference-count',
  skippedSystemFontCount: 'x-readable-studio-skipped-system-font-count',
} as const;
