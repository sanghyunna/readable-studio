import type {
  HostedCheckpointDiffResponse,
  HostedCheckpointResponse,
  HostedCheckpointsResponse,
  HostedComment,
  HostedCommentCreateV1,
  HostedCommentResponse,
  HostedCommentsResponse,
  HostedConversation,
  HostedConversationCreateV1,
  HostedConversationDeleteResponse,
  HostedConversationPatchV1,
  HostedConversationResponse,
  HostedConversationsResponse,
  HostedMessage,
  HostedMessageResponse,
  HostedMessagesResponse,
  HostedMessageUpsertV1,
  HostedProject,
  HostedProjectCreateV1,
  HostedProjectDeleteResponse,
  HostedProjectPatchV1,
  HostedProjectResponse,
  HostedProjectsResponse,
  HostedTabsPutV1,
  HostedTabsResponse,
  PersistedAgentEvent,
  PreviewAnnotationStyle,
  PreviewCommentAttachment,
  PreviewCommentMember,
  PreviewCommentPosition,
  ProjectBrowserWorkspaceTab,
  ProjectCheckpointConflict,
  ProjectCheckpointFileDelta,
  ProjectCheckpointSummary,
} from '@readable-studio/contracts';
import { HOSTED_PROJECT_KINDS, HOSTED_RUN_STATUSES } from '@readable-studio/contracts';
import { isSafeId } from './projects.js';

const MAX_TITLE_BYTES = 256;
export const HOSTED_MESSAGE_MAX_BYTES = 1024 * 1024;
const MAX_COMMENT_BYTES = 64 * 1024;
const MAX_COMMENT_TEXT_BYTES = 4 * 1024;
const MAX_RELATIVE_PATH_BYTES = 1024;

export const HOSTED_METADATA_RESOURCE_LIMITS = Object.freeze({
  commentsPerUser: 10_000,
  conversationsPerUser: 1_000,
  messagesPerUser: 10_000,
  projectsPerUser: 100,
  tabsPerUser: 1_000,
});

export interface HostedMetadataAuthority {
  readonly userKey: string;
  readonly generation: number;
}

export type HostedMetadataReadOperation =
  | { readonly kind: 'projects.list' }
  | { readonly kind: 'project.get'; readonly projectId: string }
  | { readonly kind: 'conversations.list'; readonly projectId: string }
  | { readonly kind: 'messages.list'; readonly projectId: string; readonly conversationId: string }
  | { readonly kind: 'comments.list'; readonly projectId: string; readonly conversationId: string }
  | { readonly kind: 'tabs.get'; readonly projectId: string }
  | {
      readonly kind: 'checkpoints.list';
      readonly projectId: string;
      readonly conversationId?: string;
    }
  | { readonly kind: 'checkpoint.get'; readonly projectId: string; readonly checkpointId: string }
  | {
      readonly kind: 'checkpoint.diff';
      readonly projectId: string;
      readonly checkpointId: string;
      readonly base?: 'current';
    };

export type HostedMetadataMutationOperation =
  | { readonly kind: 'project.create'; readonly body: HostedProjectCreateV1 }
  | { readonly kind: 'project.patch'; readonly projectId: string; readonly body: HostedProjectPatchV1 }
  | { readonly kind: 'project.delete'; readonly projectId: string }
  | {
      readonly kind: 'conversation.create';
      readonly projectId: string;
      readonly body: HostedConversationCreateV1;
    }
  | {
      readonly kind: 'conversation.patch';
      readonly projectId: string;
      readonly conversationId: string;
      readonly body: HostedConversationPatchV1;
    }
  | {
      readonly kind: 'conversation.delete';
      readonly projectId: string;
      readonly conversationId: string;
    }
  | {
      readonly kind: 'message.upsert';
      readonly projectId: string;
      readonly conversationId: string;
      readonly messageId: string;
      readonly body: HostedMessageUpsertV1;
    }
  | {
      readonly kind: 'comment.create';
      readonly projectId: string;
      readonly conversationId: string;
      readonly body: HostedCommentCreateV1;
    }
  | { readonly kind: 'tabs.put'; readonly projectId: string; readonly body: HostedTabsPutV1 };

export type HostedMetadataOperation = HostedMetadataReadOperation | HostedMetadataMutationOperation;

export type HostedMetadataResponse =
  | HostedProjectsResponse
  | HostedProjectResponse
  | HostedProjectDeleteResponse
  | HostedConversationsResponse
  | HostedConversationResponse
  | HostedConversationDeleteResponse
  | HostedMessagesResponse
  | HostedMessageResponse
  | HostedCommentsResponse
  | HostedCommentResponse
  | HostedTabsResponse
  | HostedCheckpointsResponse
  | HostedCheckpointResponse
  | HostedCheckpointDiffResponse;

export interface HostedMetadataSemanticDispatcher {
  read(authority: HostedMetadataAuthority, operation: HostedMetadataReadOperation): Promise<unknown>;
  mutateInLane(
    authority: HostedMetadataAuthority,
    operation: HostedMetadataMutationOperation,
  ): Promise<unknown>;
}

export class HostedMetadataAdapterError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'INTERNAL_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'HostedMetadataAdapterError';
  }
}

