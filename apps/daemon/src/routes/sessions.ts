import type { Express } from 'express';
import type { OkResponse, SessionPinsResponse, SessionsResponse } from '@readable-studio/contracts';
import { updateSessionPin } from '../app-config.js';
import { initializeConversationSelection, recentConversationSelection } from '../conversation-selection.js';
import { countConversationsInWorkspace, getConversation, updateConversation } from '../db.js';
import type { CreateWorkspaceWithSeed } from '../project-routes.js';
import { railEvents } from '../rail-events.js';
import type { RouteDeps } from '../server-context.js';
import { folderIdExists, touchFoldersAfterMove } from './folders.js';
import { buildRailSessions, deleteSessionWithWorkspace } from './rail.js';

export interface RegisterSessionRoutesDeps
  extends RouteDeps<'db' | 'design' | 'http' | 'ids' | 'paths' | 'projectStore' | 'appConfig'> {
  createWorkspaceWithSeed: CreateWorkspaceWithSeed;
}

const DERIVED_NAME_MAX = 80;

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nameFromPrompt(prompt: unknown): string {
  const firstLine = trimmedString(prompt).split(/\r?\n/u)[0]?.trim() ?? '';
  return firstLine.length > DERIVED_NAME_MAX ? firstLine.slice(0, DERIVED_NAME_MAX).trimEnd() : firstLine;
}

