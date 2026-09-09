// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { App } from '../../src/App';
import type { EntryView } from '../../src/components/EntryView';
import type { ProjectView } from '../../src/components/ProjectView';
import { HubDropToEdit } from '../../src/components/hub/HubDropToEdit';
import type { HubImportFileOutcome } from '../../src/components/hub/drop-to-edit';
import { I18nProvider } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';
import type { AppConfig, Project } from '../../src/types';

const { importSettled } = vi.hoisted(() => ({ importSettled: vi.fn() }));

// Keep the actual drop surface, App callbacks, reconciliation and HTTP adapters.
// Only unrelated entry/workspace contents and startup probes are replaced.
vi.mock('../../src/components/EntryView', () => ({
  EntryView: ({ onImportFile, projects, onDeleteProject }: ComponentProps<typeof EntryView>) => (
    <main>
      <HubDropToEdit onImportFile={async (file) => {
        const outcome = await onImportFile!(file);
        importSettled(outcome);
        return outcome;
      }} />
      {projects.map((project) => (
        <div key={project.id} data-testid={`project-${project.id}`}>
          {project.name}
          <button onClick={() => void onDeleteProject(project.id)}>Delete {project.id}</button>
        </div>
      ))}
    </main>
  ),
}));

vi.mock('../../src/components/ProjectView', () => ({
  ProjectView: ({ project }: ComponentProps<typeof ProjectView>) => (
    <main data-testid="project-view">{project.id}</main>
  ),
}));
vi.mock('../../src/components/NewProjectModal', () => ({ NewProjectModal: () => null }));
vi.mock('../../src/components/pet/PetOverlay', () => ({ PetOverlay: () => null }));
vi.mock('../../src/components/pet/pets', () => ({ migrateCustomPetAtlas: async () => null }));
vi.mock('../../src/components/SettingsDialog', () => ({
  SettingsDialog: () => null,
  switchApiProtocolConfig: (config: AppConfig) => config,
  updateCurrentApiProtocolConfig: (config: AppConfig) => config,
}));
vi.mock('../../src/providers/registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/providers/registry')>(),
  daemonIsLive: async () => true,
  fetchAgentsStream: async () => [],
  fetchAppVersionInfo: async () => null,
  fetchDesignSystems: async () => [],
  fetchDesignTemplates: async () => [],
  fetchSkills: async () => [],
}));
vi.mock('../../src/state/config', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/state/config')>(),
  fetchDaemonConfig: async () => ({}),
  loadConfig: () => ({
    mode: 'daemon', apiKey: '', apiProtocol: 'anthropic', apiVersion: '',
    baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5',
    apiProviderBaseUrl: 'https://api.anthropic.com', apiProtocolConfigs: {},
    agentId: 'codex', skillId: null, designSystemId: null,
    onboardingCompleted: true, privacyDecisionAt: 1778244000000,
    agentModels: {}, agentCliEnv: {},
  } satisfies AppConfig),
  mergeDaemonConfig: (local: AppConfig) => local,
  saveConfig: () => {},
  syncConfigToDaemon: async () => {},
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Only a failure deadline, never a sleep or polling interval. Subscribe before
// triggering the event; tests control when each HTTP response is delivered.
async function signal<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Expected event did not arrive')), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const project: Project = {
  id: 'drop-project', name: 'report', skillId: null, designSystemId: null,
  createdAt: 1, updatedAt: 1,
  metadata: { kind: 'other', importedFrom: 'file', sourceFileName: 'report.html' },
};

function harness() {
  const listStarted = deferred<void>();
  const createStarted = deferred<void>();
  const uploadStarted = deferred<void>();
  const deleteStarted = deferred<void>();
  const listReply = deferred<Response>();
  const createReply = deferred<Response>();
  const uploadReply = deferred<Response>();
  const deleteReply = deferred<Response>();
  const outcome = deferred<HubImportFileOutcome>();
  importSettled.mockImplementation(outcome.resolve);
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === '/api/projects' && init?.method === 'POST') {
      createStarted.resolve();
      return createReply.promise;
    }
    if (url === '/api/projects') {
      listStarted.resolve();
      return listReply.promise;
    }
    if (url === `/api/projects/${project.id}/files` && init?.method === 'POST') {
      uploadStarted.resolve();
      return uploadReply.promise;
    }
    if (url === `/api/projects/${project.id}` && init?.method === 'DELETE') {
      deleteStarted.resolve();
      return deleteReply.promise;
    }
    return Promise.resolve(Response.json({}));
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock, listStarted, createStarted, uploadStarted, deleteStarted,
    listReply, createReply, uploadReply, deleteReply, outcome,
  };
}

type Harness = ReturnType<typeof harness>;

