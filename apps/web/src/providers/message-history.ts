import type { ChatMessage } from '../types';

type MessagePage = {
  readonly messages: ChatMessage[];
  readonly nextPosition: number | null;
  readonly oversizedMessageId?: string;
};
type TransferPart = {
  readonly field: string;
  readonly encoding: string;
  readonly data: string | null;
  readonly endField: boolean;
  readonly nextCursor: string | null;
};

function historyUrl(projectId: string, conversationId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/messages`;
}

async function readOversizedMessage(base: string, messageId: string): Promise<ChatMessage> {
  const message: ChatMessage = { id: messageId, role: 'assistant', content: '' };
  let cursor: string | null = '0:0:0';
  let text = '';
  const decoder = new TextDecoder();
  do {
    const response = await fetch(`${base}/${encodeURIComponent(messageId)}/parts?cursor=${encodeURIComponent(cursor)}`);
    if (!response.ok) throw new Error(`Message body request failed (${response.status})`);
    const part: TransferPart = await response.json();
    if (part.data !== null) {
      text += decoder.decode(Uint8Array.from(atob(part.data), char => char.charCodeAt(0)), { stream: !part.endField });
      if (part.endField) {
        const value = part.encoding === 'json' ? JSON.parse(text) : part.encoding === 'number' ? Number(text) : text;
        if (part.field === 'event') {
          message.events = [...(message.events ?? []), value];
          if (value.kind === 'text') message.content += value.text;
        } else {
          Object.assign(message, { [part.field]: value });
        }
        text = '';
      }
    }
    if (part.nextCursor === cursor) throw new Error('Message body cursor did not advance');
    cursor = part.nextCursor;
  } while (cursor !== null);
  return message;
}

/** One bounded request, plus bounded body fragments for a single oversized row. */
export async function loadMessagePage(projectId: string, conversationId: string,
  cursor: number | { readonly beforePosition: number } = -1): Promise<MessagePage> {
  const base = historyUrl(projectId, conversationId);
  const query = typeof cursor === 'number' ? `afterPosition=${cursor}` : `beforePosition=${cursor.beforePosition}`;
  const response = await fetch(`${base}/page?${query}`);
  if (!response.ok) throw new Error(`Message history request failed (${response.status})`);
  const page: MessagePage = await response.json();
  if (page.nextPosition !== null && (typeof cursor === 'number'
    ? page.nextPosition <= cursor : page.nextPosition >= cursor.beforePosition)) throw new Error('Message history cursor did not advance');
  if (!page.oversizedMessageId) return page;
  return { ...page, messages: [...page.messages, await readOversizedMessage(base, page.oversizedMessageId)] };
}

/** Compatibility consumer: no history is dropped while UI owners adopt one-page loading. */
export async function loadCompleteMessageHistory(projectId: string, conversationId: string): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  let cursor: number | null = -1;
  do {
    const page = await loadMessagePage(projectId, conversationId, cursor);
    messages.push(...page.messages);
    cursor = page.nextPosition;
  } while (cursor !== null);
  return messages;
}