export function createHostedMetadataAdapter(dispatcher: HostedMetadataSemanticDispatcher): {
  dispatch(authority: HostedMetadataAuthority, request: unknown): Promise<HostedMetadataResponse>;
} {
  return {
    async dispatch(authority, request) {
      const scopedAuthority = validateAuthority(authority);
      const operation = validateRequest(request);
      const result = isMutation(operation)
        ? await dispatcher.mutateInLane(scopedAuthority, operation)
        : await dispatcher.read(scopedAuthority, operation);
      try {
        return sanitizeResponse(operation, result);
      } catch (error) {
        if (error instanceof HostedMetadataAdapterError && error.code === 'BAD_REQUEST') {
          throw internalError('hosted metadata semantic response is invalid');
        }
        throw error;
      }
    },
  };
}

function validateAuthority(authority: HostedMetadataAuthority): HostedMetadataAuthority {
  if (typeof authority?.userKey !== 'string') {
    throw badRequest('hosted metadata authority is invalid');
  }
  const userKeyBytes = Buffer.from(authority.userKey, 'utf8');
  if (
    userKeyBytes.length < 1
    || userKeyBytes.length > 1_024
    || userKeyBytes.toString('utf8') !== authority.userKey
    || /[\u0000-\u001f\u007f]/u.test(authority.userKey)
    || !Number.isSafeInteger(authority.generation)
    || authority.generation < 1
  ) throw badRequest('hosted metadata authority is invalid');
  return Object.freeze({ userKey: authority.userKey, generation: authority.generation });
}

function validateRequest(request: unknown): HostedMetadataOperation {
  const value = record(request, 'hosted metadata request');
  const kind = requiredString(value.kind, 'kind');
  switch (kind) {
    case 'projects.list':
      exactKeys(value, ['kind']);
      return { kind };
    case 'project.create':
      exactKeys(value, ['kind', 'body']);
      return { kind, body: projectCreate(value.body) };
    case 'project.get':
    case 'project.delete': {
      exactKeys(value, ['kind', 'projectId']);
      return { kind, projectId: opaqueId(value.projectId, 'projectId') };
    }
    case 'project.patch':
      exactKeys(value, ['kind', 'projectId', 'body']);
      return {
        kind,
        projectId: opaqueId(value.projectId, 'projectId'),
        body: projectPatch(value.body),
      };
    case 'conversations.list':
      exactKeys(value, ['kind', 'projectId']);
      return { kind, projectId: opaqueId(value.projectId, 'projectId') };
    case 'conversation.create':
      exactKeys(value, ['kind', 'projectId', 'body']);
      return {
        kind,
        projectId: opaqueId(value.projectId, 'projectId'),
        body: conversationCreate(value.body),
      };
    case 'conversation.patch':
      exactKeys(value, ['kind', 'projectId', 'conversationId', 'body']);
      return {
        kind,
        projectId: opaqueId(value.projectId, 'projectId'),
        conversationId: opaqueId(value.conversationId, 'conversationId'),
        body: conversationPatch(value.body),
      };
    case 'conversation.delete':
      exactKeys(value, ['kind', 'projectId', 'conversationId']);
      return {
        kind,
        projectId: opaqueId(value.projectId, 'projectId'),
        conversationId: opaqueId(value.conversationId, 'conversationId'),
      };
    case 'messages.list':
    case 'comments.list':
      exactKeys(value, ['kind', 'projectId', 'conversationId']);
      return {
        kind,
        projectId: opaqueId(value.projectId, 'projectId'),
        conversationId: opaqueId(value.conversationId, 'conversationId'),
      };
    case 'message.upsert':
      exactKeys(value, ['kind', 'projectId', 'conversationId', 'messageId', 'body']);
      return {
        kind,
        projectId: opaqueId(value.projectId, 'projectId'),
        conversationId: opaqueId(value.conversationId, 'conversationId'),
        messageId: opaqueId(value.messageId, 'messageId'),
        body: messageUpsert(value.body),
      };
    case 'comment.create':
      exactKeys(value, ['kind', 'projectId', 'conversationId', 'body']);
      return {
        kind,
        projectId: opaqueId(value.projectId, 'projectId'),
        conversationId: opaqueId(value.conversationId, 'conversationId'),
        body: commentCreate(value.body),
      };
    case 'tabs.get':
      exactKeys(value, ['kind', 'projectId']);
      return { kind, projectId: opaqueId(value.projectId, 'projectId') };
    case 'tabs.put':
      exactKeys(value, ['kind', 'projectId', 'body']);
      return {
        kind,
        projectId: opaqueId(value.projectId, 'projectId'),
        body: tabsPut(value.body),
      };
    case 'checkpoints.list': {
      optionalKeys(value, ['kind', 'projectId'], ['conversationId']);
      const conversationId = optionalOpaqueId(value.conversationId, 'conversationId');
      return {
        kind,
        projectId: opaqueId(value.projectId, 'projectId'),
        ...(conversationId === undefined ? {} : { conversationId }),
      };
    }
    case 'checkpoint.get':
      exactKeys(value, ['kind', 'projectId', 'checkpointId']);
      return {
        kind,
        projectId: opaqueId(value.projectId, 'projectId'),
        checkpointId: opaqueId(value.checkpointId, 'checkpointId'),
      };
    case 'checkpoint.diff': {
      optionalKeys(value, ['kind', 'projectId', 'checkpointId'], ['base']);
      if (value.base !== undefined && value.base !== 'current') {
        throw badRequest('checkpoint diff base is invalid');
      }
      return {
        kind,
        projectId: opaqueId(value.projectId, 'projectId'),
        checkpointId: opaqueId(value.checkpointId, 'checkpointId'),
        ...(value.base === undefined ? {} : { base: 'current' }),
      };
    }
    default:
      throw badRequest('hosted metadata operation is not enabled');
  }
}

