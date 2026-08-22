import {
  deleteConversation,
  deleteProject,
  getConversation,
  insertConversation,
  insertProject,
  listConversations,
  listMessages,
  listPreviewComments,
  listProjects,
  listTabs,
  setTabs,
  updateConversation,
  updateProject,
  upsertMessage,
  upsertPreviewComment,
} from './db.js';
import type {
  HostedMetadataMutationOperation,
  HostedMetadataReadOperation,
} from './hosted-metadata-adapter.js';
import {
  createOwnedProjectRoot,
  ownedRelativeFile,
  removeOwnedProjectRoot,
} from './hosted-runtime-content-app.js';
import { HostedRuntimeError } from './hosted-runtime-error.js';
import type { HostedRuntimeStorage } from './hosted-runtime-storage.js';
import type { ProjectCheckpointService } from './project-checkpoints.js';

type MetadataLimits = {
  readonly comments: number;
  readonly conversations: number;
  readonly messages: number;
  readonly projects: number;
  readonly tabs: number;
};

export interface HostedRuntimeMetadataContext {
  readonly checkpointService: ProjectCheckpointService;
  readonly database: HostedRuntimeStorage['database'];
  readonly limits: MetadataLimits;
  readonly projectCatalogueIds: ReadonlySet<string>;
  readonly projectsRoot: string;
  forgetSession(conversationId: string): void;
  nextEntityId(kind: 'project' | 'conversation' | 'message'): string;
  requireConversation(projectId: string, conversationId: string): {
    readonly id: string;
    readonly projectId: string;
    readonly sessionMode?: 'chat' | 'design';
  };
  requireProject(projectId: string): unknown;
  runConversationId(runId: string): string | null;
}

export function executeHostedMetadataRead(
  context: HostedRuntimeMetadataContext,
  operation: HostedMetadataReadOperation,
): unknown {
  const db = context.database;
  switch (operation.kind) {
    case 'projects.list':
      admitMetadataCount(db, 'projects', context.limits.projects);
      return { projects: listProjects(db) };
    case 'project.get':
      return { project: context.requireProject(operation.projectId) };
    case 'conversations.list':
      context.requireProject(operation.projectId);
      admitMetadataCount(db, 'conversations', context.limits.conversations);
      return { conversations: listConversations(db, operation.projectId) };
    case 'messages.list':
      context.requireConversation(operation.projectId, operation.conversationId);
      admitMetadataCount(db, 'messages', context.limits.messages);
      return { messages: listMessages(db, operation.conversationId).map(hostedMessageRow) };
    case 'comments.list':
      context.requireConversation(operation.projectId, operation.conversationId);
      admitMetadataCount(db, 'comments', context.limits.comments);
      return {
        comments: listPreviewComments(db, operation.projectId, operation.conversationId),
      };
    case 'tabs.get':
      context.requireProject(operation.projectId);
      admitMetadataCount(db, 'tabs', context.limits.tabs);
      return listTabs(db, operation.projectId);
    case 'checkpoints.list':
      context.requireProject(operation.projectId);
      if (operation.conversationId !== undefined) {
        context.requireConversation(operation.projectId, operation.conversationId);
      }
      return {
        checkpoints: context.checkpointService.listCheckpoints(
          operation.projectId,
          operation.conversationId,
        ),
      };
    case 'checkpoint.get':
      context.requireProject(operation.projectId);
      return {
        checkpoint: context.checkpointService.getCheckpoint(
          operation.projectId,
          operation.checkpointId,
        ),
      };
    case 'checkpoint.diff':
      context.requireProject(operation.projectId);
      return context.checkpointService.diffCheckpoint(
        operation.projectId,
        operation.checkpointId,
      );
  }
}

