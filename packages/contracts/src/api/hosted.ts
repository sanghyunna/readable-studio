import type { JsonValue, OkResponse } from '../common.js';
import type { ApiErrorCode, SseErrorPayload } from '../errors.js';
import type { GenUISurfaceSpec } from '../plugins/manifest.js';
import type {
  ChatSseEndPayload,
  ChatSseStartPayload,
  DaemonAgentPayload,
  ProjectConversationCreatedSsePayload,
} from '../sse/chat.js';
import type { SseTransportEvent } from '../sse/common.js';
import type {
  ChatRole,
  ChatRunCreateResponse,
  ChatRunFeedbackRequest,
  ChatRunFeedbackResponse,
  ChatRunStatus,
  ChatRunStatusResponse,
  ChatSessionMode,
  PersistedAgentEvent,
} from './chat.js';
import type {
  ProjectCheckpointDiffResponse,
  ProjectCheckpointResponse,
  ProjectCheckpointsResponse,
} from './checkpoints.js';
import type {
  PreviewComment,
  PreviewCommentResponse,
  PreviewCommentsResponse,
  PreviewCommentUpsertRequest,
} from './comments.js';
import type {
  Conversation,
  Project,
  ProjectKind,
  ProjectTabsState,
} from './projects.js';
import type {
  ProjectExportManifestResponse,
  ProjectFile,
  ProjectFolder,
  ProjectPreviewUrlResponse,
} from './files.js';
import type {
  AgentCatalogResponse,
  DesignSystemDetail,
  DesignSystemSummary,
  SkillDetail,
  SkillFileEntry,
  SkillSummary,
} from './registry.js';

/**
 * Server-derived identity carried through the hosted request/runtime boundary.
 *
 * `userKey` is an immutable internal identity. `storageKey` is the separately
 * validated, path-safe namespace used by hosted storage. Neither value is
 * accepted from a client request.
 */
export interface HostedAuthContext {
  readonly userKey: string;
  readonly storageKey: string;
  readonly requestId: string;
  readonly displayName?: string;
}

export const HOSTED_PROVIDER_IDS = [
  'anthropic',
  'vercel-ai-gateway',
] as const;

export type HostedProviderId = (typeof HOSTED_PROVIDER_IDS)[number];

export interface HostedProviderDescriptor {
  readonly id: HostedProviderId;
  readonly model: string;
}

/** Bootstrap authority for browser and CLI hosted requests. */
export interface HostedSessionResponse {
  readonly publicOrigin: string;
  readonly csrfToken: string;
  readonly csrfExpiresAt: number;
  readonly providers: readonly HostedProviderDescriptor[];
}

export interface HostedProviderStatusResponse {
  readonly provider: HostedProviderId | null;
  readonly configured: boolean;
}

export interface HostedProviderSetRequest {
  readonly provider: HostedProviderId;
  /** Ephemeral secret. It is accepted as input and is never returned. */
  readonly key: string;
}

export interface HostedProviderSetResponse {
  readonly result: 'set';
  readonly provider: HostedProviderId;
  readonly configured: true;
}

export interface HostedProviderTestRequest {
  readonly provider: HostedProviderId;
}

export interface HostedProviderTestResponse {
  readonly result: 'passed';
  readonly provider: HostedProviderId;
  readonly model: string;
}

export interface HostedProviderClearResponse {
  readonly result: 'cleared';
  readonly provider: null;
  readonly configured: false;
}

export const HOSTED_CSRF_HEADER = 'X-Readable-Studio-CSRF' as const;

export const HOSTED_PROJECT_KINDS = [
  'prototype',
  'deck',
  'template',
  'other',
] as const satisfies readonly ProjectKind[];

export type HostedProjectKind = (typeof HOSTED_PROJECT_KINDS)[number];

export interface HostedProjectCreateV1 {
  readonly title: string;
  readonly kind?: HostedProjectKind;
  readonly catalogueId?: string;
}

export interface HostedProjectPatchV1 {
  readonly title?: string;
}

export type HostedProject = Pick<
  Project,
  'id' | 'name' | 'createdAt' | 'updatedAt' | 'status'
>;

