import { describe, expect, it } from 'vitest';
import type { PluginLoopSubmit } from '../../src/components/PluginLoopHome';

// The hub no longer has a bare-prompt submission builder. HomeView owns the
// stateful values and emits this normalized boundary contract to EntryShell.
describe('hub composer submission boundary', () => {
  it('requires every normalized field and the four-value project kind', () => {
    const payload = {
      prompt: '',
      pluginId: null,
      pluginType: null,
      skillId: 'qa-skill',
      appliedPluginSnapshotId: null,
      pluginTitle: null,
      taskKind: null,
      pluginInputs: { prompt: '' },
      contextPlugins: [],
      contextMcpServers: [],
      designSystemId: 'qa-design-system',
      projectKind: 'other',
      projectMetadata: { kind: 'other' },
      conversationMode: 'chat',
      attachments: [],
      autoSendFirstMessage: false,
      examplePromptContext: null,
    } satisfies PluginLoopSubmit;

    expect(payload).toMatchObject({
      skillId: 'qa-skill',
      designSystemId: 'qa-design-system',
      projectKind: 'other',
      conversationMode: 'chat',
      autoSendFirstMessage: false,
    });
    expect(payload.pluginId).toBeNull();
    expect(payload.pluginInputs).toEqual({ prompt: '' });
  });
});