export function executeHostedMetadataMutation(
  context: HostedRuntimeMetadataContext,
  operation: HostedMetadataMutationOperation,
): unknown {
  const db = context.database;
  switch (operation.kind) {
    case 'project.create': {
      const catalogueId = operation.body.catalogueId;
      if (catalogueId !== undefined && !context.projectCatalogueIds.has(catalogueId)) {
        throw new HostedRuntimeError('BAD_REQUEST', 'hosted project catalogue selection is invalid');
      }
      admitMetadataCount(db, 'projects', context.limits.projects, 1);
      const id = context.nextEntityId('project');
      const now = Date.now();
      createOwnedProjectRoot(context.projectsRoot, id);
      try {
        const project = insertProject(db, {
          id,
          name: operation.body.title,
          createdAt: now,
          updatedAt: now,
          metadata: {
            kind: operation.body.kind ?? 'prototype',
            ...(catalogueId === undefined ? {} : { catalogueId }),
          },
        });
        return { project };
      } catch (error) {
        removeOwnedProjectRoot(context.projectsRoot, id);
        throw error;
      }
    }
    case 'project.patch': {
      context.requireProject(operation.projectId);
      return {
        project: updateProject(db, operation.projectId, {
          ...(operation.body.title === undefined ? {} : { name: operation.body.title }),
        }),
      };
    }
    case 'project.delete': {
      context.requireProject(operation.projectId);
      const conversations = listConversations(db, operation.projectId);
      deleteProject(db, operation.projectId);
      for (const conversation of conversations) context.forgetSession(conversation.id);
      removeOwnedProjectRoot(context.projectsRoot, operation.projectId);
      return { ok: true };
    }
    case 'conversation.create': {
      context.requireProject(operation.projectId);
      const source = operation.body.seedFromConversationId === undefined
        ? null
        : context.requireConversation(
            operation.projectId,
            operation.body.seedFromConversationId,
          );
      if (operation.body.forkAfterMessageId !== undefined && source == null) {
        throw new HostedRuntimeError(
          'CONVERSATION_NOT_FOUND',
          'hosted fork source conversation was not found',
        );
      }
      admitMetadataCount(db, 'conversations', context.limits.conversations, 1);
      if (source != null) admitMetadataCount(db, 'messages', context.limits.messages);
      let seedMessages = source == null ? [] : listMessages(db, source.id);
      if (operation.body.forkAfterMessageId !== undefined) {
        const index = seedMessages.findIndex(
          (message) => message.id === operation.body.forkAfterMessageId,
        );
        if (index < 0) {
          throw new HostedRuntimeError('MESSAGE_NOT_FOUND', 'hosted fork message was not found');
        }
        seedMessages = seedMessages.slice(0, index + 1);
      }
      admitMetadataCount(db, 'messages', context.limits.messages, seedMessages.length);
      const id = context.nextEntityId('conversation');
      const now = Date.now();
      const conversation = insertConversation(db, {
        id,
        projectId: operation.projectId,
        title: operation.body.title ?? null,
        sessionMode: operation.body.sessionMode ?? source?.sessionMode ?? 'design',
        createdAt: now,
        updatedAt: now,
      });
      for (const message of seedMessages) {
        upsertMessage(db, id, cloneHostedMessage(context, message));
      }
      return { conversation };
    }
    case 'conversation.patch':
      context.requireConversation(operation.projectId, operation.conversationId);
      return {
        conversation: updateConversation(db, operation.conversationId, operation.body),
      };
    case 'conversation.delete':
      context.requireConversation(operation.projectId, operation.conversationId);
      deleteConversation(db, operation.conversationId);
      context.forgetSession(operation.conversationId);
      return { ok: true };
    case 'message.upsert': {
      context.requireConversation(operation.projectId, operation.conversationId);
      const exists = assertMessageIdentifierAvailable(
        db,
        operation.conversationId,
        operation.messageId,
      );
      if (operation.body.agentId !== undefined && operation.body.agentId !== 'pi') {
        throw new HostedRuntimeError('BAD_REQUEST', 'hosted agent is outside the fixed catalogue');
      }
      if (
        operation.body.runId !== undefined
        && context.runConversationId(operation.body.runId) !== operation.conversationId
      ) {
        throw new HostedRuntimeError('NOT_FOUND', 'hosted run was not found');
      }
      assertOwnedCommentIds(context, operation.conversationId, operation.body.commentIds);
      assertUnavailableContentIds(operation.body.attachmentIds, 'attachment');
      assertUnavailableContentIds(operation.body.producedFileIds, 'produced file');
      admitMetadataCount(db, 'messages', context.limits.messages, exists ? 0 : 1);
      const hostedState = {
        ...(operation.body.resumable === undefined
          ? {}
          : { resumable: operation.body.resumable }),
        ...(operation.body.telemetryFinalized === undefined
          ? {}
          : { telemetryFinalized: operation.body.telemetryFinalized }),
      };
      const message = upsertMessage(db, operation.conversationId, {
        id: operation.messageId,
        role: operation.body.role,
        content: operation.body.content,
        agentId: operation.body.agentId,
        events: operation.body.events,
        runId: operation.body.runId,
        runStatus: operation.body.runStatus,
        lastRunEventId: operation.body.lastRunEventId,
        startedAt: operation.body.startedAt,
        endedAt: operation.body.endedAt,
        sessionMode: operation.body.sessionMode,
        attachments: operation.body.attachmentIds,
        commentAttachments: operation.body.commentIds,
        producedFiles: operation.body.producedFileIds,
        ...(Object.keys(hostedState).length === 0
          ? {}
          : { runContext: { hosted: hostedState } }),
      });
      updateProject(db, operation.projectId, {});
      return { message: hostedMessageRow(message) };
    }
    case 'comment.create':
      context.requireConversation(operation.projectId, operation.conversationId);
      for (const attachment of operation.body.attachments ?? []) {
        if (!ownedRelativeFile(context.projectsRoot, operation.projectId, attachment.path)) {
          throw new HostedRuntimeError('FILE_NOT_FOUND', 'hosted comment attachment was not found');
        }
      }
      admitMetadataCount(
        db,
        'comments',
        context.limits.comments,
        previewCommentExists(
          db,
          operation.projectId,
          operation.conversationId,
          operation.body,
        ) ? 0 : 1,
      );
      return {
        comment: upsertPreviewComment(
          db,
          operation.projectId,
          operation.conversationId,
          operation.body,
        ),
      };
    case 'tabs.put': {
      context.requireProject(operation.projectId);
      const current = listTabs(db, operation.projectId);
      const nextCount = (operation.body.tabs?.length ?? 0)
        + (operation.body.browserTabs?.length ?? 0);
      admitMetadataCount(
        db,
        'tabs',
        context.limits.tabs,
        nextCount - hostedTabCount(current),
      );
      return setTabs(db, operation.projectId, {
        tabs: operation.body.tabs ?? [],
        active: operation.body.active ?? null,
        browserTabs: operation.body.browserTabs ?? [],
      });
    }
  }
}