export interface HostedProjectsResponse {
  readonly projects: readonly HostedProject[];
}

export interface HostedProjectResponse {
  readonly project: HostedProject;
}

export type HostedProjectDeleteResponse = OkResponse;

export interface HostedConversationCreateV1 {
  readonly title?: string;
  readonly sessionMode?: ChatSessionMode;
  readonly seedFromConversationId?: string;
  readonly forkAfterMessageId?: string;
}

export interface HostedConversationPatchV1 {
  readonly title?: string;
}

export type HostedConversation = Pick<
  Conversation,
  | 'id'
  | 'projectId'
  | 'title'
  | 'sessionMode'
  | 'messageCount'
  | 'createdAt'
  | 'updatedAt'
  | 'totalDurationMs'
  | 'latestRun'
>;

export interface HostedConversationsResponse {
  readonly conversations: readonly HostedConversation[];
}

export interface HostedConversationResponse {
  readonly conversation: HostedConversation;
}

export type HostedConversationDeleteResponse = OkResponse;

export interface HostedMessageUpsertV1 {
  readonly role: ChatRole;
  readonly content: string;
  readonly agentId?: string;
  readonly events?: readonly PersistedAgentEvent[];
  readonly runId?: string;
  readonly runStatus?: ChatRunStatus;
  readonly resumable?: boolean;
  readonly lastRunEventId?: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly sessionMode?: ChatSessionMode;
  readonly attachmentIds?: readonly string[];
  readonly commentIds?: readonly string[];
  readonly producedFileIds?: readonly string[];
  readonly telemetryFinalized?: boolean;
}

export type HostedMessage = Omit<HostedMessageUpsertV1, 'telemetryFinalized'> & {
  readonly id: string;
  readonly agentName?: string;
  readonly createdAt?: number;
};

export interface HostedMessagesResponse {
  readonly messages: readonly HostedMessage[];
}

export interface HostedMessageResponse {
  readonly message: HostedMessage;
}

/** The hosted comment body is the existing preview-comment body, ownership-validated. */
export type HostedCommentCreateV1 = PreviewCommentUpsertRequest;
export type HostedComment = PreviewComment;
export type HostedCommentResponse = PreviewCommentResponse;
export type HostedCommentsResponse = PreviewCommentsResponse;

export type HostedTabsPutV1 = Partial<
  Pick<ProjectTabsState, 'tabs' | 'active' | 'browserTabs'>
>;

export type HostedTabsResponse = Pick<
  ProjectTabsState,
  'tabs' | 'active' | 'browserTabs' | 'hasSavedState' | 'updatedAt'
>;

export type HostedCheckpointsResponse = ProjectCheckpointsResponse;
export type HostedCheckpointResponse = ProjectCheckpointResponse;
export type HostedCheckpointDiffResponse = ProjectCheckpointDiffResponse;

export interface HostedProjectFileWriteV1 {
  readonly name: string;
  readonly content: string;
  readonly encoding?: 'utf8' | 'base64';
  readonly overwrite?: boolean;
  readonly expectedContentSha256?: string;
}

export interface HostedProjectFileRenameV1 {
  readonly from: string;
  readonly to: string;
}

export interface HostedProjectFolderV1 {
  readonly path: string;
}

/** Metadata for one `files` part in a hosted multipart upload. */
export interface HostedProjectUploadFileDescriptor {
  readonly name: string;
  readonly mime: string;
  readonly size: number;
}

export interface HostedProjectUploadV1 {
  readonly dir?: string;
  readonly files: readonly HostedProjectUploadFileDescriptor[];
}

export interface HostedProjectUploadedFile extends HostedProjectUploadFileDescriptor {
  readonly originalName: string;
}

export interface HostedProjectUploadResponse {
  readonly files: readonly HostedProjectUploadedFile[];
}

export type HostedProjectFile = Readonly<
  Pick<ProjectFile, 'name' | 'size' | 'mtime' | 'kind' | 'mime' | 'artifactKind'>
> & {
  readonly path: string;
  readonly type: 'file';
};

export type HostedProjectFolder = Readonly<ProjectFolder>;

