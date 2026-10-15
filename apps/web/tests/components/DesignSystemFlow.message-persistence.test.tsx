// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemDetailView } from '../../src/components/DesignSystemFlow';
import type { AppConfig, ChatMessage, DesignSystemDetail, Project } from '../../src/types';
import { getEn } from '../../src/i18n/locales/en';
import { I18nProvider } from '../../src/i18n';

const mocks = vi.hoisted(() => ({
  createDesignSystemDraft: vi.fn(),
  ensureDesignSystemWorkspace: vi.fn(),
  fetchDesignSystem: vi.fn(),
  fetchDesignSystemRevisions: vi.fn(),
  fetchProjectDesignSystemPackageAudit: vi.fn(),
  fetchProjectFiles: vi.fn(),
  getProject: vi.fn(),
  patchProject: vi.fn(),
  createConversation: vi.fn(),
  listConversations: vi.fn(),
  listMessages: vi.fn(),
  loadTabs: vi.fn(),
  patchConversation: vi.fn(),
  saveMessage: vi.fn(),
  saveTabs: vi.fn(),
  streamViaDaemon: vi.fn(),
  updateDesignSystemDraft: vi.fn(),
  uploadProjectFile: vi.fn(),
  writeProjectTextFile: vi.fn(),
}));

vi.mock('../../src/components/ChatPane', () => ({
  ChatPane: ({
    error,
    onNewConversation,
    onSend,
  }: {
    error?: string | null;
    onNewConversation?: () => void;
    onSend: (prompt: string, attachments: unknown[], commentAttachments: unknown[]) => void;
  }) => (
    <>
      {error ? <div role="alert">{error}</div> : null}
      <button
        type="button"
        data-testid="new-conversation"
        onClick={() => onNewConversation?.()}
      >
        New
      </button>
      <button
        type="button"
        data-testid="design-system-chat-send"
        onClick={() => onSend('Update the design tokens', [], [])}
      >
        send
      </button>
    </>
  ),
}));

vi.mock('../../src/components/FileWorkspace', () => ({
  FileWorkspace: () => <div data-testid="design-system-files" />,
}));

vi.mock('../../src/providers/daemon', () => ({
  streamViaDaemon: (...args: unknown[]) => mocks.streamViaDaemon(...args),
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    createDesignSystemDraft: mocks.createDesignSystemDraft,
    ensureDesignSystemWorkspace: mocks.ensureDesignSystemWorkspace,
    fetchDesignSystem: mocks.fetchDesignSystem,
    fetchDesignSystemRevisions: mocks.fetchDesignSystemRevisions,
    fetchProjectDesignSystemPackageAudit: mocks.fetchProjectDesignSystemPackageAudit,
    fetchProjectFiles: mocks.fetchProjectFiles,
    updateDesignSystemDraft: mocks.updateDesignSystemDraft,
    uploadProjectFile: mocks.uploadProjectFile,
    writeProjectTextFile: mocks.writeProjectTextFile,
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    createConversation: mocks.createConversation,
    getProject: mocks.getProject,
    listConversations: mocks.listConversations,
    listMessages: mocks.listMessages,
    loadTabs: mocks.loadTabs,
    patchConversation: mocks.patchConversation,
    patchProject: mocks.patchProject,
    saveMessage: mocks.saveMessage,
    saveTabs: mocks.saveTabs,
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

beforeEach(() => {
  mocks.fetchDesignSystem.mockResolvedValue(null);
  mocks.fetchDesignSystemRevisions.mockResolvedValue([]);
  mocks.fetchProjectDesignSystemPackageAudit.mockResolvedValue(null);
  mocks.fetchProjectFiles.mockResolvedValue([]);
  mocks.getProject.mockResolvedValue(null);
  mocks.createConversation.mockResolvedValue(null);
  mocks.listConversations.mockResolvedValue([]);
  mocks.listMessages.mockResolvedValue([]);
  mocks.loadTabs.mockResolvedValue({ tabs: [], active: null });
  mocks.patchConversation.mockResolvedValue(null);
  mocks.saveMessage.mockResolvedValue(null);
  mocks.saveTabs.mockResolvedValue(null);
  mocks.streamViaDaemon.mockImplementation(async () => {});
  mocks.updateDesignSystemDraft.mockResolvedValue(null);
  mocks.uploadProjectFile.mockImplementation(async (_projectId: string, file: File, desiredName?: string) => ({
    name: desiredName ?? file.name,
    size: file.size,
    mtime: 1,
    kind: 'code',
    mime: file.type || 'text/plain',
  }));
  mocks.writeProjectTextFile.mockImplementation(async (_projectId: string, name: string) => ({
    name,
    size: 1,
    mtime: 1,
    kind: 'document',
    mime: 'text/markdown',
  }));
});

const system: DesignSystemDetail = {
  id: 'user:acme-design-system',
  title: 'Acme Design System',
  category: 'Custom',
  summary: 'Acme product workspace.',
  swatches: [],
  surface: 'web',
  body: '# Acme Design System\n',
  source: 'user',
  status: 'draft',
  isEditable: true,
  projectId: 'ds-acme-design-system',
};
const project: Project = {
  id: 'ds-acme-design-system',
  name: 'Acme Design System',
  skillId: null,
  designSystemId: system.id,
  createdAt: 1,
  updatedAt: 1,
  metadata: {
    kind: 'other',
    importedFrom: 'design-system',
    entryFile: 'DESIGN.md',
    sourceFileName: system.id,
  },
};
const config: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  baseUrl: '',
  model: '',
  agentId: 'agent-1',
  agentModels: {},
  skillId: null,
  designSystemId: null,
};

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  mocks.fetchDesignSystem.mockResolvedValue(system);
  mocks.ensureDesignSystemWorkspace.mockResolvedValue({ project, files: [] });
  const conversation = { id: 'conv-design-system', projectId: project.id, title: 'Design system', createdAt: 1, updatedAt: 1 };
  mocks.listConversations.mockResolvedValue([conversation]);
  // A send that races the conversation listing creates the same conversation.
  mocks.createConversation.mockResolvedValue(conversation);
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
});