function projectCreate(input: unknown): HostedProjectCreateV1 {
  const value = record(input, 'project create body');
  optionalKeys(value, ['title'], ['kind', 'catalogueId']);
  const title = boundedString(value.title, 'title', 1, MAX_TITLE_BYTES);
  const kind = value.kind;
  if (kind !== undefined && !HOSTED_PROJECT_KINDS.includes(kind as never)) {
    throw badRequest('project kind is invalid');
  }
  const hostedKind = kind as NonNullable<HostedProjectCreateV1['kind']> | undefined;
  const catalogueId = optionalOpaqueId(value.catalogueId, 'catalogueId');
  return {
    title,
    ...(hostedKind === undefined ? {} : { kind: hostedKind }),
    ...(catalogueId === undefined ? {} : { catalogueId }),
  };
}

function projectPatch(input: unknown): HostedProjectPatchV1 {
  const value = record(input, 'project patch body');
  optionalKeys(value, [], ['title']);
  const title = optionalBoundedString(value.title, 'title', 1, MAX_TITLE_BYTES);
  return title === undefined ? {} : { title };
}

function conversationCreate(input: unknown): HostedConversationCreateV1 {
  const value = record(input, 'conversation create body');
  optionalKeys(value, [], ['title', 'sessionMode', 'seedFromConversationId', 'forkAfterMessageId']);
  const title = optionalBoundedString(value.title, 'title', 0, MAX_TITLE_BYTES);
  const sessionMode = optionalSessionMode(value.sessionMode);
  const seedFromConversationId = optionalOpaqueId(value.seedFromConversationId, 'seedFromConversationId');
  const forkAfterMessageId = optionalOpaqueId(value.forkAfterMessageId, 'forkAfterMessageId');
  return {
    ...(title === undefined ? {} : { title }),
    ...(sessionMode === undefined ? {} : { sessionMode }),
    ...(seedFromConversationId === undefined ? {} : { seedFromConversationId }),
    ...(forkAfterMessageId === undefined ? {} : { forkAfterMessageId }),
  };
}

function conversationPatch(input: unknown): HostedConversationPatchV1 {
  const value = record(input, 'conversation patch body');
  optionalKeys(value, [], ['title']);
  const title = optionalBoundedString(value.title, 'title', 0, MAX_TITLE_BYTES);
  return title === undefined ? {} : { title };
}

function messageUpsert(input: unknown): HostedMessageUpsertV1 {
  const value = record(input, 'message upsert body');
  optionalKeys(value, ['role', 'content'], [
    'agentId',
    'events',
    'runId',
    'runStatus',
    'resumable',
    'lastRunEventId',
    'startedAt',
    'endedAt',
    'sessionMode',
    'attachmentIds',
    'commentIds',
    'producedFileIds',
    'telemetryFinalized',
  ]);
  if (value.role !== 'user' && value.role !== 'assistant') throw badRequest('message role is invalid');
  const content = boundedString(value.content, 'content', 0, HOSTED_MESSAGE_MAX_BYTES);
  const agentId = optionalOpaqueId(value.agentId, 'agentId');
  const events = optionalPersistedEvents(value.events);
  const runId = optionalOpaqueId(value.runId, 'runId');
  if (value.runStatus !== undefined && !HOSTED_RUN_STATUSES.includes(value.runStatus as never)) {
    throw badRequest('message run status is invalid');
  }
  const runStatus = value.runStatus as NonNullable<HostedMessageUpsertV1['runStatus']> | undefined;
  const resumable = optionalBoolean(value.resumable, 'resumable');
  const lastRunEventId = optionalOpaqueId(value.lastRunEventId, 'lastRunEventId');
  const startedAt = optionalNonNegativeInteger(value.startedAt, 'startedAt');
  const endedAt = optionalNonNegativeInteger(value.endedAt, 'endedAt');
  const sessionMode = optionalSessionMode(value.sessionMode);
  const attachmentIds = optionalIdArray(value.attachmentIds, 'attachmentIds', 12);
  const commentIds = optionalIdArray(value.commentIds, 'commentIds', 100);
  const producedFileIds = optionalIdArray(value.producedFileIds, 'producedFileIds', 1_000);
  const telemetryFinalized = optionalBoolean(value.telemetryFinalized, 'telemetryFinalized');
  return {
    role: value.role,
    content,
    ...(agentId === undefined ? {} : { agentId }),
    ...(events === undefined ? {} : { events }),
    ...(runId === undefined ? {} : { runId }),
    ...(runStatus === undefined ? {} : { runStatus }),
    ...(resumable === undefined ? {} : { resumable }),
    ...(lastRunEventId === undefined ? {} : { lastRunEventId }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(sessionMode === undefined ? {} : { sessionMode }),
    ...(attachmentIds === undefined ? {} : { attachmentIds }),
    ...(commentIds === undefined ? {} : { commentIds }),
    ...(producedFileIds === undefined ? {} : { producedFileIds }),
    ...(telemetryFinalized === undefined ? {} : { telemetryFinalized }),
  };
}

function commentCreate(input: unknown): HostedCommentCreateV1 {
  const value = record(input, 'comment create body');
  optionalKeys(value, ['target', 'note'], ['attachments']);
  const target = commentTarget(value.target);
  const note = boundedString(value.note, 'note', 0, MAX_COMMENT_BYTES);
  const attachments = optionalCommentAttachments(value.attachments);
  return { target, note, ...(attachments === undefined ? {} : { attachments }) };
}

function tabsPut(input: unknown): HostedTabsPutV1 {
  const value = record(input, 'tabs body');
  optionalKeys(value, [], ['tabs', 'active', 'browserTabs']);
  const tabs = value.tabs === undefined ? [] : relativePathArray(value.tabs, 'tabs', 100);
  const active = value.active === undefined
    ? null
    : value.active === null
      ? null
      : relativePath(value.active, 'active');
  if (active !== null && !tabs.includes(active)) throw badRequest('active tab must be a member of tabs');
  const browserTabs = value.browserTabs === undefined ? [] : browserTabArray(value.browserTabs);
  return { tabs, active, browserTabs };
}

function optionalPersistedEvents(input: unknown): readonly PersistedAgentEvent[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 2_000) throw badRequest('events are invalid');
  return input.map(persistedEvent);
}