export interface HostedProjectFilesQuery {
  readonly since?: number;
}

export interface HostedProjectFilesResponse {
  readonly files: readonly HostedProjectFile[];
}

export interface HostedProjectFileResponse {
  readonly file: HostedProjectFile;
}

export type HostedProjectFileWriteResponse = HostedProjectFileResponse;

export interface HostedProjectFileRenameResponse {
  readonly file: HostedProjectFile;
  readonly oldName: string;
  readonly newName: string;
}

export interface HostedProjectFoldersResponse {
  readonly folders: readonly HostedProjectFolder[];
}

export interface HostedProjectFolderResponse {
  readonly folder: HostedProjectFolder;
}

export type HostedProjectFolderCreateResponse = HostedProjectFolderResponse;

export type HostedProjectFileDeleteResponse = OkResponse;
export type HostedProjectFolderDeleteResponse = OkResponse;

export interface HostedProjectSearchQuery {
  readonly q: string;
  readonly pattern?: string;
  readonly max?: number;
}

export interface HostedProjectSearchMatch {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

export interface HostedProjectSearchResponse {
  readonly query: string;
  readonly matches: readonly HostedProjectSearchMatch[];
}

export interface HostedProjectFilePreviewV1 {
  readonly path: string;
}

export type HostedProjectFilePreviewKind = Extract<
  ProjectFile['kind'],
  'pdf' | 'document' | 'presentation' | 'spreadsheet'
>;

export interface HostedProjectFilePreviewSection {
  readonly title: string;
  readonly lines: readonly string[];
}

export interface HostedProjectFilePreviewResponse {
  readonly kind: HostedProjectFilePreviewKind;
  readonly title: string;
  readonly sections: readonly HostedProjectFilePreviewSection[];
}

export interface HostedProjectPreviewUrlV1 {
  readonly file: string;
}

export type HostedProjectPreviewUrlResponse = Readonly<ProjectPreviewUrlResponse>;

export interface HostedArtifactSaveV1 {
  readonly identifier?: string;
  readonly title?: string;
  readonly html: string;
}

export interface HostedArtifactLintV1 {
  readonly html: string;
}

export type HostedArtifactLintSeverity = 'P0' | 'P1' | 'P2';

export interface HostedArtifactLintFinding {
  readonly severity: HostedArtifactLintSeverity;
  readonly id: string;
  readonly message: string;
  readonly fix: string;
  readonly snippet?: string;
}

export interface HostedArtifactSaveResponse {
  readonly artifactId: string;
  readonly url: string;
  readonly lint: readonly HostedArtifactLintFinding[];
}

export interface HostedArtifactLintResponse {
  readonly findings: readonly HostedArtifactLintFinding[];
  readonly agentMessage: string;
}

export interface HostedArtifactDownloadMetadata {
  readonly artifactId: string;
  readonly contentType: 'text/html; charset=utf-8';
  readonly fileName: 'artifact.html';
  readonly size: number;
}

export interface HostedProjectArchiveQuery {
  readonly root?: string;
}

export type HostedProjectExportManifestResponse = ProjectExportManifestResponse;

export const HOSTED_RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
] as const;

export type HostedRunStatus = (typeof HOSTED_RUN_STATUSES)[number];

export interface HostedRunIntentV1 {
  readonly projectId: string;
  readonly conversationId: string;
  readonly assistantMessageId: string;
  readonly agentId: string;
  readonly message: string;
  readonly clientRequestId: string;
  readonly currentPrompt?: string;
  readonly sessionMode?: ChatSessionMode;
  readonly skillIds?: readonly string[];
  readonly designSystemId?: string | null;
  readonly attachmentIds?: readonly string[];
  readonly commentAttachmentIds?: readonly string[];
  readonly model?: string | null;
  readonly reasoning?: string | null;
  readonly locale?: string;
  readonly contextSelectionIds?: readonly string[];
}

export type HostedRunCreateV1 = HostedRunIntentV1;
export type HostedChatRequestV1 = HostedRunIntentV1;

export type HostedRunCreateResponse = Pick<
  ChatRunCreateResponse,
  'runId' | 'conversationId' | 'assistantMessageId'