type MetadataResource = 'comments' | 'conversations' | 'messages' | 'projects' | 'tabs';

const METADATA_COUNT_SQL: Readonly<Record<Exclude<MetadataResource, 'tabs'>, string>> =
  Object.freeze({
    comments: 'SELECT COUNT(*) AS count FROM preview_comments',
    conversations: 'SELECT COUNT(*) AS count FROM conversations',
    messages: 'SELECT COUNT(*) AS count FROM messages',
    projects: 'SELECT COUNT(*) AS count FROM projects',
  });

function admitMetadataCount(
  db: HostedRuntimeStorage['database'],
  resource: MetadataResource,
  maximum: number,
  change = 0,
): void {
  const row = db.prepare(resource === 'tabs'
    ? `SELECT
         (SELECT COUNT(*) FROM tabs)
         + (SELECT COALESCE(SUM(
             CASE
               WHEN json_valid(state_json)
                AND json_type(state_json, '$.browserTabs') = 'array'
                 THEN json_array_length(state_json, '$.browserTabs')
               ELSE 0
             END
           ), 0) FROM tabs_state) AS count`
    : METADATA_COUNT_SQL[resource]).get() as { count?: unknown } | undefined;
  const count = Number(row?.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new HostedRuntimeError(
      'HOSTED_RUNTIME_UNAVAILABLE',
      'hosted metadata cardinality is invalid',
    );
  }
  if (count + change > maximum) {
    throw new HostedRuntimeError(
      'HOSTED_QUOTA_EXCEEDED',
      `hosted ${resource} quota is exceeded`,
    );
  }
}

function hostedTabCount(state: ReturnType<typeof listTabs>): number {
  return state.tabs.length
    + ('browserTabs' in state && Array.isArray(state.browserTabs) ? state.browserTabs.length : 0);
}