function persistedEvent(input: unknown): PersistedAgentEvent {
  const value = record(input, 'persisted event');
  const kind = requiredString(value.kind, 'event kind');
  switch (kind) {
    case 'status':
      optionalKeys(value, ['kind', 'label'], ['detail', 'code']);
      return {
        kind,
        label: requiredString(value.label, 'label'),
        ...(value.detail === undefined ? {} : { detail: requiredString(value.detail, 'detail') }),
        ...(value.code === undefined ? {} : { code: requiredString(value.code, 'code') }),
      };
    case 'text':
    case 'thinking':
      exactKeys(value, ['kind', 'text']);
      return { kind, text: requiredString(value.text, 'text') };
    case 'tool_use':
      exactKeys(value, ['kind', 'id', 'name', 'input']);
      jsonValue(value.input, 'tool input');
      return {
        kind,
        id: opaqueId(value.id, 'tool id'),
        name: requiredString(value.name, 'tool name'),
        input: value.input,
      };
    case 'tool_result':
      exactKeys(value, ['kind', 'toolUseId', 'content', 'isError']);
      return {
        kind,
        toolUseId: opaqueId(value.toolUseId, 'toolUseId'),
        content: requiredString(value.content, 'tool result content'),
        isError: requiredBoolean(value.isError, 'isError'),
      };
    case 'usage': {
      optionalKeys(value, ['kind'], ['inputTokens', 'outputTokens', 'costUsd', 'durationMs']);
      return {
        kind,
        ...optionalFiniteNumbers(value, ['inputTokens', 'outputTokens', 'costUsd', 'durationMs']),
      };
    }
    case 'raw':
      exactKeys(value, ['kind', 'line']);
      return { kind, line: requiredString(value.line, 'raw line') };
    case 'agent_rollback_request':
      exactKeys(value, [
        'kind', 'requestId', 'expiresAt', 'runId', 'projectId', 'conversationId',
        'targetMessageId', 'targetCheckpointId', 'mode', 'reason',
      ]);
      if (!['files_only', 'chat_only', 'files_and_chat'].includes(String(value.mode))) {
        throw badRequest('rollback mode is invalid');
      }
      return {
        kind,
        requestId: opaqueId(value.requestId, 'requestId'),
        expiresAt: nonNegativeInteger(value.expiresAt, 'expiresAt'),
        runId: opaqueId(value.runId, 'runId'),
        projectId: opaqueId(value.projectId, 'projectId'),
        conversationId: opaqueId(value.conversationId, 'conversationId'),
        targetMessageId: opaqueId(value.targetMessageId, 'targetMessageId'),
        targetCheckpointId: opaqueId(value.targetCheckpointId, 'targetCheckpointId'),
        mode: value.mode as 'files_only' | 'chat_only' | 'files_and_chat',
        reason: requiredString(value.reason, 'reason'),
      };
    default:
      throw badRequest('persisted event kind is invalid');
  }
}

