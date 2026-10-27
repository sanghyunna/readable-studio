import type { Express } from 'express';
import { createApiError, type ContextUsageResponse } from '@readable-studio/contracts';
import { selectContextUsage, type ContextUsageRun } from './context-usage.js';
import { defineJsonRoute, err, mountJsonRoute, ok } from './http/index.js';
import type { RouteDeps } from './server-context.js';

interface ContextUsageInput {
  projectId: string;
  conversationId: string;
  agentId: string;
  model?: string;
}

interface ContextUsageDeps {
  getConversationProject: (conversationId: string) => string | null;
  latestPersistedRun: (conversationId: string) => ContextUsageRun | null;
  listRuns: (input: { projectId: string; conversationId: string }) => ContextUsageRun[];
}

export const getContextUsageRoute = defineJsonRoute<ContextUsageInput, ContextUsageResponse, ContextUsageDeps>({
  method: 'get',
  path: '/api/projects/:projectId/conversations/:conversationId/context-usage',
  requireSameOrigin: true,
  parse: ({ params, query }) => {
    const { projectId, conversationId } = params;
    const { agentId, model } = query;
    if (typeof projectId !== 'string' || !projectId || typeof conversationId !== 'string' || !conversationId
      || typeof agentId !== 'string' || !agentId.trim() || (model !== undefined && (typeof model !== 'string' || !model.trim()))) {
      return err(createApiError('BAD_REQUEST', 'projectId, conversationId and agentId are required; model must be a string'));
    }
    return ok({ projectId, conversationId, agentId, ...(typeof model === 'string' ? { model } : {}) });
  },
  handle: (input, deps) => {
    if (deps.getConversationProject(input.conversationId) !== input.projectId) {
      return err(createApiError('CONVERSATION_NOT_FOUND', 'Conversation not found'));
    }
    return ok(selectContextUsage({ ...input, persisted: deps.latestPersistedRun(input.conversationId),
      runs: deps.listRuns({ projectId: input.projectId, conversationId: input.conversationId }) }));
  },
});

export function registerContextUsageRoutes(app: Express, ctx: RouteDeps<'db' | 'design' | 'http'>): void {
  const deps: ContextUsageDeps = {
    getConversationProject: conversationId => {
      const row = ctx.db.prepare('SELECT project_id AS projectId FROM conversations WHERE id = ?').get(conversationId);
      return row?.projectId ?? null;
    },
    latestPersistedRun: conversationId => {
      const row = ctx.db.prepare(`SELECT id, run_id AS runId, agent_id AS agentId, created_at AS createdAt,
        events_json AS eventsJson FROM messages WHERE conversation_id = ? AND role = 'assistant'
        ORDER BY position DESC LIMIT 1`).get(conversationId);
      if (!row) return null;
      let events: unknown[] = [];
      try {
        const parsed: unknown = row.eventsJson ? JSON.parse(row.eventsJson) : [];
        if (Array.isArray(parsed)) events = parsed;
      } catch { /* Corrupt legacy events stay unknown instead of reviving older context. */ }
      return { id: row.runId ?? row.id, agentId: row.agentId ?? null, createdAt: row.createdAt, events };
    },
    listRuns: input => ctx.design.runs.list(input),
  };
  mountJsonRoute(app, getContextUsageRoute, deps, { resolvedPortRef: ctx.http.resolvedPortRef });
}
