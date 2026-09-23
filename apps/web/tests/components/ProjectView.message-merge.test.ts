import { describe, expect, it } from 'vitest';
import {
  findLatestQuestionFormOccurrence,
  mergeServerMessagesIntoConversation,
} from '../../src/components/ProjectView';
import type { ChatMessage } from '../../src/types';

const prompt: ChatMessage = { id: 'original-user', role: 'user', content: 'Make a presentation' };
const failed: ChatMessage = {
  id: 'databricks-failed', role: 'assistant', content: '400 upstream error', runStatus: 'failed',
};
const form: ChatMessage = {
  id: 'cursor-new', role: 'assistant', runStatus: 'succeeded',
  content: '<question-form id="discovery">{"questions":[{"id":"tone","label":"Tone","type":"text"}]}</question-form>',
};

describe('bounded newest-page refresh ordering', () => {
  it.each([
    { name: 'a single oversized form row', page: [form] },
    { name: 'a multi-row suffix', page: [failed, form] },
  ])('keeps the form after its own prompt when the page contains $name', ({ page }) => {
    // Given: the original prompt, failed attempt, and fresh retry form are visible.
    const current = [prompt, failed, form];
    // When: completion refresh returns only the bounded newest page.
    const merged = mergeServerMessagesIntoConversation(current, page);
    // Then: chronology and the latest assistant's form association survive.
    expect(merged.map(message => message.id)).toEqual(['original-user', 'databricks-failed', 'cursor-new']);
    const occurrence = findLatestQuestionFormOccurrence(merged);
    expect(occurrence?.messageId).toBe(form.id);
    expect(occurrence?.messageIndex).toBeGreaterThan(merged.findIndex(message => message.id === prompt.id));
    expect(occurrence?.messageId).toBe(merged.filter(message => message.role === 'assistant').at(-1)?.id);
    expect(merged.filter(message => message.role === 'user')).toHaveLength(1);
    expect(merged.find(message => message.id === failed.id)?.runStatus).toBe('failed');
  });

  it('places a server-created trailing row before a newer local in-flight turn', () => {
    // Given: a newer local turn is not persisted in the completion snapshot yet.
    const nextPrompt: ChatMessage = { id: 'next-user', role: 'user', content: 'Continue' };
    const inflight: ChatMessage = { id: 'inflight', role: 'assistant', content: '', runStatus: 'running' };
    const cta: ChatMessage = { id: 'cta', role: 'assistant', content: '' };
    // When: the newest page includes the completed retry and its server-created CTA.
    const merged = mergeServerMessagesIntoConversation([prompt, failed, form, nextPrompt, inflight], [form, cta]);
    // Then: older history, server order, and the local tail all retain their positions.
    expect(merged.map(message => message.id)).toEqual([
      'original-user', 'databricks-failed', 'cursor-new', 'cta', 'next-user', 'inflight',
    ]);
  });

  it('appends a disjoint newest page after already-loaded older history', () => {
    // Given: the newest server row has not been observed locally yet.
    const current = [prompt, failed];
    // When: the bounded page contains only that new row.
    const merged = mergeServerMessagesIntoConversation(current, [form]);
    // Then: absence of overlap does not move the new form ahead of its prompt.
    expect(merged.map(message => message.id)).toEqual(['original-user', 'databricks-failed', 'cursor-new']);
  });

  it('keeps local history when an empty refresh arrives', () => {
    // Given: all three messages are already visible.
    const current = [prompt, failed, form];
    // When: the snapshot has no messages.
    const merged = mergeServerMessagesIntoConversation(current, []);
    // Then: no history is removed or reordered.
    expect(merged).toEqual(current);
  });

  it('renders a newest page in server order when no history is loaded', () => {
    // Given: no local transcript has been loaded.
    const current: ChatMessage[] = [];
    // When: the server provides its bounded page.
    const merged = mergeServerMessagesIntoConversation(current, [failed, form]);
    // Then: the page remains chronological without inventing older history.
    expect(merged).toEqual([failed, form]);
  });
});