export function registerSessionRoutes(app: Express, ctx: RegisterSessionRoutesDeps) {
  const { db, design } = ctx;
  const { sendApiError } = ctx.http;
  const { randomUUID } = ctx.ids;
  const { readAppConfig } = ctx.appConfig;

  app.get('/api/sessions', (req, res) => {
    const folder = typeof req.query.folder === 'string' ? req.query.folder : undefined;
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    if (limitRaw !== undefined && (!Number.isInteger(limitRaw) || limitRaw < 1)) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'limit must be a positive integer');
    }
    let sessions = buildRailSessions(db, design);
    if (folder === 'none') sessions = sessions.filter((s) => s.folderId === null);
    else if (folder !== undefined) sessions = sessions.filter((s) => s.folderId === folder);
    if (limitRaw !== undefined) sessions = sessions.slice(0, limitRaw);
    const body: SessionsResponse = { sessions };
    res.json(body);
  });

  app.post('/api/sessions', async (req, res) => {
    try {
      const request = req.body || {};
      const folderId = request.folderId ?? null;
      if (folderId !== null && typeof folderId !== 'string') {
        return sendApiError(res, 400, 'BAD_REQUEST', 'folderId must be a string or null');
      }
      if (!folderIdExists(db, folderId)) {
        return sendApiError(res, 404, 'NOT_FOUND', 'folder not found');
      }
      const name = trimmedString(request.name) || trimmedString(request.title) || nameFromPrompt(request.pendingPrompt);
      if (!name) return sendApiError(res, 400, 'BAD_REQUEST', 'title required');
      const title = trimmedString(request.title) || name;
      const { projectLocationId: _ignoredLocation, ...rest } = request;
      const result = await ctx.createWorkspaceWithSeed(
        { ...rest, id: typeof request.id === 'string' ? request.id : randomUUID(), name },
        { title, folderId },
      );
      if (!result.ok) {
        if (result.body !== undefined) return res.status(result.status).json(result.body);
        return sendApiError(res, result.status, result.code, result.message);
      }
      if (folderId) touchFoldersAfterMove(db, null, folderId);
      railEvents.emit('session-created', [result.conversationId]);
      /** @type {import('@readable-studio/contracts').CreateSessionResponse} */
      const body = {
        session: getConversation(db, result.conversationId),
        workspace: result.project,
        ...(result.appliedPluginSnapshotId ? { appliedPluginSnapshotId: result.appliedPluginSnapshotId } : {}),
      };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  app.get('/api/sessions/:id', async (req, res) => {
    const conversation = getConversation(db, req.params.id);
    if (!conversation) return sendApiError(res, 404, 'CONVERSATION_NOT_FOUND', 'session not found');
    const recent = recentConversationSelection(await readAppConfig(ctx.paths.RUNTIME_DATA_DIR));
    const lastRun = design.runs.list({ projectId: conversation.projectId, conversationId: conversation.id })
      .sort((a: { createdAt: number }, b: { createdAt: number }) => b.createdAt - a.createdAt)[0];
    /** @type {import('@readable-studio/contracts').SessionResponse} */
    const body = {
      session: initializeConversationSelection(db, conversation.id, recent, lastRun),
    };
    res.json(body);
  });

  app.put('/api/sessions/:id/pin', async (req, res) => {
    if (!getConversation(db, req.params.id)) {
      return sendApiError(res, 404, 'CONVERSATION_NOT_FOUND', 'session not found');
    }
    try {
      const ids = await updateSessionPin(ctx.paths.RUNTIME_DATA_DIR, req.params.id, true);
      railEvents.emit('session-pinned', [req.params.id]);
      const body: SessionPinsResponse = { pinned: ids.filter((id) => getConversation(db, id) !== null) };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, err instanceof RangeError ? 400 : 500,
        err instanceof RangeError ? 'BAD_REQUEST' : 'INTERNAL_ERROR', String(err?.message || err));
    }
  });

  app.delete('/api/sessions/:id/pin', async (req, res) => {
    try {
      const ids = await updateSessionPin(ctx.paths.RUNTIME_DATA_DIR, req.params.id, false);
      railEvents.emit('session-unpinned', [req.params.id]);
      const body: SessionPinsResponse = { pinned: ids.filter((id) => getConversation(db, id) !== null) };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 500, 'INTERNAL_ERROR', String(err?.message || err));
    }
  });

  app.patch('/api/sessions/:id', (req, res) => {
    const conversation = getConversation(db, req.params.id);
    if (!conversation) return sendApiError(res, 404, 'CONVERSATION_NOT_FOUND', 'session not found');
    const request = req.body || {};
    const has = (key: string) => Object.prototype.hasOwnProperty.call(request, key);
    const patch: Record<string, unknown> = {};
    if (has('title')) {
      if (request.title !== null && typeof request.title !== 'string') {
        return sendApiError(res, 400, 'BAD_REQUEST', 'title must be a string or null');
      }
      patch.title = trimmedString(request.title) || null;
    }
    if (has('folderId')) {
      if (!folderIdExists(db, request.folderId)) {
        return sendApiError(res, 404, 'NOT_FOUND', 'folder not found');
      }
      patch.folderId = request.folderId;
    }
    if (has('sessionMode')) {
      if (request.sessionMode !== 'design' && request.sessionMode !== 'chat') {
        return sendApiError(res, 400, 'BAD_REQUEST', 'sessionMode must be design or chat');
      }
      patch.sessionMode = request.sessionMode;
    }
    // A pure move keeps the session's recency (recency = chat activity).
    if (Object.keys(patch).length === 0 || Object.keys(patch).every((key) => key === 'folderId')) {
      patch.updatedAt = conversation.updatedAt;
    }
    const updated = updateConversation(db, conversation.id, patch);
    const moved = has('folderId') && (conversation.folderId ?? null) !== (request.folderId ?? null);
    if (moved) touchFoldersAfterMove(db, conversation.folderId ?? null, request.folderId ?? null);
    // Keep ProjectView's header, exports and handoff naming in sync for a
    // session that owns its workspace alone.
    if (typeof patch.title === 'string' && countConversationsInWorkspace(db, conversation.projectId) === 1) {
      ctx.projectStore.updateProject(db, conversation.projectId, { name: patch.title });
    }
    railEvents.emit(moved ? 'session-moved' : 'session-updated', [conversation.id]);
    /** @type {import('@readable-studio/contracts').SessionResponse} */
    const body = { session: updated };
    res.json(body);
  });

  app.delete('/api/sessions/:id', async (req, res) => {
    try {
      if (!(await deleteSessionWithWorkspace(ctx, req.params.id))) {
        return sendApiError(res, 404, 'CONVERSATION_NOT_FOUND', 'session not found');
      }
      railEvents.emit('session-deleted', [req.params.id]);
      const body: OkResponse = { ok: true };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 500, 'INTERNAL_ERROR', String(err?.message || err));
    }
  });
}
