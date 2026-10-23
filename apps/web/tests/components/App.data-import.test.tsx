// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../src/App';
import { I18nProvider } from '../../src/i18n';
import { DEFAULT_CONFIG } from '../../src/state/config';

vi.mock('../../src/router', () => ({ navigate: vi.fn(), useRoute: () => ({ kind: 'home', view: 'home' }) }));
vi.mock('../../src/components/EntryView', () => ({ EntryView: ({ onOpenSettings }: { onOpenSettings: (section: string) => void }) => <button onClick={() => onOpenSettings('projectLocations')}>Open settings</button> }));
vi.mock('../../src/components/hub/HubRail', () => ({ HubRail: () => null }));
vi.mock('../../src/components/hub/HubRailOverlays', () => ({ HubRailOverlays: () => null }));
vi.mock('../../src/components/ProjectView', () => ({ ProjectView: () => null }));
vi.mock('../../src/components/pet/PetOverlay', () => ({ PetOverlay: () => null }));
vi.mock('../../src/components/MemoryToast', () => ({ MemoryToast: () => null }));
vi.mock('../../src/components/OneDriveNotice', () => ({ OneDriveNotice: () => null }));
vi.mock('../../src/components/WelcomeModal', () => ({ SHOW_DELAY_MS: 0, WelcomeModal: () => null }));
vi.mock('../../src/components/UpdateSection', () => ({ UpdateLaunchBanner: () => null, UpdateSection: () => null }));
vi.mock('../../src/providers/registry', async original => ({ ...await original<typeof import('../../src/providers/registry')>(),
  daemonIsLive: vi.fn(async () => true), fetchAgentsStream: vi.fn(async () => []), fetchAppVersionInfo: vi.fn(async () => null),
  fetchDesignSystems: vi.fn(async () => []), fetchDesignTemplates: vi.fn(async () => []), fetchSkills: vi.fn(async () => []),
}));
vi.mock('../../src/state/projects', async original => ({ ...await original<typeof import('../../src/state/projects')>(),
  listProjects: vi.fn(async () => []), listTemplates: vi.fn(async () => []),
}));
vi.mock('../../src/state/config', async original => ({ ...await original<typeof import('../../src/state/config')>(),
  fetchDaemonConfig: vi.fn(async () => ({})), mergeDaemonConfig: vi.fn(local => local),
  loadConfig: vi.fn(() => ({ ...DEFAULT_CONFIG, onboardingCompleted: true })), syncConfigToDaemon: vi.fn(async () => undefined), saveConfig: vi.fn(),
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('keeps one shared import dialog when startup discovery returns after manual settings discovery', async () => {
  let finishStartup!: (response: Response) => void;
  let finishImport!: (response: Response) => void;
  const startup = new Promise<Response>(done => { finishStartup = done; });
  const importing = new Promise<Response>(done => { finishImport = done; });
  const candidate = { sourceRoot: 'D:\\Manual', sourceData: 'D:\\Manual\\data', projectCount: 2, modifiedAt: '2026-10-01T00:00:00Z' };
  const fetcher = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input);
    if (url === '/api/data-import/candidates') return startup;
    if (url === '/api/data-import/candidates?manual=1') return Promise.resolve(Response.json({ state: 'offered', candidates: [candidate] }));
    if (url === '/api/data-import/request') return JSON.parse(String(options?.body)).action === 'import'
      ? importing : Promise.resolve(Response.json({ state: 'declined', restartRequired: false }));
    return Promise.resolve(Response.json({}));
  });
  vi.stubGlobal('fetch', fetcher);
  await act(async () => { render(<I18nProvider initial="ko"><App /></I18nProvider>); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open settings' })); });
  const importButton = await screen.findByRole('button', { name: '이전 버전 데이터 가져오기' });
  await act(async () => { fireEvent.click(importButton); });
  expect(screen.getAllByTestId('data-import-modal')).toHaveLength(1);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^가져오기$/ })); });
  await act(async () => { finishStartup(Response.json({ state: 'offered', candidates: [{ ...candidate, sourceRoot: 'D:\\Startup' }] })); });
  expect(screen.getAllByTestId('data-import-modal')).toHaveLength(1);
  expect(screen.queryByText('D:\\Startup')).toBeNull();
  expect(screen.getByText(candidate.sourceRoot)).toBeTruthy();
  expect(screen.getByRole('button', { name: '준비 중...' }).hasAttribute('disabled')).toBe(true);
  await act(async () => { finishImport(Response.json({ state: 'pending', restartRequired: true })); });
  expect(screen.getByRole('button', { name: '다시 시작하기' })).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^가져오지 않기$/ })); });
  expect(screen.queryByTestId('data-import-modal')).toBeNull();
  await act(async () => { fireEvent.click(importButton); });
  expect(fetcher.mock.calls.filter(call => String(call[0]).includes('?manual=1'))).toHaveLength(2);
  expect(screen.getAllByTestId('data-import-modal')).toHaveLength(1);
});