function commentTarget(input: unknown): HostedCommentCreateV1['target'] {
  const value = record(input, 'comment target');
  optionalKeys(value, ['filePath', 'elementId', 'selector', 'label', 'text', 'position', 'htmlHint'], [
    'style', 'selectionKind', 'memberCount', 'podMembers', 'slideIndex',
  ]);
  const selectionKind = value.selectionKind;
  if (selectionKind !== undefined && selectionKind !== 'element' && selectionKind !== 'pod') {
    throw badRequest('comment selection kind is invalid');
  }
  const memberCount = optionalBoundedInteger(value.memberCount, 'memberCount', 0, 100);
  const podMembers = optionalPodMembers(value.podMembers);
  const slideIndex = optionalNonNegativeInteger(value.slideIndex, 'slideIndex');
  return {
    filePath: relativePath(value.filePath, 'filePath'),
    elementId: commentText(value.elementId, 'elementId'),
    selector: commentText(value.selector, 'selector'),
    label: commentText(value.label, 'label'),
    text: commentText(value.text, 'text'),
    position: commentPosition(value.position),
    htmlHint: commentText(value.htmlHint, 'htmlHint'),
    ...(value.style === undefined ? {} : { style: commentStyle(value.style) }),
    ...(selectionKind === undefined ? {} : { selectionKind }),
    ...(memberCount === undefined ? {} : { memberCount }),
    ...(podMembers === undefined ? {} : { podMembers }),
    ...(slideIndex === undefined ? {} : { slideIndex }),
  };
}

function optionalPodMembers(input: unknown): PreviewCommentMember[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 100) throw badRequest('comment members are invalid');
  return input.map((member): PreviewCommentMember => {
    const value = record(member, 'comment member');
    optionalKeys(value, ['elementId', 'selector', 'label', 'text', 'position', 'htmlHint'], ['style']);
    return {
      elementId: commentText(value.elementId, 'elementId'),
      selector: commentText(value.selector, 'selector'),
      label: commentText(value.label, 'label'),
      text: commentText(value.text, 'text'),
      position: commentPosition(value.position),
      htmlHint: commentText(value.htmlHint, 'htmlHint'),
      ...(value.style === undefined ? {} : { style: commentStyle(value.style) }),
    };
  });
}

function commentPosition(input: unknown): PreviewCommentPosition {
  const value = record(input, 'comment position');
  exactKeys(value, ['x', 'y', 'width', 'height']);
  return {
    x: finiteNumber(value.x, 'x'),
    y: finiteNumber(value.y, 'y'),
    width: finiteNumber(value.width, 'width'),
    height: finiteNumber(value.height, 'height'),
  };
}

const COMMENT_STYLE_KEYS = [
  'color', 'backgroundColor', 'fontSize', 'fontWeight', 'lineHeight', 'textAlign',
  'fontFamily', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderRadius',
] as const;

function commentStyle(input: unknown): PreviewAnnotationStyle {
  const value = record(input, 'comment style');
  optionalKeys(value, [], COMMENT_STYLE_KEYS);
  return Object.fromEntries(
    COMMENT_STYLE_KEYS
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, commentText(value[key], key)]),
  );
}

function optionalCommentAttachments(input: unknown): PreviewCommentAttachment[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 12) throw badRequest('comment attachments are invalid');
  return input.map((attachment): PreviewCommentAttachment => {
    const value = record(attachment, 'comment attachment');
    exactKeys(value, ['path', 'name']);
    return {
      path: relativePath(value.path, 'attachment path'),
      name: boundedString(value.name, 'attachment name', 1, MAX_RELATIVE_PATH_BYTES),
    };
  });
}

function browserTabArray(input: unknown): ProjectBrowserWorkspaceTab[] {
  if (!Array.isArray(input) || input.length > 100) throw badRequest('browser tabs are invalid');
  return input.map((tab): ProjectBrowserWorkspaceTab => {
    const value = record(tab, 'browser tab');
    optionalKeys(value, ['id', 'label'], ['insertAfter', 'title', 'url', 'iconUrl']);
    const insertAfter = value.insertAfter === null
      ? null
      : optionalOpaqueId(value.insertAfter, 'insertAfter');
    return {
      id: opaqueId(value.id, 'browser tab id'),
      label: boundedString(value.label, 'browser tab label', 0, MAX_TITLE_BYTES),
      ...(insertAfter === undefined ? {} : { insertAfter }),
      ...(value.title === undefined ? {} : { title: boundedString(value.title, 'browser tab title', 0, MAX_TITLE_BYTES) }),
      ...(value.url === undefined ? {} : { url: boundedString(value.url, 'browser tab url', 0, 4_096) }),
      ...(value.iconUrl === undefined ? {} : { iconUrl: boundedString(value.iconUrl, 'browser tab icon url', 0, 4_096) }),
    };
  });
}

function sanitizeResponse(operation: HostedMetadataOperation, input: unknown): HostedMetadataResponse {
  const value = record(input, 'hosted metadata response');
  switch (operation.kind) {
    case 'projects.list':
      return {
        projects: boundedResponseArray(
          value.projects,
          'projects',
          HOSTED_METADATA_RESOURCE_LIMITS.projectsPerUser,
        ).map(projectResponse),
      };
    case 'project.create':
    case 'project.get':
    case 'project.patch':
      return { project: projectResponse(value.project) };
    case 'project.delete':
      return okResponse(value);
    case 'conversations.list':
      return {
        conversations: boundedResponseArray(
          value.conversations,
          'conversations',
          HOSTED_METADATA_RESOURCE_LIMITS.conversationsPerUser,
        ).map(conversationResponse),
      };
    case 'conversation.create':
    case 'conversation.patch':
      return { conversation: conversationResponse(value.conversation) };
    case 'conversation.delete':
      return okResponse(value);
    case 'messages.list':
      return {
        messages: boundedResponseArray(
          value.messages,
          'messages',
          HOSTED_METADATA_RESOURCE_LIMITS.messagesPerUser,
        ).map(messageResponse),
      };
    case 'message.upsert':
      return { message: messageResponse(value.message) };
    case 'comments.list':
      return {
        comments: boundedResponseArray(
          value.comments,
          'comments',
          HOSTED_METADATA_RESOURCE_LIMITS.commentsPerUser,
        ).map(commentResponse),
      };
    case 'comment.create':
      return { comment: commentResponse(value.comment) };
    case 'tabs.get':
    case 'tabs.put':
      return tabsResponse(value);
    case 'checkpoints.list':
      return { checkpoints: array(value.checkpoints, 'checkpoints').map(checkpointSummary) };
    case 'checkpoint.get':
      return { checkpoint: checkpointSummary(value.checkpoint) };
    case 'checkpoint.diff':
      return checkpointDiffResponse(value);
  }
}

