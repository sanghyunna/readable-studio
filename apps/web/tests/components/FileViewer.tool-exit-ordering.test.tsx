// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import { I18nProvider } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';
import { ko } from '../../src/i18n/locales/ko';
import { buildManualEditBridge } from '../../src/edit-mode/bridge';
import { buildSrcdoc } from '../../src/runtime/srcdoc';
import type { PreviewComment, ProjectFile } from '../../src/types';

const html = '<html><body><main data-readable-id="hero">Hero</main></body></html>';
const file: ProjectFile = {
  name: 'preview.html', path: 'preview.html', type: 'file', size: 100, mtime: 1,
  mime: 'text/html', kind: 'html',
};
const comment: PreviewComment = {
  id: 'queued', projectId: 'project-1', conversationId: 'conv-a', filePath: file.name,
  elementId: 'hero', selector: '[data-readable-id="hero"]', label: 'Hero', text: 'Hero',
  htmlHint: '<main data-readable-id="hero">Hero</main>',
  position: { x: 8, y: 12, width: 120, height: 48 },
  note: 'queued-note', status: 'open', createdAt: 1, updatedAt: 1,
};
const hosts: HTMLElement[] = [];
const closeBridgeDoms: Array<() => Promise<void>> = [];
function bridgeDom(markup: string) {
  const errors: Error[] = [];
  const observers: MutationObserver[] = [];
  const virtualConsole = new VirtualConsole().forwardTo(console);
  virtualConsole.on('jsdomError', (error) => errors.push(error));
  const dom = new JSDOM(markup, {
    runScripts: 'dangerously', url: 'http://localhost', virtualConsole,
    pretendToBeVisual: true,
    beforeParse(window) {
      const NativeMutationObserver = window.MutationObserver;
      // Keep native delivery throughout each assertion; only own disposal.
      window.MutationObserver = class extends NativeMutationObserver {
        constructor(callback: MutationCallback) {
          super(callback);
          observers.push(this);
        }
      };
    },
  });
  closeBridgeDoms.push(async () => {
    // JSDOM close() does not disconnect observers or dispatch pagehide.
    observers.forEach((observer) => observer.disconnect());
    // close() clears the body before deleting window.document. Observe that
    // exact mutation so errors from its delivery cannot outlive afterEach.
    const closed = new Promise<void>((resolve) => {
      const observer = new dom.window.MutationObserver(() => {
        observer.disconnect();
        resolve();
      });
      observer.observe(dom.window.document.body, { childList: true });
    });
    dom.window.close();
    await closed;
    expect(errors).toEqual([]);
  });
  return dom;
}
function host() {
  const node = document.createElement('div');
  node.id = `tool-exit-host-${hosts.length}`;
  document.body.appendChild(node);
  hosts.push(node);
  return node;
}
function message(frame: HTMLIFrameElement, type: string, data: object = {}) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow, data: { ...data, type },
    }));
  });
}
afterEach(async () => {
  try {
    cleanup();
    hosts.splice(0).forEach((node) => node.remove());
    await Promise.all(closeBridgeDoms.splice(0).map((close) => close()));
  } finally {
    vi.restoreAllMocks();
  }
}, 5_000);