async function startImport(h: Harness, name = 'report.html') {
  render(<I18nProvider initial="en"><App /></I18nProvider>);
  await act(async () => {
    await signal(h.listStarted.promise);
  });
  const file = new File(['document'], name, { type: name.endsWith('.md') ? 'text/markdown' : 'text/html' });
  await act(async () => {
    fireEvent.drop(screen.getByTestId('hub-drop-to-edit'), {
      dataTransfer: { files: [file], types: ['Files'] },
    });
    await signal(h.createStarted.promise);
    h.createReply.resolve(Response.json({ project, conversationId: 'drop-conversation' }));
    await signal(h.uploadStarted.promise);
  });
  return file;
}

async function failUpload(h: Harness) {
  await act(async () => {
    h.uploadReply.resolve(Response.json({ error: 'injected-upload-503' }, { status: 503 }));
    await signal(h.deleteStarted.promise);
  });
  expect(screen.getByTestId('hub-drop-to-edit').getAttribute('data-state')).toBe('busy');
  expect(importSettled).not.toHaveBeenCalled();
}

async function deliverStaleList(h: Harness) {
  await act(async () => {
    h.listReply.resolve(Response.json({ projects: [project] }));
    await signal(h.listReply.promise);
  });
}

function expectExactlyOnce(h: Harness, file: File, deletes: number) {
  const calls = h.fetchMock.mock.calls;
  const creates = calls.filter(([url, init]) => url === '/api/projects' && init?.method === 'POST');
  const uploads = calls.filter(([url, init]) => url === `/api/projects/${project.id}/files` && init?.method === 'POST');
  expect(creates).toHaveLength(1);
  expect(uploads).toHaveLength(1);
  expect((uploads[0]![1]!.body as FormData).get('file')).toBe(file);
  expect(calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(deletes);
  expect(importSettled).toHaveBeenCalledTimes(1);
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('App drop-to-edit rollback', () => {
  it.each(['before', 'after'] as const)('reconciles a stale list delivered %s rollback completes without leaving a ghost', async (listOrder) => {
    const h = harness();
    const file = await startImport(h);
    await failUpload(h);
    if (listOrder === 'before') await deliverStaleList(h);
    await act(async () => {
      h.deleteReply.resolve(new Response(null, { status: 204 }));
      expect(await signal(h.outcome.promise)).toEqual({ ok: false });
    });
    if (listOrder === 'after') await deliverStaleList(h);

    expect(screen.queryByTestId(`project-${project.id}`)).toBeNull();
    expect(screen.queryByTestId('project-view')).toBeNull();
    expect(window.location.pathname).toBe('/');
    expect(screen.getByRole('alert').querySelector('.readable-toast-message')?.textContent).toBe(en['hub.dropImportFailed']);
    expect(screen.getByTestId('hub-drop-to-edit').getAttribute('data-state')).toBe('idle');
    expectExactlyOnce(h, file, 1);
  });

  it.each(['http', 'network'] as const)('exposes a %s rollback failure and retains the real project for manual deletion', async (failure) => {
    const h = harness();
    const file = await startImport(h);
    await failUpload(h);
    await act(async () => {
      if (failure === 'http') {
        h.deleteReply.resolve(Response.json({ error: 'injected-delete-503' }, { status: 503 }));
      } else {
        h.deleteReply.reject(new Error('injected-delete-network-failure'));
      }
      expect(await signal(h.outcome.promise)).toMatchObject({ ok: false, message: expect.stringContaining(project.id) });
    });
    // Even before a list exposes it, failed rollback must not hide a real row.
    expect(screen.getByTestId(`project-${project.id}`)).toBeTruthy();
    await deliverStaleList(h);
    expect(screen.getByTestId(`project-${project.id}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: `Delete ${project.id}` })).toBeTruthy();
    const alert = screen.getByRole('alert');
    expect(alert.querySelector('.readable-toast-message')?.textContent).toBe(en['hub.dropImportFailed']);
    expect(alert.querySelector('.readable-toast-details')?.textContent).toContain(project.id);
    expect(window.location.pathname).toBe('/');
    expectExactlyOnce(h, file, 1);
  });

  it.each(['report.html', 'notes.md'])('imports %s exactly once and opens the uploaded file', async (name) => {
    const h = harness();
    const file = await startImport(h, name);
    // A repeated drop while the upload is pending must not create a second project.
    fireEvent.drop(screen.getByTestId('hub-drop-to-edit'), {
      dataTransfer: { files: [file], types: ['Files'] },
    });
    await act(async () => {
      h.uploadReply.resolve(Response.json({ file: { name, size: file.size, modifiedAt: 1 } }));
      expect(await signal(h.outcome.promise)).toEqual({ ok: true });
    });
    await deliverStaleList(h);
    expect(window.location.pathname).toBe(`/projects/${project.id}/files/${name}`);
    expect(screen.queryByRole('alert')).toBeNull();
    expectExactlyOnce(h, file, 0);
  });
});
