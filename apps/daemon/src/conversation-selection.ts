import type Database from 'better-sqlite3';
import type { ConversationSelection } from '@readable-studio/contracts';
import { getConversation, updateConversation } from './db.js';

export function recentConversationSelection(config: {
  agentId?: string | null;
  agentModels?: ConversationSelection['agentModels'];
}): ConversationSelection {
  return { agentId: config.agentId ?? null, agentModels: structuredClone(config.agentModels ?? {}) };
}

export function isConversationSelection(value: unknown): value is ConversationSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const selection = value as ConversationSelection;
  if (selection.agentId !== null && typeof selection.agentId !== 'string') return false;
  if (!selection.agentModels || typeof selection.agentModels !== 'object' || Array.isArray(selection.agentModels)) return false;
  return Object.values(selection.agentModels).every(choice => choice && typeof choice === 'object'
    && !Array.isArray(choice) && (choice.model === undefined || typeof choice.model === 'string')
    && (choice.reasoning === undefined || typeof choice.reasoning === 'string'));
}

/** Initialize exactly once. Resume-session IDs are unrelated to this selection. */
export function initializeConversationSelection(
  db: Database.Database,
  id: string,
  fallback: ConversationSelection,
  lastRun?: { agentId?: string | null; model?: string; reasoning?: string },
) {
  return db.transaction(() => {
    const conversation = getConversation(db, id);
    if (!conversation || conversation.selection !== null) return conversation;
    const last = db.prepare(`SELECT agent_id AS agentId, events_json AS eventsJson,
      run_context_json AS runContextJson FROM messages
      WHERE conversation_id = ? AND role = 'assistant' AND agent_id IS NOT NULL
      ORDER BY position DESC LIMIT 1`).get(id) as {
        agentId: string; eventsJson: string | null; runContextJson: string | null;
      } | undefined;
    const selection = structuredClone(fallback);
    const agentId = lastRun?.agentId ?? last?.agentId;
    if (agentId) {
      selection.agentId = agentId;
      const events = last?.eventsJson ? JSON.parse(last.eventsJson) : [];
      const context = last?.runContextJson ? JSON.parse(last.runContextJson) : {};
      const recorded = events.findLast((event: { kind?: string; label?: string; detail?: string }) =>
        event.kind === 'status' && (event.label === 'initializing' || event.label === 'model') && event.detail);
      const model = lastRun?.model ?? context.model ?? recorded?.detail;
      if (typeof model === 'string' && model) {
        selection.agentModels[agentId] = { ...selection.agentModels[agentId], model,
          ...(lastRun?.reasoning ? { reasoning: lastRun.reasoning } : {}) };
      }
    }
    return updateConversation(db, id, { selection, updatedAt: conversation.updatedAt });
  })();
}