function projectResponse(input: unknown): HostedProject {
  const value = record(input, 'project response');
  const status = value.status === undefined ? undefined : projectStatus(value.status);
  return {
    id: opaqueId(value.id, 'project id'),
    name: boundedString(value.name, 'project name', 1, MAX_TITLE_BYTES),
    createdAt: nonNegativeInteger(value.createdAt, 'createdAt'),
    updatedAt: nonNegativeInteger(value.updatedAt, 'updatedAt'),
    ...(status === undefined ? {} : { status }),
  };
}

function projectStatus(input: unknown): NonNullable<HostedProject['status']> {
  const value = record(input, 'project status');
  optionalKeys(value, ['value'], ['updatedAt', 'runId']);
  if (!['not_started', 'queued', 'running', 'awaiting_input', 'succeeded', 'failed', 'canceled'].includes(String(value.value))) {
    throw internalError('project response status is invalid');
  }
  return {
    value: value.value as NonNullable<HostedProject['status']>['value'],
    ...(value.updatedAt === undefined ? {} : { updatedAt: responseInteger(value.updatedAt, 'updatedAt') }),
    ...(value.runId === undefined ? {} : { runId: responseId(value.runId, 'runId') }),
  };
}

function conversationResponse(input: unknown): HostedConversation {
  const value = record(input, 'conversation response');
  const latestRun = value.latestRun === undefined ? undefined : latestRunResponse(value.latestRun);
  return {
    id: responseId(value.id, 'conversation id'),
    projectId: responseId(value.projectId, 'project id'),
    title: value.title === null ? null : responseString(value.title, 'conversation title'),
    createdAt: responseInteger(value.createdAt, 'createdAt'),
    updatedAt: responseInteger(value.updatedAt, 'updatedAt'),
    ...(value.sessionMode === undefined ? {} : { sessionMode: responseSessionMode(value.sessionMode) }),
    ...(value.messageCount === undefined ? {} : { messageCount: responseInteger(value.messageCount, 'messageCount') }),
    ...(value.totalDurationMs === undefined ? {} : { totalDurationMs: responseInteger(value.totalDurationMs, 'totalDurationMs') }),
    ...(latestRun === undefined ? {} : { latestRun }),
  };
}

function latestRunResponse(input: unknown): NonNullable<HostedConversation['latestRun']> {
  const value = record(input, 'latest run');
  if (!HOSTED_RUN_STATUSES.includes(value.status as never)) throw internalError('latest run status is invalid');
  return {
    status: value.status as NonNullable<HostedConversation['latestRun']>['status'],
    ...(value.startedAt === undefined ? {} : { startedAt: responseInteger(value.startedAt, 'startedAt') }),
    ...(value.endedAt === undefined ? {} : { endedAt: responseInteger(value.endedAt, 'endedAt') }),
    ...(value.durationMs === undefined ? {} : { durationMs: responseInteger(value.durationMs, 'durationMs') }),
  };
}

function messageResponse(input: unknown): HostedMessage {
  const value = record(input, 'message response');
  const body = messageUpsert(selectKeys(value, [
    'role', 'content', 'agentId', 'events', 'runId', 'runStatus', 'resumable',
    'lastRunEventId', 'startedAt', 'endedAt', 'sessionMode', 'attachmentIds',
    'commentIds', 'producedFileIds', 'telemetryFinalized',
  ]));
  const { telemetryFinalized: _ignored, ...safeBody } = body;
  return {
    ...safeBody,
    id: responseId(value.id, 'message id'),
    ...(value.agentName === undefined ? {} : { agentName: responseString(value.agentName, 'agentName') }),
    ...(value.createdAt === undefined ? {} : { createdAt: responseInteger(value.createdAt, 'createdAt') }),
  };
}

function commentResponse(input: unknown): HostedComment {
  const value = record(input, 'comment response');
  const target = commentTarget(selectKeys(value, [
    'filePath', 'elementId', 'selector', 'label', 'text', 'position', 'htmlHint',
    'style', 'selectionKind', 'memberCount', 'podMembers', 'slideIndex',
  ]));
  const attachments = optionalCommentAttachments(value.attachments);
  if (!['open', 'attached', 'applying', 'needs_review', 'resolved', 'failed'].includes(String(value.status))) {
    throw internalError('comment status is invalid');
  }
  return {
    id: responseId(value.id, 'comment id'),
    projectId: responseId(value.projectId, 'project id'),
    conversationId: responseId(value.conversationId, 'conversation id'),
    ...target,
    note: responseString(value.note, 'comment note'),
    ...(attachments === undefined ? {} : { attachments }),
    status: value.status as HostedComment['status'],
    createdAt: responseInteger(value.createdAt, 'createdAt'),
    updatedAt: responseInteger(value.updatedAt, 'updatedAt'),
  };
}