>;

export interface HostedRunListQuery {
  readonly projectId?: string;
  readonly conversationId?: string;
  readonly status?: HostedRunStatus;
}

export type HostedRunStatusResponse = Pick<
  ChatRunStatusResponse,
  | 'id'
  | 'projectId'
  | 'conversationId'
  | 'assistantMessageId'
  | 'agentId'
  | 'createdAt'
  | 'updatedAt'
  | 'exitCode'
  | 'resumable'
> & {
  readonly status: HostedRunStatus;
  readonly errorCode?: ApiErrorCode | null;
};

export interface HostedRunListResponse {
  readonly runs: readonly HostedRunStatusResponse[];
}

export type HostedRunCancelResponse = OkResponse;
export type HostedRunFeedbackRequest = ChatRunFeedbackRequest;
export type HostedRunFeedbackResponse = ChatRunFeedbackResponse;

export type HostedDaemonAgentPayload = Exclude<DaemonAgentPayload, { type: 'raw' }>;
export type HostedHeartbeatEvent = SseTransportEvent<'heartbeat', null>;

export type HostedProjectEvent =
  | SseTransportEvent<'conversation-created', ProjectConversationCreatedSsePayload>
  | HostedHeartbeatEvent;

export type HostedRunEvent =
  | SseTransportEvent<'start', Omit<ChatSseStartPayload, 'bin' | 'cwd'>>
  | SseTransportEvent<'agent', HostedDaemonAgentPayload>
  | SseTransportEvent<'error', SseErrorPayload>
  | SseTransportEvent<'end', ChatSseEndPayload>
  | HostedHeartbeatEvent;

export const HOSTED_AG_UI_EVENT_KINDS = [
  'agent.message',
  'tool_call',
  'state_update',
  'ui.surface_requested',
  'ui.surface_responded',
  'run.lifecycle',
] as const;

export type HostedAgUiEventKind = (typeof HOSTED_AG_UI_EVENT_KINDS)[number];

interface HostedAgUiEventBase {
  readonly kind: HostedAgUiEventKind;
  readonly runId: string;
  readonly seq?: number;
  readonly ts: number;
}

export interface HostedAgUiAgentMessageEvent extends HostedAgUiEventBase {
  readonly kind: 'agent.message';
  readonly text: string;
  readonly done?: boolean;
}

export interface HostedAgUiToolCallEvent extends HostedAgUiEventBase {
  readonly kind: 'tool_call';
  readonly toolName: string;
  readonly args: JsonValue;
  readonly callId?: string;
  readonly status?: 'started' | 'completed' | 'failed';
  readonly result?: JsonValue;
}

export interface HostedAgUiStateUpdateEvent extends HostedAgUiEventBase {
  readonly kind: 'state_update';
  readonly path: string;
  readonly value: JsonValue;
}

export interface HostedAgUiSurfaceRequestedEvent extends HostedAgUiEventBase {
  readonly kind: 'ui.surface_requested';
  readonly surfaceId: string;
  readonly surfaceKind: HostedGenUiSurfaceKind;
  readonly payload: JsonValue;
}

export interface HostedAgUiSurfaceRespondedEvent extends HostedAgUiEventBase {
  readonly kind: 'ui.surface_responded';
  readonly surfaceId: string;
  readonly value: JsonValue;
  readonly respondedBy: HostedGenUiRespondedBy;
}

export interface HostedAgUiRunLifecycleEvent extends HostedAgUiEventBase {
  readonly kind: 'run.lifecycle';
  readonly status:
    | 'started'
    | 'pipeline_stage_started'
    | 'pipeline_stage_completed'
    | 'completed'
    | 'cancelled'
    | 'failed';
  readonly stageId?: string;
  readonly iteration?: number;
  readonly message?: string;
}

export type HostedAgUiEvent =
  | HostedAgUiAgentMessageEvent
  | HostedAgUiToolCallEvent
  | HostedAgUiStateUpdateEvent
  | HostedAgUiSurfaceRequestedEvent
  | HostedAgUiSurfaceRespondedEvent
  | HostedAgUiRunLifecycleEvent;

