import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { getConversation, listMessagePage } from './db.js';
import { readMessageTransfer } from './message-transfer.js';

export function registerMessageHistoryRoutes(app: Express, db: Database.Database): void {
  app.get<{ id: string; cid: string }>(['/api/projects/:id/conversations/:cid/messages', '/api/projects/:id/conversations/:cid/messages/page'], (req, res) => {
    const conversation = getConversation(db, req.params.cid);
    if (!conversation || conversation.projectId !== req.params.id) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    const afterPosition = Number(req.query.afterPosition ?? -1);
    if (!Number.isSafeInteger(afterPosition) || afterPosition < -1) {
      res.status(400).json({ error: 'Invalid afterPosition' });
      return;
    }
    const beforePosition = req.query.beforePosition === undefined ? undefined : Number(req.query.beforePosition);
    if (beforePosition !== undefined && (!Number.isSafeInteger(beforePosition) || beforePosition < 0)) {
      res.status(400).json({ error: 'Invalid beforePosition' });
      return;
    }
    res.json(listMessagePage(db, req.params.cid, { afterPosition,
      ...(beforePosition === undefined ? {} : { beforePosition }), maxRows: 100, maxBytes: 1024 * 1024 }));
  });
  app.get('/api/projects/:id/conversations/:cid/messages/:mid/parts', (req, res) => {
    const conversation = getConversation(db, req.params.cid);
    const message = db.prepare('SELECT 1 FROM message_snapshots WHERE id = ? AND conversation_id = ?')
      .get(req.params.mid, req.params.cid);
    if (!conversation || conversation.projectId !== req.params.id || !message) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    const part = readMessageTransfer(db, req.params.mid, String(req.query.cursor ?? '0:0:0'));
    if (!part) {
      res.status(400).json({ error: 'Invalid message cursor' });
      return;
    }
    res.json(part);
  });
}