async function sendChatMessage() {
  render(
    <I18nProvider initial="en">
      <DesignSystemDetailView
        id={system.id}
        selectedId={system.id}
        config={config}
        agents={[{ id: 'agent-1', name: 'OpenCode', bin: 'opencode', available: true, models: [] }]}
        onBack={() => {}}
        onSetDefault={() => {}}
      />
    </I18nProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('design-system-chat-send')).toBeTruthy());
  fireEvent.click(screen.getByTestId('design-system-chat-send'));
  await waitFor(() => expect(mocks.saveMessage).toHaveBeenCalled());
  const [projectId, conversationId, message] = mocks.saveMessage.mock.calls[0] as [string, string, ChatMessage];
  expect(projectId).toBe(project.id);
  expect(conversationId).toBe('conv-design-system');
  expect(message.role).toBe('user');
  return message;
}

async function flushMicrotasks() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('DesignSystemDetailView message persistence', () => {
  it.each([
    ['HTTP failure', () => Promise.resolve({ ok: false, status: 500 })],
    ['network failure', () => Promise.resolve({ ok: false, status: null })],
    ['rejected save', () => Promise.reject(new TypeError('connection refused'))],
  ])('surfaces a %s through the chat error and keeps the message', async (_label, impl) => {
    mocks.saveMessage.mockImplementation(impl);
    const message = await sendChatMessage();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(getEn()['chat.messageSaveFailed']);
    // The in-memory message is preserved and handed to the run unchanged.
    await waitFor(() => expect(mocks.streamViaDaemon).toHaveBeenCalled());
    const history = (mocks.streamViaDaemon.mock.calls[0]![0] as { history?: ChatMessage[] }).history;
    expect(history?.some((item) => item.id === message.id)).toBe(true);
    await flushMicrotasks();
    expect(unhandled).toEqual([]);
  });

  it('keeps the chat error clear when the save succeeds', async () => {
    mocks.saveMessage.mockResolvedValue({ ok: true });
    await sendChatMessage();
    await waitFor(() => expect(mocks.streamViaDaemon).toHaveBeenCalled());
    await flushMicrotasks();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(unhandled).toEqual([]);
  });
});
