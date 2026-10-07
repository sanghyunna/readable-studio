import type { Express } from 'express';
import type {
  DeleteFolderResponse,
  DeleteFolderSessionsPolicy,
  FolderResponse,
  FoldersResponse,
} from '@readable-studio/contracts';
import { deleteFolder, getFolder, insertFolder, listFolders, listRailSessions, updateFolder } from '../db.js';
import { railEvents } from '../rail-events.js';
import type { RouteDeps } from '../server-context.js';
import { deleteSessionWithWorkspace } from './rail.js';

export interface RegisterFolderRoutesDeps extends RouteDeps<'db' | 'http' | 'ids' | 'paths' | 'projectStore'> {}

const FOLDER_NAME_MAX = 120;

/** `null` (no folder) or the id of an existing folder. */
export function folderIdExists(db: any, folderId: unknown): boolean {
  if (folderId === null) return true;
  return typeof folderId === 'string' && getFolder(db, folderId) !== null;
}

/** A move bumps the recency of both the source and the target folder. */
export function touchFoldersAfterMove(db: any, from: string | null, to: string | null): void {
  const now = Date.now();
  for (const id of new Set([from, to])) {
    if (id) updateFolder(db, id, { updatedAt: now });
  }
}

function folderName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name && name.length <= FOLDER_NAME_MAX ? name : null;
}

export function registerFolderRoutes(app: Express, ctx: RegisterFolderRoutesDeps) {
  const { db } = ctx;
  const { sendApiError } = ctx.http;
  const { randomUUID } = ctx.ids;

  app.get('/api/folders', (_req, res) => {
    const body: FoldersResponse = { folders: listFolders(db) };
    res.json(body);
  });

  app.post('/api/folders', (req, res) => {
    const name = folderName(req.body?.name);
    if (!name) {
      return sendApiError(res, 400, 'BAD_REQUEST', `name required (1-${FOLDER_NAME_MAX} characters)`);
    }
    const now = Date.now();
    const folder = insertFolder(db, { id: randomUUID(), name, createdAt: now, updatedAt: now });
    if (!folder) return sendApiError(res, 500, 'INTERNAL_ERROR', 'folder insert failed');
    railEvents.emit('folder-created', [folder.id]);
    const body: FolderResponse = { folder };
    res.json(body);
  });

  app.patch('/api/folders/:id', (req, res) => {
    const name = folderName(req.body?.name);
    if (!name) {
      return sendApiError(res, 400, 'BAD_REQUEST', `name required (1-${FOLDER_NAME_MAX} characters)`);
    }
    const folder = updateFolder(db, req.params.id, { name });
    if (!folder) return sendApiError(res, 404, 'NOT_FOUND', 'folder not found');
    railEvents.emit('folder-updated', [folder.id]);
    const body: FolderResponse = { folder };
    res.json(body);
  });

  app.delete('/api/folders/:id', async (req, res) => {
    const policy = (req.query.sessions ?? 'keep') as DeleteFolderSessionsPolicy;
    if (policy !== 'keep' && policy !== 'delete') {
      return sendApiError(res, 400, 'BAD_REQUEST', 'sessions must be keep or delete');
    }
    if (!getFolder(db, req.params.id)) {
      return sendApiError(res, 404, 'NOT_FOUND', 'folder not found');
    }
    try {
      const sessionIds = listRailSessions(db)
        .filter((s: any) => s.folderId === req.params.id)
        .map((s: any) => String(s.id));
      const deletedSessionIds: string[] = [];
      if (policy === 'delete') {
        for (const id of sessionIds) {
          if (await deleteSessionWithWorkspace(ctx, id)) deletedSessionIds.push(id);
        }
      }
      // ON DELETE SET NULL moves any remaining sessions to "No project".
      deleteFolder(db, req.params.id);
      if (deletedSessionIds.length > 0) railEvents.emit('session-deleted', deletedSessionIds);
      railEvents.emit('folder-deleted', [req.params.id]);
      const body: DeleteFolderResponse = {
        ok: true,
        movedSessionIds: policy === 'keep' ? sessionIds : [],
        deletedSessionIds,
      };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 500, 'INTERNAL_ERROR', String(err?.message || err));
    }
  });
}
