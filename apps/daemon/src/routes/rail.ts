import type { Express } from 'express';
import type { RailResponse, RailSession, RailSessionState, RailSseEvent } from '@readable-studio/contracts';
import { readAppConfig, updateSessionPin } from '../app-config.js';
import {
  countConversationsInWorkspace,
  deleteConversation,
  getConversation,
  listFolders,
  listLatestProjectRunStatuses,
  listProjectsAwaitingInput,
  listRailSessions,
} from '../db.js';
import { railEvents } from '../rail-events.js';
import type { RouteDeps } from '../server-context.js';

export interface RegisterRailRoutesDeps extends RouteDeps<'db' | 'design' | 'http' | 'paths'> {}

function railStateFromStatus(value: unknown): RailSessionState {
  switch (value) {
    case 'running':
    case 'starting':
    case 'queued':
      return 'running';
    case 'awaiting_input':
      return 'awaiting';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}

/**
 * Every session for the rail with its state. State uses the same sources as
 * `GET /api/projects` (in-memory runs, latest persisted run status, pending
 * question forms). A live run is attributed to its own conversation; the
 * persisted workspace status is attributed to a session only when it owns
 * the workspace alone, otherwise the session's own latest run decides.
 */
export function buildRailSessions(db: any, design: any): RailSession[] {
  const latestByWorkspace = listLatestProjectRunStatuses(db);
  const awaitingWorkspaces = listProjectsAwaitingInput(db);
  const activeConversations = new Set<string>();
  const activeWorkspaces = new Set<string>();
  for (const run of design.runs.list()) {
    if (design.runs.isTerminal(run.status)) continue;
    if (run.conversationId) activeConversations.add(run.conversationId);
    else if (run.projectId) activeWorkspaces.add(run.projectId);
  }
  return listRailSessions(db).map((s: any) => {
    let state: RailSessionState;
    if (activeConversations.has(s.id)) {
      state = 'running';
    } else if (s.workspaceSessionCount <= 1) {
      if (activeWorkspaces.has(s.projectId)) {
        state = 'running';
      } else {
        const latest = latestByWorkspace.get(s.projectId)?.value;
        state = latest === 'succeeded' && awaitingWorkspaces.has(s.projectId)
          ? 'awaiting'
          : railStateFromStatus(latest);
      }
    } else {
      state = railStateFromStatus(s.latestRun?.status);
    }
    return {
      id: s.id,
      workspaceId: s.projectId,
      folderId: s.folderId ?? null,
      title: s.title ?? null,
      sessionMode: s.sessionMode,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messageCount,
      ...(s.latestRun ? { latestRun: s.latestRun } : {}),
      state,
      workspaceSessionCount: s.workspaceSessionCount,
    };
  });
}

/**
 * Deletes one session. When that leaves its workspace with no conversations
 * and the workspace is managed (no imported `metadata.baseDir`), the
 * workspace row and its `PROJECTS_DIR/<id>` directory go too. Imported user
 * folders are never removed.
 */
export async function deleteSessionWithWorkspace(
  ctx: RouteDeps<'db' | 'paths' | 'projectStore'>,
  sessionId: string,
): Promise<boolean> {
  const { db } = ctx;
  const conversation = getConversation(db, sessionId);
  if (!conversation) return false;
  const workspaceId = conversation.projectId;
  deleteConversation(db, sessionId);
  await updateSessionPin(ctx.paths.RUNTIME_DATA_DIR, sessionId, false);
  if (countConversationsInWorkspace(db, workspaceId) === 0) {
    const workspace = ctx.projectStore.getProject(db, workspaceId);
    if (workspace && typeof workspace.metadata?.baseDir !== 'string') {
      ctx.projectStore.dbDeleteProject(db, workspaceId);
      await ctx.projectStore.removeProjectDir(ctx.paths.PROJECTS_DIR, workspaceId);
    }
  }
  return true;
}

export function registerRailRoutes(app: Express, ctx: RegisterRailRoutesDeps) {
  const { db, design } = ctx;
  const { sendApiError, createSseResponse } = ctx.http;

  app.get('/api/rail', async (_req, res) => {
    try {
      const sessions = buildRailSessions(db, design);
      const sessionIds = new Set(sessions.map((session) => session.id));
      const config = await readAppConfig(ctx.paths.RUNTIME_DATA_DIR);
      const folders = listFolders(db).map((folder) => {
        const folderSessions = sessions.filter((s) => s.folderId === folder.id);
        return { ...folder, sessionCount: folderSessions.length, sessions: folderSessions };
      });
      const body: RailResponse = {
        folders,
        recents: sessions.filter((s) => s.folderId === null),
        pinned: (config.pinnedSessionIds ?? []).filter((id) => sessionIds.has(id)),
        generatedAt: Date.now(),
      };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 500, 'INTERNAL_ERROR', String(err?.message || err));
    }
  });

  app.get('/api/rail/events', (_req, res) => {
    const sse = createSseResponse(res);
    const unsubscribe = railEvents.subscribe((event: RailSseEvent) => {
      sse.send(event.type, event);
    });
    const cleanup = () => unsubscribe();
    res.on('close', cleanup);
    res.on('finish', cleanup);
  });
}