function tabsResponse(input: unknown): HostedTabsResponse {
  const value = record(input, 'tabs response');
  const state = tabsPut(selectKeys(value, ['tabs', 'active', 'browserTabs']));
  return {
    tabs: state.tabs ?? [],
    active: state.active ?? null,
    browserTabs: state.browserTabs ?? [],
    ...(value.hasSavedState === undefined ? {} : { hasSavedState: responseBoolean(value.hasSavedState, 'hasSavedState') }),
    ...(value.updatedAt === undefined ? {} : { updatedAt: responseInteger(value.updatedAt, 'updatedAt') }),
  };
}

function checkpointSummary(input: unknown): ProjectCheckpointSummary {
  const value = record(input, 'checkpoint response');
  if (!['before_run', 'after_run_unfinalized', 'after_message', 'before_restore', 'manual'].includes(String(value.kind))) {
    throw internalError('checkpoint kind is invalid');
  }
  if (!Array.isArray(value.restoreModes) || value.restoreModes.some((mode) => !['files_only', 'chat_only', 'files_and_chat'].includes(String(mode)))) {
    throw internalError('checkpoint restore modes are invalid');
  }
  return {
    id: responseId(value.id, 'checkpoint id'),
    projectId: responseId(value.projectId, 'project id'),
    conversationId: nullableResponseId(value.conversationId, 'conversation id'),
    messageId: nullableResponseId(value.messageId, 'message id'),
    runId: nullableResponseId(value.runId, 'run id'),
    kind: value.kind as ProjectCheckpointSummary['kind'],
    createdAt: responseInteger(value.createdAt, 'createdAt'),
    rootPathHash: responseString(value.rootPathHash, 'rootPathHash'),
    fileCount: responseInteger(value.fileCount, 'fileCount'),
    totalBytes: responseInteger(value.totalBytes, 'totalBytes'),
    manifestHash: responseString(value.manifestHash, 'manifestHash'),
    restoreModes: value.restoreModes as ProjectCheckpointSummary['restoreModes'],
  };
}

function checkpointDiffResponse(value: Record<string, unknown>): HostedCheckpointDiffResponse {
  const baseCheckpoint = value.baseCheckpoint === undefined || value.baseCheckpoint === null
    ? value.baseCheckpoint as undefined | null
    : checkpointSummary(value.baseCheckpoint);
  return {
    checkpoint: checkpointSummary(value.checkpoint),
    ...(baseCheckpoint === undefined ? {} : { baseCheckpoint }),
    files: array(value.files, 'checkpoint files').map(checkpointFileDelta),
    conflicts: array(value.conflicts, 'checkpoint conflicts').map(checkpointConflict),
  };
}

function checkpointFileDelta(input: unknown): ProjectCheckpointFileDelta {
  const value = record(input, 'checkpoint file delta');
  if (!['added', 'modified', 'deleted', 'unchanged'].includes(String(value.status))) {
    throw internalError('checkpoint file status is invalid');
  }
  return {
    path: responseRelativePath(value.path, 'checkpoint path'),
    status: value.status as ProjectCheckpointFileDelta['status'],
    ...optionalNullableStrings(value, ['fromHash', 'toHash']),
    ...optionalNullableNumbers(value, ['fromSize', 'toSize']),
  };
}

function checkpointConflict(input: unknown): ProjectCheckpointConflict {
  const value = record(input, 'checkpoint conflict');
  if (![
    'current_changed_since_checkpoint', 'current_deleted_since_checkpoint', 'target_path_blocked',
    'unsupported_file_type', 'path_escapes_project',
  ].includes(String(value.reason))) throw internalError('checkpoint conflict reason is invalid');
  return {
    path: responseRelativePath(value.path, 'checkpoint conflict path'),
    reason: value.reason as ProjectCheckpointConflict['reason'],
    ...optionalNullableStrings(value, ['currentHash', 'expectedHash', 'targetHash']),
  };
}

function okResponse(value: Record<string, unknown>): { ok: true } {
  if (value.ok !== true) throw internalError('hosted metadata response is invalid');
  return { ok: true };
}

function isMutation(operation: HostedMetadataOperation): operation is HostedMetadataMutationOperation {
  return [
    'project.create', 'project.patch', 'project.delete', 'conversation.create',
    'conversation.patch', 'conversation.delete', 'message.upsert', 'comment.create', 'tabs.put',
  ].includes(operation.kind);
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

function selectKeys(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys
    .filter((key) => Object.hasOwn(value, key))
    .map((key) => [key, value[key]]));
}

function optionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw badRequest('hosted metadata request contains unsupported fields');
  }
}

function opaqueId(input: unknown, name: string): string {
  if (!isSafeId(input)) throw badRequest(`${name} is invalid`);
  return input as string;
}