describe('FileViewer tool exit ordering', () => {
  for (const locale of ['en', 'ko'] as const) {
    it.each(['draw-overlay-toggle', 'board-mode-toggle', 'comment-panel-toggle', 'manual-edit-mode-toggle'])(
      `keeps the dirty edit host mounted and shows shipped ${locale} Toast for %s`,
      async (tool) => {
        const inspector = host();
        const modeChanged = vi.fn();
        await act(async () => {
          render(<I18nProvider initial={locale}><FileViewer projectId="project-1" projectKind="prototype"
            file={file} liveHtml={html} manualEditPortalId={inspector.id}
            onManualEditInspectorChange={modeChanged} /></I18nProvider>);
        });
        fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
        const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
        message(frame, 'readable-edit-text-commit', { id: 'hero', value: 'changed-hero' });
        expect(frame.srcdoc).toContain('changed-hero');
        expect(inspector.childElementCount).toBeGreaterThan(0);
        modeChanged.mockClear();
        fireEvent.click(screen.getByTestId(tool));
        const toast = screen.getByRole('alert');
        expect(toast.textContent).toBe((locale === 'en' ? en : ko)['manualEdit.pendingSaveBlocked']);
        expect(toast.parentElement).toBe(document.body);
        expect(toast.classList.contains('readable-toast')).toBe(true);
        expect(inspector.isConnected).toBe(true);
        expect(inspector.childElementCount).toBeGreaterThan(0);
        expect(modeChanged).not.toHaveBeenCalled();
        expect(screen.getByTestId('manual-edit-mode-toggle').getAttribute('aria-pressed')).toBe('true');
        if (tool !== 'manual-edit-mode-toggle') {
          expect(screen.getByTestId(tool).getAttribute('aria-pressed')).toBe('false');
        }
      },
    );
  }

  for (const surface of ['side', 'composer', 'saved-composer'] as const) {
    it.each([true, false])(`${surface} dispatch accepted=%s synchronizes mode and hover before portal teardown`, async (accepted) => {
      const inspector = host();
      let resolveDispatch!: (accepted: boolean) => void;
      const dispatched = new Promise<boolean>((resolve) => { resolveDispatch = resolve; });
      const send = vi.fn(() => dispatched);
      const exits: boolean[] = [];
      let armed = false;
      let disabledPosted = false;
      const bridge = bridgeDom(buildSrcdoc(html, { commentBridge: true }));
      // JSDOM lacks Element.scrollTo; preserve the bridge's numeric scroll API
      // on this fixture's scroll root without patching other windows/elements.
      const scrollRoot = bridge.window.document.documentElement;
      const scrollTo = vi.fn((left: number, top: number) => {
        scrollRoot.scrollLeft = left;
        scrollRoot.scrollTop = top;
      });
      Object.defineProperty(scrollRoot, 'scrollTo', { configurable: true, value: scrollTo });
      await act(async () => {
        render(<FileViewer projectId="project-1" projectKind="prototype" file={file} liveHtml={html}
          previewComments={[surface === 'saved-composer'
            ? { ...comment, attachments: [{ path: 'uploads/reference.png', name: 'reference.png' }] }
            : comment]} commentPortalId={inspector.id}
          onSendBoardCommentAttachments={send}
          onCommentModeChange={(active) => {
            if (!armed || active) return;
            exits.push(disabledPosted && screen.queryByTestId('comment-target-overlay') === null);
            inspector.remove();
          }} />);
      });
      fireEvent.click(screen.getByTestId('comment-panel-toggle'));
      const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
      fireEvent.load(frame);
      const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((data) => {
        if (data.type === 'readable-studio:comment-mode' && data.enabled === false) disabledPosted = true;
        bridge.window.dispatchEvent(new bridge.window.MessageEvent('message', { data }));
      });
      // Exercise restoration through the host/bridge protocol, not rAF timing.
      scrollRoot.scrollLeft = 24;
      scrollRoot.scrollTop = 48;
      message(frame, 'readable-studio:preview-scroll-request');
      expect(post).toHaveBeenCalledWith({
        type: 'readable-studio:preview-scroll-restore',
        frameLeft: 0, frameTop: 0, canvasLeft: 0, canvasTop: 0,
      }, '*');
      expect(scrollTo).toHaveBeenCalledWith(0, 0);
      expect(scrollRoot.scrollLeft).toBe(0);
      expect(scrollRoot.scrollTop).toBe(0);
      message(frame, surface === 'side' ? 'readable-studio:comment-hover' : 'readable-studio:comment-target', comment);
      expect(screen.getByTestId('comment-target-overlay')).toBeTruthy();
      if (surface === 'side') {
        fireEvent.click(screen.getByText('Select all'));
      } else if (surface === 'saved-composer') {
        fireEvent.click(screen.getByTestId('comment-saved-marker-hero'));
        fireEvent.change(screen.getByTestId('comment-popover-input'), { target: { value: '' } });
      } else {
        fireEvent.change(screen.getByTestId('comment-popover-input'), { target: { value: 'dispatch-note' } });
      }
      armed = true;
      fireEvent.click(screen.getByTestId(surface === 'side' ? 'comment-side-send-claude' : 'comment-add-send'));
      expect(send).toHaveBeenCalledTimes(1);
      expect(inspector.childElementCount).toBeGreaterThan(0);
      expect(screen.getByTestId('comment-target-overlay')).toBeTruthy();
      await act(async () => { resolveDispatch(accepted); await dispatched; });
      if (accepted) {
        expect(exits).toEqual([true]);
        expect(screen.queryByTestId('comment-target-overlay')).toBeNull();
        expect(screen.queryByTestId('comment-popover')).toBeNull();
        expect(screen.getByTestId('comment-panel-toggle').getAttribute('aria-pressed')).toBe('false');
        expect(post).toHaveBeenCalledWith({ type: 'readable-studio:comment-mode', enabled: false, mode: 'inspect' }, '*');
        expect(bridge.window.document.documentElement.hasAttribute('data-readable-comment-mode')).toBe(false);
        message(frame, 'readable-studio:comment-hover', comment);
        expect(screen.queryByTestId('comment-target-overlay')).toBeNull();
      } else {
        expect(exits).toEqual([]);
        expect(screen.getByTestId('comment-target-overlay')).toBeTruthy();
        expect(inspector.childElementCount).toBeGreaterThan(0);
        expect(bridge.window.document.documentElement.hasAttribute('data-readable-comment-mode')).toBe(true);
      }
    });
  }

  it('keeps native bridge mutation delivery active until teardown', async () => {
    const dom = bridgeDom(`${html}${buildManualEditBridge(true)}`);
    const target = dom.window.document.querySelector('main')!;
    target.dispatchEvent(new dom.window.MouseEvent('pointerover', { bubbles: true }));
    const clone = target.cloneNode(true) as HTMLElement;
    const hoverCleared = new Promise<void>((resolve) => {
      const observer = new dom.window.MutationObserver(() => {
        observer.disconnect();
        resolve();
      });
      observer.observe(clone, { attributes: true, attributeFilter: ['data-readable-runtime-hovered'] });
    });
    dom.window.document.body.appendChild(clone);
    await hoverCleared;
    expect(clone.hasAttribute('data-readable-runtime-hovered')).toBe(false);
    expect(target.getAttribute('data-readable-runtime-hovered')).toBe('true');
  }, 5_000);

  it('removes stale runtime hover attributes when edit mode is disabled', () => {
    const dom = bridgeDom(`${html}${buildManualEditBridge(true)}`);
    const target = dom.window.document.querySelector('main')!;
    target.dispatchEvent(new dom.window.MouseEvent('pointerover', { bubbles: true }));
    expect(target.getAttribute('data-readable-runtime-hovered')).toBe('true');
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: false },
    }));
    expect(dom.window.document.querySelectorAll('[data-readable-runtime-hover], [data-readable-runtime-hovered]')).toHaveLength(0);
  });
});
