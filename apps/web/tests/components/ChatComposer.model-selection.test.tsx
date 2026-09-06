// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatComposer } from '../../src/components/ChatComposer';
import {
  MODEL_SELECTION_REQUIRED_EVENT,
  requireModelSelection,
} from '../../src/components/agentModelSelection';
import type { AgentInfo, AppConfig } from '../../src/types';

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => undefined, t: (key: string) => key }),
  useT: () => (key: string) => key,
}));
vi.mock('../../src/state/mcp', () => ({ fetchMcpServers: async () => null }));
vi.mock('../../src/state/projects', () => ({
  listPlugins: async () => [],
  patchProject: async () => null,
}));
vi.mock('../../src/providers/registry', () => ({
  projectRawUrl: () => '',
  uploadProjectFiles: async () => ({ uploaded: [], failed: [] }),
}));

afterEach(cleanup);

const selectedAgent: AgentInfo = {
  id: 'agent-1',
  name: 'Agent',
  bin: 'agent',
  available: true,
  models: [{ id: 'model-1', label: 'Model 1' }],
};

function renderComposer(
  modelSelected: boolean,
  agent: AgentInfo = selectedAgent,
) {
  const config: Pick<AppConfig, 'mode' | 'model' | 'agentId' | 'agentModels'> = {
    mode: 'daemon',
    model: '',
    agentId: agent.id,
    agentModels: modelSelected ? { [agent.id]: { model: 'model-1' } } : {},
  };
  const onSend = vi.fn();
  render(
    <ChatComposer
      projectId="project-1"
      projectFiles={[]}
      streaming={false}
      modelSelectionGuard={() => requireModelSelection(config, [agent])}
      initialDraft="hello"
      onEnsureProject={async () => 'project-1'}
      onSend={onSend}
      onStop={vi.fn()}
    />,
  );
  return onSend;
}

describe('ChatComposer explicit model guard', () => {
  it('blocks button submission and emits visible-feedback signal when unselected', () => {
    const warned = vi.fn();
    window.addEventListener(MODEL_SELECTION_REQUIRED_EVENT, warned, { once: true });
    const onSend = renderComposer(false);

    fireEvent.click(screen.getByTestId('chat-send'));

    expect(onSend).not.toHaveBeenCalled();
    expect(warned).toHaveBeenCalledTimes(1);
  });

  it('blocks Enter when unselected and sends normally after explicit selection', () => {
    const blockedSend = renderComposer(false);
    fireEvent.keyDown(screen.getByTestId('chat-composer-input'), { key: 'Enter' });
    expect(blockedSend).not.toHaveBeenCalled();
    cleanup();

    const selectedSend = renderComposer(true);
    fireEvent.click(screen.getByTestId('chat-send'));
    expect(selectedSend).toHaveBeenCalledTimes(1);
    expect(selectedSend.mock.calls[0]?.[0]).toBe('hello');
  });

  it('sends with a default-only agent because there is no model choice to make', () => {
    const onSend = renderComposer(false, {
      ...selectedAgent,
      id: 'default-only',
      models: [{ id: 'default', label: 'Default' }],
    });

    fireEvent.click(screen.getByTestId('chat-send'));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toBe('hello');
  });
});
