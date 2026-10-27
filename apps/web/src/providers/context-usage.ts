import type { ContextUsageResponse } from '@readable-studio/contracts';

export async function fetchContextUsage(projectId: string, conversationId: string, agentId: string, model: string | null): Promise<ContextUsageResponse> {
  const query = new URLSearchParams({ agentId });
  if (model) query.set('model', model);
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/context-usage?${query}`);
  if (!response.ok) throw new Error(`Context usage request failed (${response.status})`);
  const result: ContextUsageResponse = await response.json();
  if (result.projectId !== projectId || result.conversationId !== conversationId || result.agentId !== agentId) {
    throw new Error('Context usage response does not match the selected conversation and agent');
  }
  return result;
}
