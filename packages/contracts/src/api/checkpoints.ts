export type ProjectCheckpointKind =
  | 'before_run'
  | 'after_run_unfinalized'
  | 'after_message'
  | 'before_restore'
  | 'manual';

export type RollbackMode =
  | 'files_only'
  | 'chat_only'
  | 'files_and_chat';

export type RollbackConflictPolicy =
  | 'fail'
  | 'overwrite'
  | 'keep_current';

export interface ProjectCheckpointSummary {
  id: string;
  projectId: string;
  conversationId: string | null;
  messageId: string | null;
  runId: string | null;
  kind: ProjectCheckpointKind;
  createdAt: number;
  rootPathHash: string;
  fileCount: number;
  totalBytes: number;
  manifestHash: string;
  restoreModes: RollbackMode[];
}

export interface ProjectCheckpointFileDelta {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'unchanged';
  fromHash?: string | null;
  toHash?: string | null;
  fromSize?: number | null;
  toSize?: number | null;
}

export type ProjectCheckpointConflictReason =
  | 'current_changed_since_checkpoint'
  | 'current_deleted_since_checkpoint'
  | 'target_path_blocked'
  | 'unsupported_file_type'
  | 'path_escapes_project';

export interface ProjectCheckpointConflict {
  path: string;
  reason: ProjectCheckpointConflictReason;
  currentHash?: string | null;
  expectedHash?: string | null;
  targetHash?: string | null;
}

export interface ProjectCheckpointsResponse {
  checkpoints: ProjectCheckpointSummary[];
}

export interface ProjectCheckpointResponse {
  checkpoint: ProjectCheckpointSummary;
}

export interface ProjectCheckpointDiffResponse {
  checkpoint: ProjectCheckpointSummary;
  baseCheckpoint?: ProjectCheckpointSummary | null;
  files: ProjectCheckpointFileDelta[];
  conflicts: ProjectCheckpointConflict[];
}

export interface RollbackRequest {
  targetMessageId: string;
  targetCheckpointId?: string;
  mode: RollbackMode;
  conflictPolicy?: RollbackConflictPolicy;
  createSafetyCheckpoint?: boolean;
}

/** Agent intent submitted before the daemon resolves an opaque rollback handle. */
export interface AgentRollbackIntentRequest {
  runId: string;
  mode: 'files_only';
  reason?: string;
}

/** Public request for executing an already-resolved agent self-rollback. */
export interface AgentRollbackExecuteRequest {
  requestId: string;
  conflictPolicy?: RollbackConflictPolicy;
}

export interface DesktopRollbackApprovalPlan {
  approvalRequestId: string;
  actor: 'agent';
  projectId: string;
  conversationId: string;
  targetMessageId: string;
  targetCheckpointId: string;
  mode: 'files_only';
  conflictPolicy: RollbackConflictPolicy;
  runId: string;
  revision: string;
  fileChanges: RollbackFileChangeCounts;
  conflictCount: number;
  reason: string;
  expiresAt: number;
}

/** Private daemon-to-desktop long-poll response. */
export interface DesktopRollbackApprovalNextResponse {
  approval: (DesktopRollbackApprovalPlan & { decisionToken: string }) | null;
}

/** Private desktop-to-daemon one-time decision. */
export interface DesktopRollbackApprovalDecisionRequest {
  approved: boolean;
  decisionToken: string;
}

export interface DesktopRollbackApprovalDecisionResponse {
  accepted: true;
}

export interface RollbackFileChangeCounts {
  added: number;
  modified: number;
  deleted: number;
  unchanged: number;
}

export interface RollbackResponse {
  projectId: string;
  conversationId: string;
  mode: RollbackMode;
  targetMessageId: string;
  restoredCheckpointId?: string | null;
  safetyCheckpointId?: string | null;
  deletedMessageIds: string[];
  clearedAgentSessions: boolean;
  fileChanges: RollbackFileChangeCounts;
  conflicts: ProjectCheckpointConflict[];
  /** Who initiated the rollback. */
  actor: 'user' | 'agent';
  /** Trusted desktop approval recorded with the rollback audit row. */
  approvalRequestId?: string | null;
}

export interface RollbackConflictError {
  code: 'ROLLBACK_CONFLICT';
  message: string;
  conflicts: ProjectCheckpointConflict[];
}

export interface RollbackConflictResponse {
  error: RollbackConflictError;
}

export interface RollbackPlanChangedError {
  code: 'ROLLBACK_PLAN_CHANGED';
  message: string;
}

export interface RollbackPlanChangedResponse {
  error: RollbackPlanChangedError;
}
