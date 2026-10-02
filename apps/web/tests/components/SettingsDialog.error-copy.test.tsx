// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { testAgent, testApiProvider, fetchModels } = vi.hoisted(() => ({ testAgent: vi.fn(), testApiProvider: vi.fn(), fetchModels: vi.fn() }));
vi.mock('../../src/providers/connection-test', () => ({ testAgent, testApiProvider }));
vi.mock('../../src/providers/provider-models', () => ({ fetchProviderModels: fetchModels }));
import { SettingsDialog } from '../../src/components/SettingsDialog';
import { I18nProvider } from '../../src/i18n';
import { getKo } from '../../src/i18n/locales/ko';
import { getEn } from '../../src/i18n/locales/en';
import type { AppConfig } from '../../src/types';
const config: AppConfig = { mode: 'api', apiKey: 'sk-ant-test', apiProtocol: 'anthropic', apiVersion: '', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', apiProviderBaseUrl: 'https://api.anthropic.com', apiProtocolConfigs: {}, agentId: 'codex', skillId: null, designSystemId: null, onboardingCompleted: true, agentModels: {}, agentCliEnv: {} };
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
function renderSettings(cli: boolean) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}))));
  render(<I18nProvider initial="ko"><SettingsDialog initial={{ ...config, mode: cli ? 'daemon' : 'api' }} agents={[{ id: 'codex', name: 'Codex CLI', bin: 'codex', available: true, models: [{ id: 'default', label: 'Default' }] }]} daemonLive appVersionInfo={null} initialSection="execution" onPersist={vi.fn()} onClose={vi.fn()} onRefreshAgents={vi.fn()} /></I18nProvider>);
}
describe('Settings Korean request failure copy', () => {
  it.each([
    ['cli', false], ['api', false], ['cli', true], ['api', true],
  ] as const)('%s localizes test failure (technical error: %s)', async (mode, technical) => {
    const raw = 'Test request failed';
    testAgent.mockRejectedValue(technical ? new Error(raw) : null);
    testApiProvider.mockRejectedValue(technical ? new Error(raw) : null);
    fetchModels.mockResolvedValue({ ok: true, latencyMs: 0, models: [] });
    await act(async () => { renderSettings(mode === 'cli'); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: getKo()['settings.test'] })); });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(getKo()['settings.testUnknown'].replace('{detail}', technical ? raw : getKo()['settings.testRequestFailed']));
    expect(alert.textContent?.startsWith(raw)).toBe(false);
    if (!technical) expect(alert.textContent).not.toContain(getEn()['settings.testRequestFailed']);
  });
  it.each([false, true])('localizes model failure through automatic discovery (technical error: %s)', async (technical) => {
    const raw = 'Model list request failed';
    // Subscribe to the request before mounting; await the exact invocation, not a polling delay.
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    fetchModels.mockImplementation(async () => { requestStarted(); throw technical ? new Error(raw) : null; });
    testApiProvider.mockResolvedValue({ ok: true, latencyMs: 0 });
    await act(async () => { renderSettings(false); });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await act(async () => {
        await Promise.race([started, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Model request not started')), 2000); })]);
      });
    } finally { clearTimeout(timeout); }
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(getKo()['settings.fetchModelsFailed'].replace('{detail}', technical ? raw : getKo()['settings.modelListRequestFailed']));
    expect(alert.textContent?.startsWith(raw)).toBe(false);
    if (!technical) expect(alert.textContent).not.toContain(getEn()['settings.modelListRequestFailed']);
  });
});
