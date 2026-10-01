/** One-time, copy-only bridge from an older portable extract. No row-level merge. */
export type DataImportState = 'unavailable' | 'offered' | 'declined' | 'pending' | 'done' | 'failed';
export interface DataImportCandidate {
  sourceRoot: string;
  sourceData: string;
  projectCount: number;
  modifiedAt: string;
}
export interface DataImportCandidatesResponse {
  state: DataImportState;
  candidates: DataImportCandidate[];
  error?: string;
  /** Diagnostics for unreadable candidates; never silently treated as empty. */
  warnings?: string[];
}
export type DataImportRequest = { action: 'import'; from: string } | { action: 'decline' };
export interface DataImportRequestResponse {
  state: 'pending' | 'declined';
  restartRequired: boolean;
}