function optionalOpaqueId(input: unknown, name: string): string | undefined {
  return input === undefined ? undefined : opaqueId(input, name);
}

function requiredString(input: unknown, name: string): string {
  if (typeof input !== 'string') throw badRequest(`${name} must be a string`);
  return input;
}

function boundedString(input: unknown, name: string, minBytes: number, maxBytes: number): string {
  const value = requiredString(input, name);
  const bytes = byteLength(value);
  if (bytes < minBytes || bytes > maxBytes || Buffer.from(value, 'utf8').toString('utf8') !== value || value.includes('\0')) {
    throw badRequest(`${name} is outside its hosted bound`);
  }
  return value;
}

function optionalBoundedString(
  input: unknown,
  name: string,
  minBytes: number,
  maxBytes: number,
): string | undefined {
  return input === undefined ? undefined : boundedString(input, name, minBytes, maxBytes);
}

function commentText(input: unknown, name: string): string {
  return boundedString(input, name, 0, MAX_COMMENT_TEXT_BYTES);
}

function optionalSessionMode(input: unknown): 'design' | 'chat' | undefined {
  if (input === undefined) return undefined;
  if (input !== 'design' && input !== 'chat') throw badRequest('sessionMode is invalid');
  return input;
}

function optionalBoolean(input: unknown, name: string): boolean | undefined {
  return input === undefined ? undefined : requiredBoolean(input, name);
}

function requiredBoolean(input: unknown, name: string): boolean {
  if (typeof input !== 'boolean') throw badRequest(`${name} must be boolean`);
  return input;
}

function optionalNonNegativeInteger(input: unknown, name: string): number | undefined {
  return input === undefined ? undefined : nonNegativeInteger(input, name);
}

function nonNegativeInteger(input: unknown, name: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) throw badRequest(`${name} must be a non-negative integer`);
  return input as number;
}

function optionalBoundedInteger(
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

function finiteNumber(input: unknown, name: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) throw badRequest(`${name} must be finite`);
  return input;
}

function optionalFiniteNumbers(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, number> {
  return Object.fromEntries(keys
    .filter((key) => value[key] !== undefined)
    .map((key) => [key, finiteNumber(value[key], key)]));
}

function optionalIdArray(input: unknown, name: string, max: number): readonly string[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > max) throw badRequest(`${name} is invalid`);
  return input.map((id) => opaqueId(id, name));
}

function relativePathArray(input: unknown, name: string, max: number): string[] {
  if (!Array.isArray(input) || input.length > max) throw badRequest(`${name} is invalid`);
  return input.map((path) => relativePath(path, name));
}

function relativePath(input: unknown, name: string): string {
  const value = boundedString(input, name, 1, MAX_RELATIVE_PATH_BYTES);
  if (
    value.startsWith('/')
    || value.includes('\\')
    || /^[A-Za-z]:/u.test(value)
    || value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) throw badRequest(`${name} must be a canonical relative path`);
  return value;
}

function jsonValue(input: unknown, name: string): void {
  try {
    const encoded = JSON.stringify(input);
    if (encoded === undefined) throw new Error('not JSON');
  } catch {
    throw badRequest(`${name} must be JSON`);
  }
}

function array(input: unknown, name: string): unknown[] {
  if (!Array.isArray(input)) throw internalError(`${name} response is invalid`);
  return input;
}

function boundedResponseArray(input: unknown, name: string, maximum: number): unknown[] {
  const values = array(input, name);
  if (values.length > maximum) throw internalError(`${name} response exceeds its hosted bound`);
  return values;
}

function responseId(input: unknown, name: string): string {
  try {
    return opaqueId(input, name);
  } catch {
    throw internalError(`${name} response is invalid`);
  }
}

function nullableResponseId(input: unknown, name: string): string | null {
  return input === null ? null : responseId(input, name);
}

function responseString(input: unknown, name: string): string {
  if (typeof input !== 'string') throw internalError(`${name} response is invalid`);
  return input;
}

function responseInteger(input: unknown, name: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) throw internalError(`${name} response is invalid`);
  return input as number;
}

function responseBoolean(input: unknown, name: string): boolean {
  if (typeof input !== 'boolean') throw internalError(`${name} response is invalid`);
  return input;
}

function responseSessionMode(input: unknown): 'design' | 'chat' {
  if (input !== 'design' && input !== 'chat') throw internalError('session mode response is invalid');
  return input;
}

function responseRelativePath(input: unknown, name: string): string {
  try {
    return relativePath(input, name);
  } catch {
    throw internalError(`${name} response is invalid`);
  }
}

function optionalNullableStrings(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, string | null> {
  return Object.fromEntries(keys
    .filter((key) => value[key] !== undefined)
    .map((key) => [key, value[key] === null ? null : responseString(value[key], key)]));
}

function optionalNullableNumbers(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, number | null> {
  return Object.fromEntries(keys
    .filter((key) => value[key] !== undefined)
    .map((key) => [key, value[key] === null ? null : responseInteger(value[key], key)]));
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function badRequest(message: string): HostedMetadataAdapterError {
  return new HostedMetadataAdapterError('BAD_REQUEST', message);
}

function internalError(message: string): HostedMetadataAdapterError {
  return new HostedMetadataAdapterError('INTERNAL_ERROR', message);
}
