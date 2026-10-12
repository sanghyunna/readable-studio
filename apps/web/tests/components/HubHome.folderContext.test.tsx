// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/App';
import { homeHeroPromptText, setHomeHeroPrompt } from '../helpers/home-hero-lexical';
import { isReadableStudioHostAvailable, pickAndImportHostProject } from '@readable-studio/host';
import { importFolderProject, listTemplates, pickLocalFolderPath } from '../../src/state/projects';
import { loadConfig } from '../../src/state/config';
import { MODEL_SELECTION_REQUIRED_EVENT } from '../../src/components/agentModelSelection';

vi.mock('../../src/components/InlineModelSwitcher', () => ({ InlineModelSwitcher: () => null }));
vi.mock('../../src/components/DesignsTab', () => ({ DesignsTab: () => null }));
vi.mock('../../src/components/DesignSystemPreviewModal', () => ({ DesignSystemPreviewModal: () => null }));
vi.mock('../../src/components/DesignSystemsTab', () => ({ DesignSystemsTab: () => null }));
vi.mock('../../src/components/IntegrationsView', () => ({ IntegrationsView: () => null }));
vi.mock('../../src/components/PluginsView', () => ({ PluginsView: () => null }));
vi.mock('../../src/components/TasksView', () => ({ TasksView: () => null }));
vi.mock('../../src/components/ProjectView', () => ({ ProjectView: () => <main data-testid="created-workspace" /> }));
vi.mock('../../src/components/pet/PetOverlay', () => ({ PetOverlay: () => null }));
vi.mock('../../src/components/pet/pets', () => ({ migrateCustomPetAtlas: async () => null }));
vi.mock('../../src/hooks/useRuntimeUser', () => ({ useRuntimeUsername: () => null }));
vi.mock('@readable-studio/host', async (original) => ({
  ...await original<typeof import('@readable-studio/host')>(),
  isReadableStudioHostAvailable: vi.fn(() => false), pickAndImportHostProject: vi.fn(),
}));
vi.mock('../../src/providers/registry', async (original) => ({
  ...await original<typeof import('../../src/providers/registry')>(),
  daemonIsLive: async () => true, fetchAgentsStream: async () => [], fetchSkills: async () => [],
  fetchDesignTemplates: async () => [], fetchDesignSystems: async () => [], fetchAppVersionInfo: async () => null,
}));
vi.mock('../../src/state/config', async (original) => ({
  ...await original<typeof import('../../src/state/config')>(),
  loadConfig: vi.fn(() => ({ mode: 'api', apiKey: '', baseUrl: '', model: 'qa-model', agentId: null, skillId: null, designSystemId: null, onboardingCompleted: true })),
  fetchDaemonConfig: async () => ({}), saveConfig: vi.fn(), syncConfigToDaemon: async () => undefined,
}));
vi.mock('../../src/state/projects', async (original) => ({
  ...await original<typeof import('../../src/state/projects')>(),
  listProjects: async () => [], listTemplates: vi.fn(async () => []), getProject: async () => workspace,
  pickLocalFolderPath: vi.fn(), importFolderProject: vi.fn(),
}));

const workspace = { id: 'workspace-1', name: 'Draft', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 1 };
const session = { id: 'session-1', projectId: workspace.id, title: 'Draft', createdAt: 1, updatedAt: 1 };
const folder = { id: 'folder-1', name: 'SGI', createdAt: 1, updatedAt: 1, sessions: [] };
let requests: Array<{ url: string; init?: RequestInit }>;

