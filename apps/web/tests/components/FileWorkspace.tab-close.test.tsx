// @vitest-environment jsdom

import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESIGN_FILES_TAB, FileWorkspace } from '../../src/components/FileWorkspace';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import { getEn } from '../../src/i18n/locales/en';
const en = getEn();
import { fetchProjectDeployments, fetchProjectFileText, fetchProjectFolders } from '../../src/providers/registry';
import { killTerminal } from '../../src/state/projects';
import type { OpenTabsState, ProjectFile } from '../../src/types';
import { stubMissingCanvasContext } from '../helpers/canvas';
import { buildManualEditBridge } from '../../src/edit-mode/bridge';
import { JSDOM } from '../edit-mode/bridge-dom';
import { deferred } from '../helpers/deferred';

vi.mock('../../src/providers/registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/providers/registry')>(),
  fetchProjectFileText: vi.fn(),
  fetchProjectFolders: vi.fn().mockResolvedValue([]),
  fetchProjectDeployments: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/state/projects', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/state/projects')>(),
  killTerminal: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../src/components/DesignBrowserPanel', () => ({
  DesignBrowserPanel: () => <div data-testid="browser-surface" />,
}));
vi.mock('../../src/components/workspace/TerminalViewer', () => ({
  TerminalViewer: ({ terminalId, onSessionIdChange }: {
    terminalId: string;
    onSessionIdChange: (original: string, live: string) => void;
  }) => <button data-testid="restart-terminal" onClick={() => onSessionIdChange(terminalId, 'restarted')}>{terminalId}</button>,
}));

const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
const changed = vi.fn();
const file = (name: string, kind: ProjectFile['kind'] = 'image'): ProjectFile => ({
  name, path: name, kind, type: 'file', size: 100, mtime: 1,
  mime: kind === 'html' ? 'text/html' : 'image/png',
});
const browser = { id: '__browser__:1', label: 'Browser', insertAfter: 'first.png' };

