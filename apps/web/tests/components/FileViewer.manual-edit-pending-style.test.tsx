// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import { en } from '../../src/i18n/locales/en';
import type { ProjectFile } from '../../src/types';

const PORTAL_ID = 'pending-style-inspector';
const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
const file: ProjectFile = {
  name: 'preview.html', path: 'preview.html', type: 'file', size: 100, mtime: 1,
  mime: 'text/html', kind: 'html',
};
const target: ManualEditTarget = {
  id: 'hero', kind: 'container', label: 'Hero', tagName: 'main', className: '', text: '',
  rect: { x: 24, y: 24, width: 160, height: 48 }, fields: {},
  attributes: { 'data-readable-id': 'hero' }, styles: emptyManualEditStyles(),
  isLayoutContainer: false, outerHtml: '<main data-readable-id="hero">Hero</main>',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.getElementById(PORTAL_ID)?.remove();
});

async function mount() {
  const host = document.createElement('div');
  host.id = PORTAL_ID;
  document.body.appendChild(host);
  // Subscribe to the write before triggering Save; hold the response so close
  // can also be tested while persistence is in flight. No iframe auto-acks.
  const posted = deferred<{ content: string; expectedContentSha256: string }>();
  const response = deferred<Response>();
  const writes: Array<{ content: string; expectedContentSha256: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/files') && init?.method === 'POST') {
      const payload = JSON.parse(String(init.body)) as typeof writes[number];
      writes.push(payload);
      posted.resolve(payload);
      return response.promise;
    }
    if (url.includes('/deployments')) {
      return new Response(JSON.stringify({ deployments: [] }), { status: 200 });
    }
    return new Response(source, { status: 200 });
  }));
  const closeGuard: { current: (() => boolean) | null } = { current: null };
  const onCloseGuardChange = (guard: (() => boolean) | null) => { closeGuard.current = guard; };
  const onFileSaved = vi.fn();
  const props = {
    projectId: 'pending-style', projectKind: 'prototype' as const, file, liveHtml: source,
    manualEditPortalId: PORTAL_ID, onCloseGuardChange, onFileSaved,
  };
  const view = render(<FileViewer {...props} />);
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  const postSpy = vi.spyOn(frame.contentWindow!, 'postMessage');
  const guard = () => {
    expect(closeGuard.current).not.toBeNull();
    return closeGuard.current!();
  };
  const changeBackground = (value = '#123456') => {
    fireEvent.change(screen.getByRole('textbox', { name: en['manualEdit.background'] }), { target: { value } });
  };
  const acknowledge = () => {
    const preview = postSpy.mock.calls.map(([message]) => message as { type: string; version: number })
      .filter((message) => message.type === 'readable-edit-preview-style').at(-1);
    expect(preview).toBeTruthy();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: frame.contentWindow,
        data: { type: 'readable-edit-preview-style-applied', id: '__body__', ok: true,
          version: preview!.version, rect: { x: 0, y: 0, width: 800, height: 600 } },
      }));
    });
  };
  const startSave = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en['manualEdit.saveChanges'] }));
      await posted.promise;
    });
  };
  const finishSave = async (status = 200) => {
    await act(async () => {
      response.resolve(new Response(JSON.stringify(status === 200 ? { file } : {
        message: 'save failed', ...(status === 409 ? { code: 'CONFLICT' } : {}),
      }), { status, headers: { 'Content-Type': 'application/json' } }));
      await response.promise;
    });
  };
  return { view, props, frame, postSpy, guard, changeBackground, acknowledge, writes, onFileSaved, startSave, finishSave };
}

function expectDirtyActions(dirty: boolean) {
  for (const name of [en['manualEdit.saveChanges'], en['manualEdit.discardChanges']]) {
    expect(screen.queryByRole('button', { name }) !== null).toBe(dirty);
  }
}

