import { useMemo } from 'react';
import type { ChatMessage, ProjectFile } from '../types';

/** Cache display projections by immutable message identity, scoped to the file snapshot. */
export function useDisplayMessages(
  messages: readonly ChatMessage[],
  projectFiles: readonly ProjectFile[],
  projectMessage: (message: ChatMessage, files: readonly ProjectFile[]) => ChatMessage,
): ChatMessage[] {
  // Weak keys release old streaming snapshots and conversations instead of retaining history.
  const project = useMemo(() => {
    const cache = new WeakMap<ChatMessage, ChatMessage>();
    return (message: ChatMessage): ChatMessage => {
      const cached = cache.get(message);
      if (cached) return cached;
      const display = projectMessage(message, projectFiles);
      cache.set(message, display);
      return display;
    };
  }, [projectFiles, projectMessage]);
  return useMemo(() => messages.map(project), [messages, project]);
}
