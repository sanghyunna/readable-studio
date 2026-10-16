// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import { DatabricksLoginButton } from '../../src/components/databricks/DatabricksLoginButton';
import type { DatabricksManagedLoginStart } from '@readable-studio/contracts';

const client = vi.hoisted(() => ({ startDatabricksLogin: vi.fn(), fetchDatabricksLogin: vi.fn(), cancelDatabricksLogin: vi.fn(), fetchDatabricksStatus: vi.fn() }));
const refresh = vi.hoisted(() => vi.fn(async () => []));
const openExternal = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../src/providers/databricks', async importOriginal => ({ ...await importOriginal<typeof import('../../src/providers/databricks')>(), ...client }));
vi.mock('../../src/components/databricksModels', () => ({ refreshDatabricksModels: refresh }));
vi.mock('../../src/providers/registry', () => ({ openExternalUrl: openExternal }));
beforeEach(() => {
  vi.clearAllMocks();
  client.startDatabricksLogin.mockResolvedValue({ state: 'started', loginId: 'job-1' });
  client.fetchDatabricksLogin.mockResolvedValue({ state: 'waiting-browser' });
  client.cancelDatabricksLogin.mockResolvedValue({ state: 'cancelled' });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function mount(props: Parameters<typeof DatabricksLoginButton>[0] = {}) {
  return render(<I18nProvider initial="ko"><DatabricksLoginButton {...props} /></I18nProvider>);
}
async function clickLogin() { await act(async () => { fireEvent.click(screen.getByTestId('databricks-login-start')); }); }

describe('shared Databricks one-click login', () => {
  it.each(['escape', 'close'] as const)('restores the invoking button after %s following the needs-input transition', async method => {
    let finish!: (result: DatabricksManagedLoginStart) => void;
    client.startDatabricksLogin.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    mount();
    const trigger = screen.getByTestId('databricks-login-start');
    await clickLogin();
    await act(async () => { finish({ state: 'needs-input' }); });
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => {
      if (method === 'escape') fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      else fireEvent.click(within(dialog).getAllByRole('button', { name: '닫기' })[0]!);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it('contains focus during the dialog and wraps Tab in both directions', async () => {
    client.startDatabricksLogin.mockResolvedValueOnce({ state: 'needs-input' });
    mount();
    await clickLogin();
    const dialog = screen.getByRole('dialog');
    const buttons = within(dialog).getAllByRole('button');
    const first = buttons[0]!, last = buttons[buttons.length - 1]!;
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    screen.getByTestId('databricks-login-start').focus();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
  it('starts with no URL prompt when the daemon already knows a default', async () => {
    mount();
    await clickLogin();
    expect(client.startDatabricksLogin).toHaveBeenCalledExactlyOnceWith({ host: undefined, profile: undefined });
    expect(screen.getByRole('status').textContent).toContain('브라우저에서 로그인을 완료해 주세요');
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('asks for a workspace and optional DEFAULT profile, validates HTTPS, and normalizes the origin', async () => {
    client.startDatabricksLogin.mockResolvedValueOnce({ state: 'needs-input' });
    mount();
    await clickLogin();
    const dialog = screen.getByRole('dialog');
    const workspace = within(dialog).getByRole('textbox', { name: '워크스페이스 URL' });
    const profile = within(dialog).getByRole('textbox', { name: '프로필 이름 (선택)' });
    expect((profile as HTMLInputElement).value).toBe('');
    fireEvent.change(workspace, { target: { value: 'http://workspace.example' } });
    await act(async () => { fireEvent.submit(workspace.closest('form')!); });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(client.startDatabricksLogin).toHaveBeenCalledTimes(1);
    fireEvent.change(workspace, { target: { value: ' https://WORKSPACE.example/ ' } });
    fireEvent.change(profile, { target: { value: 'team-dev' } });
    await act(async () => { fireEvent.submit(workspace.closest('form')!); });
    expect(client.startDatabricksLogin).toHaveBeenLastCalledWith({ host: 'https://workspace.example', profile: 'team-dev' });
  });
  it('passes an arbitrary update-server host directly and displays a copyable browser fallback URL', async () => {
    const authUrl = 'https://workspace.example/oauth/authorize?state=opaque';
    client.fetchDatabricksLogin.mockResolvedValue({ state: 'waiting-browser', authUrl });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mount({ host: 'https://updates.example', profile: 'updates' });
    await clickLogin();
    expect(client.startDatabricksLogin).toHaveBeenCalledWith({ host: 'https://updates.example', profile: 'updates' });
    const browserControl = screen.getByRole('button', { name: '브라우저에서 열기' });
    expect(browserControl.getAttribute('type')).toBe('button');
    await act(async () => { fireEvent.click(browserControl); });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(authUrl);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '복사' })); });
    expect(writeText).toHaveBeenCalledExactlyOnceWith(authUrl);
  });
  it('refreshes models and invokes the caller only after verified success', async () => {
    vi.useFakeTimers();
    client.fetchDatabricksLogin.mockResolvedValueOnce({ state: 'waiting-browser' }).mockResolvedValue({ state: 'succeeded' });
    const onSuccess = vi.fn();
    mount({ onSuccess });
    await clickLogin();
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(refresh).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it.each(['failed', 'timeout'] as const)('shows %s and retries the same host', async state => {
    client.fetchDatabricksLogin.mockResolvedValue({ state });
    mount({ host: 'https://workspace.example' });
    await clickLogin();
    expect(screen.getByRole('alert')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '다시 시도' })); });
    expect(client.startDatabricksLogin).toHaveBeenCalledTimes(2);
  });
  it('retries the URL and profile entered in the modal without asking for them again', async () => {
    client.startDatabricksLogin.mockResolvedValueOnce({ state: 'needs-input' });
    client.fetchDatabricksLogin.mockResolvedValue({ state: 'failed' });
    mount();
    await clickLogin();
    const workspace = screen.getByRole('textbox', { name: '워크스페이스 URL' });
    fireEvent.change(workspace, { target: { value: 'https://workspace.example' } });
    fireEvent.change(screen.getByRole('textbox', { name: '프로필 이름 (선택)' }), { target: { value: 'team-dev' } });
    await act(async () => { fireEvent.submit(workspace.closest('form')!); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '다시 시도' })); });
    expect(client.startDatabricksLogin).toHaveBeenLastCalledWith({ host: 'https://workspace.example', profile: 'team-dev' });
    expect(client.startDatabricksLogin).toHaveBeenCalledTimes(3);
  });
  it('cancels only its own login job and closes the progress modal', async () => {
    mount();
    await clickLogin();
    await act(async () => { fireEvent.click(screen.getByTestId('databricks-login-cancel')); });
    expect(client.cancelDatabricksLogin).toHaveBeenCalledExactlyOnceWith('job-1');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('cancels its job on unmount', async () => {
    const view = mount();
    await clickLogin();
    view.unmount();
    expect(client.cancelDatabricksLogin).toHaveBeenCalledExactlyOnceWith('job-1');
  });
  it('does not invoke success after closing during model refresh', async () => {
    let finish!: () => void;
    refresh.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve([]); }));
    client.fetchDatabricksLogin.mockResolvedValue({ state: 'succeeded', profileId: 'new-profile' });
    const onSuccess = vi.fn();
    mount({ onSuccess });
    await clickLogin();
    await act(async () => { fireEvent.click(screen.getByTestId('databricks-login-cancel')); });
    await act(async () => { finish(); });
    expect(onSuccess).not.toHaveBeenCalled();
  });
  it('authenticates the selected model connection instead of DEFAULT', async () => {
    client.fetchDatabricksStatus.mockResolvedValue({ profiles: [
      { id: 'default', label: 'DEFAULT', workspaceLabel: 'https://a.example', connectionMode: 'cli-profile' },
      { id: 'selected', label: 'team-b', workspaceLabel: 'https://b.example', connectionMode: 'cli-profile' },
    ] });
    mount({ connectionId: 'selected' });
    await clickLogin();
    expect(client.startDatabricksLogin).toHaveBeenCalledExactlyOnceWith({ host: 'https://b.example', profile: 'team-b' });
  });
  it('routes token connections to replacement without starting unrelated SSO or retrying', async () => {
    client.fetchDatabricksStatus.mockResolvedValue({ profiles: [
      { id: 'token', workspaceLabel: 'https://b.example', connectionMode: 'workspace-token' },
    ] });
    const onSuccess = vi.fn();
    mount({ connectionId: 'token', onSuccess });
    await clickLogin();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(client.startDatabricksLogin).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });
  it('cancels a late start response after the user already closed the modal', async () => {
    let finish!: (result: DatabricksManagedLoginStart) => void;
    client.startDatabricksLogin.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    mount();
    await clickLogin();
    await act(async () => { fireEvent.click(screen.getByTestId('databricks-login-cancel')); });
    await act(async () => { finish({ state: 'started', loginId: 'late-job' }); });
    expect(client.cancelDatabricksLogin).toHaveBeenCalledExactlyOnceWith('late-job');
    expect(client.fetchDatabricksLogin).not.toHaveBeenCalled();
  });
});
