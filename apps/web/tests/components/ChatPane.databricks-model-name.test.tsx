// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { forwardRef, type ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatPane } from '../../src/components/ChatPane';
import type { ChatComposer } from '../../src/components/ChatComposer';
import type { AgentInfo, ChatMessage } from '../../src/types';

// Keep the real ChatPane -> AssistantMessage path; only the editor is irrelevant.
vi.mock('../../src/components/ChatComposer', () => ({
  ChatComposer: forwardRef<HTMLDivElement, ComponentProps<typeof ChatComposer>>(
    function Composer(_props, ref) { return <div ref={ref} />; },
  ),
}));
afterEach(cleanup);

it('resolves saved model ids after catalogue load without changing the saved message', () => {
  const id = `dbm_${'d'.repeat(32)}`;
  const saved: ChatMessage = JSON.parse(JSON.stringify({
    id: 'saved', role: 'assistant', content: 'done', agentId: 'databricks',
    agentName: `Databricks · ${id}`, runStatus: 'succeeded',
  }));
  const before = JSON.stringify(saved);
  const props: ComponentProps<typeof ChatPane> = {
    messages: [saved], streaming: false, error: null, projectId: 'p', projectFiles: [],
    onEnsureProject: async () => 'p', onSend: vi.fn(), onStop: vi.fn(),
    conversations: [], activeConversationId: 'c', onSelectConversation: vi.fn(), onDeleteConversation: vi.fn(),
  };
  const agent: AgentInfo = {
    id: 'databricks', name: 'Databricks', bin: 'databricks', available: true,
    modelManagement: 'databricks', models: [{ id, label: 'databricks-claude-opus-5-5' }],
  };
  const view = render(<ChatPane {...props} agents={[]} />);
  expect(view.container.querySelector('.role-model')?.textContent).toBe(id);
  view.rerender(<ChatPane {...props} agents={[agent]} />);
  expect(view.container.querySelector('.role-model')?.textContent).toBe('databricks-claude-opus-5-5');
  expect(view.container.querySelector('.role-model')?.getAttribute('title')).not.toContain('dbm_');
  expect(JSON.stringify(saved)).toBe(before);
});