beforeEach(() => {
  vi.mocked(fetchProjectFileText).mockResolvedValue(source);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  stubMissingCanvasContext();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Workspace({ initial, files = [], ...props }: {
  initial: OpenTabsState;
  files?: ProjectFile[];
} & Partial<React.ComponentProps<typeof FileWorkspace>>) {
  const [state, setState] = useState(initial);
  return <FileWorkspace projectId="tab-close" projectKind="prototype" isDeck={false}
    onRefreshFiles={vi.fn()} files={files} {...props} tabsState={state}
    onTabsStateChange={(next) => { changed(next); setState(next); }} />;
}

async function settleLoads() {
  await act(async () => {
    await Promise.all([
      ...vi.mocked(fetchProjectFileText).mock.results,
      ...vi.mocked(fetchProjectFolders).mock.results,
      ...vi.mocked(fetchProjectDeployments).mock.results,
    ].map((result) => result.value));
  });
}
async function mount(props: React.ComponentProps<typeof Workspace>) {
  render(<Workspace {...props} />);
  await settleLoads();
}
const tab = (name: string) => screen.getByRole('tab', { name });
const close = (name: string) => within(tab(name)).getByRole('button', { name: en['workspace.closeTab'] });
function middleClick(target: HTMLElement) {
  return fireEvent(target, new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
}

const kinds = [
  { id: 'preview.html', label: 'preview.html', kind: 'html' },
  { id: 'photo.png', label: 'photo.png', kind: 'image' },
  { id: 'notes.txt', label: 'notes.txt', kind: 'text' },
  { id: 'module.ts', label: 'module.ts', kind: 'code' },
  { id: 'drawing.sketch.json', label: 'drawing.sketch.json', kind: 'sketch' },
  { id: 'terminal:term-1', label: en['workspace.newTerminal'] },
  { id: 'chat:conversation-1', label: en['workspace.sideChatDefaultTitle'] },
  { id: browser.id, label: browser.label },
] as const;

describe('workspace tab dismissal', () => {
  it.each(kinds)('keeps $id close reachable and operable with native keyboard activation', async ({ id, label }) => {
    await mount({
      initial: { tabs: ['first.png', ...(id === browser.id ? [] : [id]), 'last.png'], active: 'first.png',
        ...(id === browser.id ? { browserTabs: [browser] } : {}) },
      files: [file('first.png'), file('last.png')],
    });
    const control = close(label);
    expect(control.tabIndex).toBe(0);
    control.focus();
    expect(document.activeElement).toBe(control);
    // jsdom does not synthesize native button activation. Check that the tab
    // neither cancels the native key nor activates itself, then deliver click.
    expect(fireEvent.keyDown(control, { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(control, { key: ' ' })).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    fireEvent.click(control);
    await settleLoads();
    expect(screen.queryByRole('tab', { name: label })).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenLastCalledWith({ tabs: ['first.png', 'last.png'], active: 'first.png' });
    expect(tab('first.png').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab('first.png'));
  });

  it.each(kinds)('middle-click removes exactly $id without activating it', async ({ id, label }) => {
    await mount({ initial: { tabs: ['first.png', ...(id === browser.id ? [] : [id])], active: 'first.png',
      ...(id === browser.id ? { browserTabs: [browser] } : {}) }, files: [file('first.png')] });
    expect(middleClick(tab(label))).toBe(false);
    expect(screen.queryByRole('tab', { name: label })).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenLastCalledWith({ tabs: ['first.png'], active: 'first.png' });
  });

  it.each([
    { active: 'first.png', next: browser.label, remaining: ['last.png'] },
    { active: browser.id, next: 'last.png', remaining: ['first.png', 'last.png'] },
    { active: 'last.png', next: browser.label, remaining: ['first.png'] },
  ])('closing active $active focuses the right neighbour, otherwise the left, across kinds', async ({ active, next, remaining }) => {
    await mount({ initial: { tabs: ['first.png', 'last.png'], active, browserTabs: [browser] },
      files: [file('first.png'), file('last.png')] });
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true });
    await settleLoads();
    expect(tab(next).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab(next));
    expect(changed.mock.lastCall?.[0].tabs).toEqual(remaining);
  });

  it('returns to the designed Design Files empty state after the last tab, with a keyboard focus target', async () => {
    await mount({ initial: { tabs: ['chat:conversation-1'], active: 'chat:conversation-1' } });
    fireEvent.click(close(en['workspace.sideChatDefaultTitle']));
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByTestId('design-files-tab'));
    expect(screen.getByTestId('design-files-empty')).toBeTruthy();
    expect(screen.getByTestId('design-files-empty-new-sketch')).toBeTruthy();
    expect(changed.mock.lastCall?.[0].tabs).toEqual([]);
  });

  it('keeps pending sketches active on background close and reuses their discard confirmation', async () => {
    await mount({ initial: { tabs: ['old.png'], active: DESIGN_FILES_TAB } });
    fireEvent.click(screen.getByTestId('design-files-empty-new-sketch'));
    const pendingTab = screen.getAllByRole('tab').at(-1)!;
    const pendingClose = within(pendingTab).getByRole('button', { name: en['workspace.closeTab'] });
    fireEvent.click(close('old.png'));
    expect(pendingTab.getAttribute('aria-selected')).toBe('true');
    changed.mockClear();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    middleClick(pendingTab);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
    expect(pendingTab.isConnected).toBe(true);
    fireEvent.click(pendingClose);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(pendingTab.isConnected).toBe(false);
    expect(document.activeElement).toBe(screen.getByTestId('design-files-tab'));
  });

  it('reuses terminal teardown and kills the restarted live session exactly once', async () => {
    await mount({ initial: { tabs: ['terminal:original'], active: 'terminal:original' } });
    fireEvent.click(screen.getByTestId('restart-terminal'));
    fireEvent.click(close(en['workspace.newTerminal']));
    expect(killTerminal).toHaveBeenCalledTimes(1);
    expect(killTerminal).toHaveBeenCalledWith('tab-close', 'restarted', { keepalive: true });
  });

  it.each(['tab', 'shortcut', 'agent-open', 'share', 'download', 'root'] as const)(
    'blocks %s file switching until the existing Save/Discard decision is made', async (path) => {
      const initial = { tabs: ['preview.html', 'other.png'], active: 'preview.html' };
      const files = [file('preview.html', 'html'), file('other.png')];
      const view = render(<Workspace initial={initial} files={files} />);
      await settleLoads();
      fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
      const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
      act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow,
        data: { type: 'readable-edit-text-commit', id: 'hero', value: 'Unsaved hero' } })));
      const switchFile = (nonce: number) => {
        if (path === 'tab') fireEvent.click(tab('other.png'));
        else if (path === 'shortcut') fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
        else if (path === 'root') fireEvent.click(screen.getByTestId('design-files-tab'));
        else view.rerender(<Workspace initial={initial} files={files}
          {...(path === 'agent-open' ? { openRequest: { name: 'other.png', nonce } }
            : path === 'share' ? { shareRequest: { name: 'other.png', nonce } }
              : { downloadRequest: { name: 'other.png', nonce } })} />);
      };
      switchFile(1);
      await settleLoads();
      expect(tab('preview.html').getAttribute('aria-selected')).toBe('true');
      expect(changed).not.toHaveBeenCalled();
      expect(screen.getByTestId('artifact-preview-frame')).toBe(frame);
      expect(frame.srcdoc).toContain('Unsaved hero');
      expect(screen.getByRole('alert')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: en['manualEdit.discardChanges'] }));
      switchFile(2);
      await settleLoads();
      expect(tab('preview.html').getAttribute('aria-selected')).toBe('false');
    },
  );

  it('keeps a live bridge mounted on file switch, then saves its text before allowing navigation', async () => {
    const saved = deferred<void>();
    const writes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)).content);
        return new Response(JSON.stringify({ file: file('preview.html', 'html') }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(source, { status: 200 });
    }));
    await mount({ initial: { tabs: ['preview.html', 'other.png'], active: 'preview.html' },
      files: [file('preview.html', 'html'), file('other.png')], onRefreshFiles: () => saved.resolve() });
    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
    const dom = new JSDOM(`${source}${buildManualEditBridge(true)}`, { runScripts: 'dangerously', url: 'http://localhost' });
    await dom.loaded;
    const messages: unknown[] = [];
    dom.window.parent.postMessage = (data: unknown) => { messages.push(data); };
    vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((data) => {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
    });
    const dispatch = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data }));
    const drain = async () => { await act(async () => { while (messages.length) dispatch(messages.shift()); }); };
    const target: ManualEditTarget = {
      id: 'hero', kind: 'text', label: 'Hero', tagName: 'main', className: '', text: 'Hero',
      rect: { x: 24, y: 24, width: 160, height: 48 }, fields: { text: 'Hero' },
      attributes: {}, styles: emptyManualEditStyles(), isLayoutContainer: false, outerHtml: '<main>Hero</main>',
    };
    await act(async () => { dispatch({ type: 'readable-edit-select', target, beginTextEdit: true }); });
    await drain();
    const el = dom.window.document.querySelector('[data-readable-id="hero"]')!;
    expect(el.getAttribute('data-readable-editing')).toBe('true');
    el.textContent = 'Live unsaved text';
    fireEvent.click(tab('other.png'));
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByTestId('artifact-preview-frame')).toBe(frame);
    await drain();
    expect(frame.srcdoc).toContain('Live unsaved text');
    expect(writes).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['manualEdit.saveChanges'] })); });
    await drain();
    await act(async () => { await saved.promise; });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('Live unsaved text');
    fireEvent.click(tab('other.png'));
    await settleLoads();
    expect(tab('other.png').getAttribute('aria-selected')).toBe('true');
  });

  it.each(['button', 'middle', 'shortcut'] as const)('blocks %s close of real dirty direct edits without discarding source, then allows explicit discard', async (path) => {
    await mount({ initial: { tabs: ['preview.html', 'other.png'], active: 'preview.html' },
      files: [file('preview.html', 'html'), file('other.png')] });
    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
    const target: ManualEditTarget = {
      id: 'hero', kind: 'text', label: 'Hero', tagName: 'main', className: '', text: 'Hero',
      rect: { x: 24, y: 24, width: 160, height: 48 }, fields: { text: 'Hero' },
      attributes: { 'data-readable-id': 'hero' }, styles: emptyManualEditStyles(),
      isLayoutContainer: false, outerHtml: '<main data-readable-id="hero">Hero</main>',
    };
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow,
        data: { type: 'readable-edit-select', target } }));
    });
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow,
        data: { type: 'readable-edit-text-commit', id: 'hero', value: 'Unsaved hero' } }));
    });
    expect(frame.srcdoc).toContain('Unsaved hero');
    const dismiss = () => {
      if (path === 'button') fireEvent.click(close('preview.html'));
      else if (path === 'middle') middleClick(tab('preview.html'));
      else fireEvent.keyDown(window, { key: 'w', ctrlKey: true });
    };
    dismiss();
    expect(changed).not.toHaveBeenCalled();
    expect(tab('preview.html').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe(en['workspace.unsavedTabCloseBlocked']);
    expect(frame.srcdoc).toContain('Unsaved hero');
    expect(screen.getByTestId('manual-edit-mode-toggle').getAttribute('aria-pressed')).toBe('true');
    // Closing an unrelated tab must not unmount or discard the dirty viewer.
    fireEvent.click(close('other.png'));
    expect(screen.getByTestId('artifact-preview-frame')).toBe(frame);
    expect(frame.srcdoc).toContain('Unsaved hero');
    fireEvent.click(screen.getByRole('button', { name: en['manualEdit.discardChanges'] }));
    dismiss();
    await settleLoads();
    expect(screen.queryByRole('tab', { name: 'preview.html' })).toBeNull();
    expect(screen.getByTestId('design-files-tab').getAttribute('aria-selected')).toBe('true');
  });
});