function previewCommentExists(
  db: HostedRuntimeStorage['database'],
  projectId: string,
  conversationId: string,
  body: Extract<HostedMetadataMutationOperation, { kind: 'comment.create' }>['body'],
): boolean {
  return db.prepare(
    `SELECT 1
       FROM preview_comments
      WHERE project_id = ?
        AND conversation_id = ?
        AND file_path = ?
        AND element_id = ?
        AND slide_key = ?`,
  ).get(
    projectId,
    conversationId,
    body.target.filePath.trim(),
    body.target.elementId.trim(),
    body.target.slideIndex ?? -1,
  ) != null;
}

function hostedMessageRow(message: Record<string, any> | null) {
  if (message == null) return null;
  const hosted = message.runContext?.hosted;
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    ...(message.agentId === undefined ? {} : { agentId: message.agentId }),
    ...(message.agentName === undefined ? {} : { agentName: message.agentName }),
    ...(message.events === undefined ? {} : { events: message.events }),
    ...(message.runId === undefined ? {} : { runId: message.runId }),
    ...(message.runStatus === undefined ? {} : { runStatus: message.runStatus }),
    ...(hosted?.resumable === undefined ? {} : { resumable: hosted.resumable }),
    ...(message.lastRunEventId === undefined
      ? {}
      : { lastRunEventId: message.lastRunEventId }),
    ...(message.startedAt === undefined ? {} : { startedAt: Number(message.startedAt) }),
    ...(message.endedAt === undefined ? {} : { endedAt: Number(message.endedAt) }),
    ...(message.sessionMode === undefined ? {} : { sessionMode: message.sessionMode }),
    ...(message.attachments === undefined ? {} : { attachmentIds: message.attachments }),
    ...(message.commentAttachments === undefined
      ? {}
      : { commentIds: message.commentAttachments }),
    ...(message.producedFiles === undefined
      ? {}
      : { producedFileIds: message.producedFiles }),
    ...(message.createdAt === undefined ? {} : { createdAt: Number(message.createdAt) }),
    ...(hosted?.telemetryFinalized === undefined
      ? {}
      : { telemetryFinalized: hosted.telemetryFinalized }),
  };
}

function assertMessageIdentifierAvailable(
  db: HostedRuntimeStorage['database'],
  conversationId: string,
  messageId: string,
): boolean {
  const existing = db.prepare(
    'SELECT conversation_id AS conversationId FROM messages WHERE id = ?',
  ).get(messageId) as { conversationId?: unknown } | undefined;
  if (existing != null && existing.conversationId !== conversationId) {
    throw new HostedRuntimeError('MESSAGE_NOT_FOUND', 'hosted message was not found');
  }
  return existing != null;
}

function cloneHostedMessage(
  context: HostedRuntimeMetadataContext,
  message: Record<string, unknown>,
) {
  return {
    id: context.nextEntityId('message'),
    role: message.role,
    content: message.content,
    agentId: message.agentId,
    agentName: message.agentName,
    events: message.events,
    attachments: message.attachments,
    commentAttachments: message.commentAttachments,
    producedFiles: message.producedFiles,
    sessionMode: message.sessionMode,
  };
}

function assertOwnedCommentIds(
  context: HostedRuntimeMetadataContext,
  conversationId: string,
  commentIds: readonly string[] | undefined,
): void {
  if (commentIds === undefined || commentIds.length === 0) return;
  const conversation = getConversation(context.database, conversationId);
  if (conversation == null) {
    throw new HostedRuntimeError('CONVERSATION_NOT_FOUND', 'hosted conversation was not found');
  }
  const owned = new Set(listPreviewComments(
    context.database,
    conversation.projectId,
    conversationId,
  ).map((comment) => comment.id));
  if (commentIds.some((id) => !owned.has(id))) {
    throw new HostedRuntimeError('NOT_FOUND', 'hosted comment was not found');
  }
}

function assertUnavailableContentIds(
  ids: readonly string[] | undefined,
  label: string,
): void {
  if (ids !== undefined && ids.length > 0) {
    throw new HostedRuntimeError('FILE_NOT_FOUND', `hosted ${label} was not found`);
  }
}