beforeEach(() => {
  requests = [];
  vi.mocked(listTemplates).mockResolvedValue([]);
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.localStorage.setItem('readable-studio:locale', 'ko');
  window.localStorage.setItem('readable-studio:welcome-modal-shown', '1');
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => { queueMicrotask(callback); return 1; });
  vi.stubGlobal('cancelIdleCallback', () => {});
  vi.mocked(isReadableStudioHostAvailable).mockReturnValue(false);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    const payload = url === '/api/rail' ? { folders: [folder], recents: [], pinned: [], generatedAt: 1 }
      : url === '/api/sessions' ? { workspace, session }
      : url === '/api/import/claude-design' ? { project: workspace, conversationId: session.id, entryFile: 'index.html' }
      : url === `/api/sessions/${session.id}` ? { session: { ...session, folderId: folder.id } }
      : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function startInFolder() {
  await act(async () => { render(<App />); });
  await act(async () => { fireEvent.click(await screen.findByTestId('hub-new-session-folder-1')); });
  expect(document.activeElement).toBe(screen.getByTestId('home-hero-input'));
  expect(screen.getByTestId('home-hero-folder-chip').textContent).toContain(folder.name);
}
async function openPlus() {
  await act(async () => { fireEvent.click(screen.getByTestId('home-hero-plus-trigger')); });
}

describe('Hub folder context', () => {
  it('selected-folder saved template reaches the actual session HTTP body', async () => {
    vi.mocked(listTemplates).mockResolvedValue([{
      id: 'saved',
      name: 'Saved starter',
      description: '',
      files: [{ name: 'index.html', content: '<h1>Saved</h1>' }],
      createdAt: 1,
    }]);
    await startInFolder();
    await openPlus();
    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-plus-templates'));
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId('composer-plus-template-saved'));
    });
    await screen.findByTestId('created-workspace');

    const posts = requests.filter(({ url, init }) =>
      url === '/api/sessions' && init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]!.init!.body))).toMatchObject({
      folderId: folder.id,
      conversationMode: 'design',
      metadata: { kind: 'template', templateId: 'saved' },
      selection: { agentId: null, agentModels: {} },
    });
    expect(window.location.pathname).toBe('/projects/workspace-1/conversations/session-1');
  });

  it('missing model prevents POST and preserves the selected-folder draft', async () => {
    vi.mocked(loadConfig).mockReturnValueOnce({ ...loadConfig(), model: '' });
    await startInFolder();
    const input = screen.getByTestId('home-hero-input');
    const draft = 'Keep this selected-folder draft until I choose a model';
    setHomeHeroPrompt(draft);

    const required = vi.fn();
    window.addEventListener(MODEL_SELECTION_REQUIRED_EVENT, required, { once: true });
    try {
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
      });
      expect(required).toHaveBeenCalledOnce();
      expect(requests.filter(({ url, init }) =>
        url === '/api/sessions' && init?.method === 'POST')).toHaveLength(0);
      expect(homeHeroPromptText()).toBe(draft);
      expect(screen.getByTestId('home-hero-input')).toBe(input);
      expect(screen.getByTestId('home-hero-folder-chip').textContent).toContain(folder.name);
      expect(window.location.pathname).toBe('/');
      expect(window.sessionStorage.getItem('readable:auto-send-first:workspace-1')).toBeNull();
      expect(window.sessionStorage.getItem('readable:auto-send-attachments:workspace-1')).toBeNull();
    } finally {
      window.removeEventListener(MODEL_SELECTION_REQUIRED_EVENT, required);
    }
  });

  it.each([false, true])('deferred new-session focus respects ownership (changed=%s)', async (changed) => {
    await startInFolder();
    const input = screen.getByTestId('home-hero-input');
    const gate = screen.getByTestId('hub-composer');
    const trigger = screen.getByTestId('hub-new-session');
    gate.setAttribute('inert', '');
    trigger.focus();

    await act(async () => { fireEvent.click(trigger); });
    expect(gate.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(trigger);

    const owner = screen.getByTestId('hub-search');
    if (changed) {
      owner.focus();
      expect(document.activeElement).toBe(owner);
    }
    const opened = new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        if (!gate.hasAttribute('inert')) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(gate, { attributes: true, attributeFilter: ['inert'] });
    });
    await act(async () => {
      gate.removeAttribute('inert');
      await opened;
    });
    expect(document.activeElement).toBe(changed ? owner : input);
  }, 10000);

  it.each([true, false])('Enter POSTs a session in the selected folder or standalone (selected=%s)', async (selected) => {
    await startInFolder();
    if (!selected) {
      await act(async () => { fireEvent.click(screen.getByTestId('home-hero-folder-chip-remove')); });
      expect(screen.queryByTestId('home-hero-folder-chip')).toBeNull();
    }
    setHomeHeroPrompt('Write a report for this session');
    await act(async () => { fireEvent.keyDown(screen.getByTestId('home-hero-input'), { key: 'Enter', keyCode: 13 }); });
    await screen.findByTestId('created-workspace');
    const post = requests.find(({ url, init }) => url === '/api/sessions' && init?.method === 'POST');
    expect(JSON.parse(String(post!.init!.body)).folderId).toBe(selected ? folder.id : null);
    expect(window.location.pathname).toBe('/projects/workspace-1/conversations/session-1');
    expect(window.sessionStorage.getItem('readable:auto-send-first:workspace-1')).toBe('1');
  });

  it('the new-session row clears context and leaves the caret in the composer', async () => {
    await startInFolder();
    await act(async () => { fireEvent.click(screen.getByTestId('hub-new-session')); });
    expect(document.activeElement).toBe(screen.getByTestId('home-hero-input'));
    expect(screen.queryByTestId('home-hero-folder-chip')).toBeNull();
  });

  it('folder import carries the selected folder', async () => {
    vi.mocked(pickLocalFolderPath).mockResolvedValue('D:/drafts');
    vi.mocked(importFolderProject).mockResolvedValue({ project: workspace, conversationId: session.id, entryFile: null });
    await startInFolder();
    await openPlus();
    await act(async () => { fireEvent.click(screen.getByTestId('composer-plus-open-folder')); });
    expect(importFolderProject).toHaveBeenCalledWith({ baseDir: 'D:/drafts', folderId: folder.id });
    expect(window.location.pathname).toBe('/projects/workspace-1/conversations/session-1');
  });

  it('desktop import moves its seeded session into the selected folder without changing workspace', async () => {
    vi.mocked(isReadableStudioHostAvailable).mockReturnValue(true);
    vi.mocked(pickAndImportHostProject).mockResolvedValue({ ok: true, projectId: workspace.id, conversationId: session.id, entryFile: null });
    await startInFolder();
    await openPlus();
    await act(async () => { fireEvent.click(screen.getByTestId('composer-plus-open-folder')); });
    const patch = requests.find(({ url, init }) => url === '/api/sessions/session-1' && init?.method === 'PATCH');
    expect(JSON.parse(String(patch!.init!.body))).toEqual({ folderId: folder.id });
    expect(window.location.pathname).toBe('/projects/workspace-1/conversations/session-1');
  });

  it('ZIP import carries the folder as a multipart field', async () => {
    await startInFolder();
    await openPlus();
    await act(async () => { fireEvent.click(screen.getByTestId('composer-plus-import-claude-zip')); });
    const file = new File(['zip'], 'design.zip', { type: 'application/zip' });
    await act(async () => { fireEvent.change(screen.getByTestId('composer-plus-import-claude-zip-input'), { target: { files: [file] } }); });
    const post = requests.find(({ url }) => url === '/api/import/claude-design');
    expect((post!.init!.body as FormData).get('folderId')).toBe(folder.id);
    expect((post!.init!.body as FormData).get('file')).toBe(file);
    expect(window.location.pathname).toContain('/projects/workspace-1/conversations/session-1');
  });
});