describe('FileViewer pending page-style close guard', () => {
  it('blocks close synchronously before a parent render or iframe acknowledgement', async () => {
    const editor = await mount();
    expect(editor.guard()).toBe(true);
    expectDirtyActions(false);
    act(() => {
      editor.changeBackground();
      // The outer act keeps React effects from repairing a stale guard first.
      expect(editor.guard()).toBe(false);
    });
    expect(editor.postSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'readable-edit-preview-style', id: '__body__', styles: { backgroundColor: '#123456' },
    }), '*');
    expectDirtyActions(true);
    expect(screen.getByRole('alert').textContent).toBe(en['workspace.unsavedTabCloseBlocked']);
    expect(editor.writes).toHaveLength(0);
    editor.acknowledge();
    act(() => { expect(editor.guard()).toBe(false); });
    expectDirtyActions(true);
  });

  it.each([false, true])('allows close after Save (acknowledged: %s), writing the pending style once', async (acknowledged) => {
    const editor = await mount();
    editor.changeBackground();
    if (acknowledged) editor.acknowledge();
    expectDirtyActions(true);
    await editor.startSave();
    act(() => { expect(editor.guard()).toBe(false); });
    expect(editor.writes).toHaveLength(1);
    const payload = editor.writes[0]!;
    const saved = new DOMParser().parseFromString(payload.content, 'text/html');
    expect(saved.body.style.backgroundColor).toBe('rgb(18, 52, 86)');
    expect(payload.expectedContentSha256).toBe('11d9fe0100057e5836181fac66c1ba75bb9e8fb1d0e457dc370ebef23cbf5b6c');
    await editor.finishSave();
    expect(editor.onFileSaved).toHaveBeenCalledTimes(1);
    expect(editor.guard()).toBe(true);
    expectDirtyActions(false);
    expect(screen.getByTestId('manual-edit-mode-toggle').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    expect(editor.guard()).toBe(true);
    expectDirtyActions(false);
  });

  it.each([false, true])('allows immediate close after Discard (acknowledged: %s) without writing', async (acknowledged) => {
    const editor = await mount();
    editor.changeBackground();
    if (acknowledged) editor.acknowledge();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: en['manualEdit.discardChanges'] }));
      expect(editor.guard()).toBe(true);
    });
    expectDirtyActions(false);
    expect(editor.writes).toHaveLength(0);
    expect(editor.onFileSaved).not.toHaveBeenCalled();
    expect(editor.frame.srcdoc).not.toContain('#123456');
    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    expect(screen.getByRole('button', { name: en['manualEdit.undo'] }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: en['manualEdit.redo'] }).hasAttribute('disabled')).toBe(true);
    expect(editor.guard()).toBe(true);
  });

  it.each([409, 500])('keeps close blocked and Save/Discard available after a %s save failure', async (status) => {
    const editor = await mount();
    editor.changeBackground();
    await editor.startSave();
    await editor.finishSave(status);
    expect(editor.writes).toHaveLength(1);
    expect(editor.onFileSaved).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    expectDirtyActions(true);
    expect(screen.getByRole('button', { name: en['manualEdit.saveChanges'] }).hasAttribute('disabled')).toBe(false);
    act(() => { expect(editor.guard()).toBe(false); });
    expect(screen.getByTestId('manual-edit-mode-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('textbox', { name: en['manualEdit.background'] }).getAttribute('value')).toBe('#123456');
    fireEvent.click(screen.getByRole('button', { name: en['manualEdit.discardChanges'] }));
    expect(editor.guard()).toBe(true);
  });

  it('clears the guard when invalid input cancels the only pending style', async () => {
    const editor = await mount();
    editor.changeBackground();
    expectDirtyActions(true);
    act(() => {
      editor.changeBackground('not-a-color');
      expect(editor.guard()).toBe(true);
    });
    expectDirtyActions(false);
    expect(editor.writes).toHaveLength(0);
  });

  it('preserves a pending style across watcher refresh and blocks tool switching', async () => {
    const editor = await mount();
    editor.changeBackground();
    editor.view.rerender(<FileViewer {...editor.props} liveHtml={source.replace('Hero', 'Server hero')} filesRefreshKey={1} />);
    fireEvent.click(screen.getByTestId('board-mode-toggle'));
    expect(screen.getByTestId('manual-edit-mode-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('board-mode-toggle').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('alert').textContent).toBe(en['manualEdit.pendingSaveBlocked']);
    await editor.startSave();
    expect(editor.writes[0]!.content).not.toContain('Server hero');
    expect(editor.writes[0]!.content).toContain('>Hero</main>');
    await editor.finishSave();
  });

  it('keeps the guard tied to source after a style flush, undo and redo', async () => {
    const editor = await mount();
    editor.changeBackground();
    // Changing selection folds the pending page style into source/history.
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: editor.frame.contentWindow, data: { type: 'readable-edit-select', target },
      }));
    });
    act(() => { expect(editor.guard()).toBe(false); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['manualEdit.undo'] })); });
    expect(editor.guard()).toBe(true);
    expectDirtyActions(false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['manualEdit.redo'] })); });
    act(() => { expect(editor.guard()).toBe(false); });
    expectDirtyActions(true);
    expect(editor.writes).toHaveLength(0);
  });
});
