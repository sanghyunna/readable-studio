// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { AssistantMessage } from '../../src/components/AssistantMessage';
import { createBufferedTextUpdates } from '../../src/components/ProjectView';
import type { ChatMessage } from '../../src/types';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('captured Codex daemon events aggregate into separate summary paragraphs without duplicated snapshots', () => {
  const wire = readFileSync(resolve(process.cwd(), '../../mocks/fixtures/thinking-claude-codex/codex-luna-index.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const summaries = wire.filter(frame => frame.method === 'item/completed' && frame.params.item.type === 'reasoning').map(frame => frame.params.item.summary as string[]);
  const events = JSON.parse(readFileSync(resolve(process.cwd(), '../../mocks/golden/codex-luna-index.events.json'), 'utf8')) as { type: string; delta?: string }[];
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  let message: ChatMessage = { id: 'codex-capture', role: 'assistant', content: '', events: [], createdAt: 1 };
  const buffer = createBufferedTextUpdates({ updateMessage: update => { message = update(message); }, persistSoon: () => {} });
  try {
    for (const event of events) {
      if (event.type === 'thinking_delta') buffer.appendEvent({ kind: 'thinking', text: event.delta! });
      if (event.type === 'text_delta') { buffer.appendContent(event.delta!); buffer.appendEvent({ kind: 'text', text: event.delta! }); }
    }
    buffer.flush();
    const view = render(<AssistantMessage message={message} streaming={false} projectId="fixture" />);
    view.container.querySelectorAll('.thinking-toggle').forEach(toggle => fireEvent.click(toggle));
    const bodies = [...view.container.querySelectorAll('.thinking-body')];
    expect(bodies).toHaveLength(summaries.length);
    expect(bodies.map(body => [...body.querySelectorAll('p')].map(p => p.textContent)))
      .toEqual(summaries.map(parts => parts.map(part => part.replaceAll('**', ''))));
  } finally { buffer.cancel(); }
});

test('thinking before any prose and after buffered prose survives projection and renders as separate expandable blocks', () => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  let message: ChatMessage = { id: 'thinking-order', role: 'assistant', content: '', events: [], createdAt: 1 };
  const buffer = createBufferedTextUpdates({ updateMessage: update => { message = update(message); }, persistSoon: () => {} });
  try {
    buffer.appendEvent({ kind: 'thinking', text: 'EARLY_REASONING_SENTINEL' });
    expect(message.content).toBe('');
    expect(message.events).toEqual([{ kind: 'thinking', text: 'EARLY_REASONING_SENTINEL' }]);
    buffer.appendContent('ANSWER_SENTINEL');
    buffer.appendEvent({ kind: 'text', text: 'ANSWER_SENTINEL' });
    buffer.appendEvent({ kind: 'thinking', text: 'LATE_REASONING_SENTINEL' });
    buffer.flush();
    expect(message.events?.map(event => event.kind)).toEqual(['thinking', 'text', 'thinking']);
    const view = render(<AssistantMessage message={message} streaming={false} projectId="fixture" />);
    const toggles = view.container.querySelectorAll('.thinking-toggle');
    expect(toggles.length).toBe(2);
    toggles.forEach(toggle => fireEvent.click(toggle));
    // Markdown underscores are emphasis delimiters, not literal DOM text.
    expect([...view.container.querySelectorAll('.thinking-body')].map(body => body.textContent))
      .toEqual(['EARLYREASONINGSENTINEL', 'LATEREASONINGSENTINEL']);
  } finally { buffer.cancel(); }
});