export const HOSTED_GEN_UI_SURFACE_KINDS = [
  'form',
  'choice',
  'confirmation',
  'oauth-prompt',
] as const satisfies readonly GenUISurfaceSpec['kind'][];

export type HostedGenUiSurfaceKind = (typeof HOSTED_GEN_UI_SURFACE_KINDS)[number];
export type HostedGenUiPersistTier = GenUISurfaceSpec['persist'];
export type HostedGenUiSurfaceStatus = 'pending' | 'resolved' | 'timeout' | 'invalidated';
export type HostedGenUiRespondedBy = 'user' | 'agent' | 'auto' | 'cache';

export interface HostedGenUiSurfaceSpec extends Pick<GenUISurfaceSpec, 'id' | 'kind' | 'persist'> {
  readonly schema?: Record<string, JsonValue>;
  readonly prompt?: string;
  readonly timeout?: number;
  readonly onTimeout?: 'abort' | 'default' | 'skip';
  readonly default?: JsonValue;
}

export interface HostedGenUiSurface {
  readonly id: string;
  readonly projectId: string;
  readonly conversationId: string | null;
  readonly runId: string | null;
  readonly surfaceId: string;
  readonly kind: HostedGenUiSurfaceKind;
  readonly persist: HostedGenUiPersistTier;
  readonly value: JsonValue;
  readonly status: HostedGenUiSurfaceStatus;
  readonly respondedBy: HostedGenUiRespondedBy | null;
  readonly requestedAt: number;
  readonly respondedAt: number | null;
  readonly expiresAt: number | null;
}

export interface HostedRunGenUiResponse {
  readonly runId: string;
  readonly surfaces: readonly HostedGenUiSurface[];
}

export interface HostedProjectGenUiResponse {
  readonly projectId: string;
  readonly surfaces: readonly HostedGenUiSurface[];
}

export interface HostedGenUiSurfaceResponse extends HostedGenUiSurface {
  readonly spec: HostedGenUiSurfaceSpec | null;
}

export interface HostedGenUiRespondV1 {
  readonly value: JsonValue;
}

export interface HostedGenUiRespondResponse extends OkResponse {
  readonly surface: HostedGenUiSurface;
}

export interface HostedGenUiRevokeResponse extends OkResponse {
  readonly invalidated: number;
}

export type HostedAgentCatalogueResponse = AgentCatalogResponse;

export type HostedSkillSummary = Pick<
  SkillSummary,
  | 'id'
  | 'name'
  | 'displayName'
  | 'description'
  | 'descriptionI18n'
  | 'triggers'
  | 'mode'
  | 'surface'
  | 'platform'
  | 'category'
  | 'previewType'
  | 'designSystemRequired'
  | 'defaultFor'
  | 'featured'
  | 'fidelity'
  | 'speakerNotes'
  | 'animations'
  | 'craftRequires'
  | 'hasBody'
  | 'examplePrompt'
  | 'examplePromptI18n'
  | 'aggregatesExamples'
>;

export type HostedSkillDetail = HostedSkillSummary & Pick<SkillDetail, 'body'>;

export interface HostedSkillsResponse {
  readonly skills: readonly HostedSkillSummary[];
}

export interface HostedSkillResponse {
  readonly skill: HostedSkillDetail;
}

export type HostedSkillFileEntry = SkillFileEntry;

export interface HostedSkillFilesResponse {
  readonly files: readonly HostedSkillFileEntry[];
}

export type HostedDesignSystemSummary = Pick<
  DesignSystemSummary,
  'id' | 'title' | 'category' | 'summary' | 'swatches' | 'surface' | 'status'
>;

export type HostedDesignSystemDetail = HostedDesignSystemSummary & Pick<DesignSystemDetail, 'body'>;

export interface HostedDesignSystemsResponse {
  readonly designSystems: readonly HostedDesignSystemSummary[];
}

export interface HostedDesignSystemResponse {
  readonly designSystem: HostedDesignSystemDetail;
}

export interface HostedDesignSystemReadV1 {
  readonly path: string;
  readonly designSystemId?: string;
}

export interface HostedDesignSystemReadResponse {
  readonly content: string;
}
