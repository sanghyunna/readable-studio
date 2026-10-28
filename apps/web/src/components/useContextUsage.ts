import { useEffect, useState } from 'react';
import { TRANSIENT_CONTEXT_USAGE_REASONS, type ContextUsageResponse, type ContextUsageSnapshot } from '@readable-studio/contracts';
import type { ChatMessage } from '../types';
import { fetchContextUsage } from '../providers/context-usage';

interface Input {
  projectId: string;
  conversationId: string | null;
  messagesConversationId: string | null;
  agentId: string | null;
  model: string | null;
  messages: readonly ChatMessage[];
}

export function useContextUsage({ projectId, conversationId, messagesConversationId, agentId, model, messages }: Input): ContextUsageSnapshot | null {
  let latest: ChatMessage | undefined;
  if (messagesConversationId === conversationId) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === 'assistant') {
        latest = messages[index];
        break;
      }
    }
  }
  const latestRunId = latest?.runId ?? null;
  const key = JSON.stringify([projectId, conversationId, agentId, model, latestRunId]);
  const [loaded, setLoaded] = useState<{ key: string; response: ContextUsageResponse | null; requestedAt: number } | null>(null);
  useEffect(() => {
    setLoaded(null);
    if (!conversationId || !agentId) return;
    let canceled = false;
    const requestedAt = Date.now();
    void fetchContextUsage(projectId, conversationId, agentId, model).then(
      response => { if (!canceled) setLoaded({ key, response, requestedAt }); },
      () => { if (!canceled) setLoaded({ key, response: null, requestedAt }); },
    );
    return () => { canceled = true; };
  }, [key, projectId, conversationId, agentId, model, latestRunId]);

  if (!agentId || loaded?.key !== key || messagesConversationId !== conversationId) return null;
  const reportedSeed = loaded.response?.snapshot;
  const seed = reportedSeed && (reportedSeed.state === 'unknown' || reportedSeed.model === model) ? reportedSeed : null;
  let live: ContextUsageSnapshot | null = null;
  if (latest?.agentId === agentId) {
    for (const event of latest.events ?? []) {
      if (event.kind !== 'context_usage') continue;
      const snapshot = event.snapshot;
      if (snapshot.state !== 'unknown' && snapshot.model !== model) continue;
      if (!live || snapshot.updatedAt >= live.updatedAt) live = snapshot;
    }
  }
  // An ended run cannot replace its waiting marker, and the daemon's close-time event is lost once
  // the run is already terminal; the daemon selector applies the same rule on the next fetch.
  const ended = latest?.runStatus === 'succeeded' || latest?.runStatus === 'failed' || latest?.runStatus === 'canceled';
  if (live && ended && TRANSIENT_CONTEXT_USAGE_REASONS.includes(live.reason)) live = { ...live, reason: 'not-reported' };
  if (latest && !latest.runId && (latest.runStatus === 'queued' || latest.runStatus === 'running')) return null;
  if (loaded.response && latestRunId && loaded.response.runId !== latestRunId) return null;
  if (!loaded.response) return live && live.updatedAt >= loaded.requestedAt ? live : null;
  if (live && !latestRunId) return seed;
  return live && (!seed || live.updatedAt >= seed.updatedAt) ? live : seed;
}
