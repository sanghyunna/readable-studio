// The hub reads sessions through `readConversations()`, which returns a result
// object so a failed read is distinguishable from an empty project. These specs
// were written against the older `listConversations()` array contract; rather
// than restate every fixture, they keep their array-shaped mock and adapt it
// here. A rejection becomes a retryable failure result, which is exactly what a
// network fault produces in production.

import type { ConversationsReadResult } from '../../src/state/projects';
import type { Conversation } from '../../src/types';

type ConversationReadOptions = { signal?: AbortSignal };
type ListConversationsMock = (
  projectId: string,
  options?: ConversationReadOptions,
) => Promise<unknown> | unknown;

export function readConversationsFromListMock(
  listConversations: ListConversationsMock,
): (projectId: string, options?: ConversationReadOptions) => Promise<ConversationsReadResult> {
  return async (
    projectId: string,
    options?: ConversationReadOptions,
  ): Promise<ConversationsReadResult> => {
    try {
      const conversations = (await listConversations(projectId, options)) as Conversation[] | undefined;
      return { ok: true, conversations: conversations ?? [] };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'network',
          message: err instanceof Error ? err.message : 'read failed',
          retryable: true,
        },
      };
    }
  };
}
