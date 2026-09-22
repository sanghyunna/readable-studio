// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import { applyPerformanceProfileToDocument } from '../../src/state/config';
import type { ProjectFile } from '../../src/types';

const source = '<html><body><div data-readable-id="hero">Hero</div></body></html>';
const file: ProjectFile = { name: 'preview.html', path: 'preview.html', type: 'file', size: 100, mtime: 1, mime: 'text/html', kind: 'html' };
const target: ManualEditTarget = {
  id: 'hero', kind: 'container', label: 'Hero', tagName: 'div', className: '', text: 'Hero',
  rect: { x: 10, y: 10, width: 160, height: 48 }, fields: {}, attributes: {},
  styles: emptyManualEditStyles(), isLayoutContainer: false, outerHtml: '<div>Hero</div>',
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); applyPerformanceProfileToDocument('full'); });

describe.each(['full', 'low'] as const)('gesture continuity with %s performance profile', (profile) => {
  it.each([
    ['pointer', 'live'], ['resize', 'live'], ['keyboard', 'live'],
    ['pointer', 'raw'], ['resize', 'raw'], ['keyboard', 'raw'],
    ['pointer', 'close'], ['resize', 'close'], ['keyboard', 'close'],
  ] as const)('completes one undoable %s gesture when a %s transition is blocked mid-gesture', async (gesture, transport) => {
    // Given: an active gesture whose next animation frame has not run yet.
    applyPerformanceProfileToDocument(profile);
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    let disk = source;
    const writes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body: { content: string } = JSON.parse(String(init.body));
        writes.push(body.content);
        return new Response(JSON.stringify({ file }), { status: 200 });
      }
      return new Response(disk, { status: 200 });
    }));
    const closeGuard: { current: (() => boolean) | null } = { current: null };
    const props = {
      projectId: 'gesture-refresh', projectKind: 'prototype' as const, file,
      onCloseGuardChange: (guard: (() => boolean) | null) => { closeGuard.current = guard; },
    };
    const view = render(<FileViewer {...props} liveHtml={transport === 'live' ? disk : undefined} />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    const frame = screen.getByTestId('artifact-preview-frame');
    if (!(frame instanceof HTMLIFrameElement)) throw new TypeError('Expected preview iframe');
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: frame.contentWindow, data: { type: 'readable-edit-select', target },
      }));
    });
    const interior = screen.getByLabelText('Move element').querySelector('[data-region="interior"]');
    if (!(interior instanceof HTMLElement)) throw new TypeError('Expected movement surface');
    const surface = gesture === 'resize' ? screen.getByLabelText('Resize right edge') : interior;
    await act(async () => {
      if (gesture === 'keyboard') fireEvent.keyDown(surface, { key: 'ArrowRight' });
      else {
        fireEvent.pointerDown(surface, { pointerId: 1, clientX: 100, clientY: 100 });
        fireEvent.pointerMove(surface, { pointerId: 1, clientX: 130, clientY: 100 });
      }
    });
    const frozen = frame.srcdoc;

    // When: a refresh or blocked navigation occurs, then the SAME gesture continues.
    disk = source.replace('Hero', 'Agent');
    await act(async () => {
      if (transport === 'close') expect(closeGuard.current?.()).toBe(false);
      else view.rerender(<FileViewer {...props} file={{ ...file, mtime: 2 }} liveHtml={transport === 'live' ? disk : undefined} />);
    });
    expect(surface.isConnected).toBe(true);
    expect(frame.srcdoc).toBe(frozen);
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveProperty('disabled', true);
    await act(async () => {
      if (gesture === 'keyboard') {
        fireEvent.keyDown(surface, { key: 'ArrowRight', repeat: true });
        fireEvent.keyUp(surface, { key: 'ArrowRight' });
      } else {
        fireEvent.pointerMove(surface, { pointerId: 1, clientX: 160, clientY: 100 });
        fireEvent.pointerUp(surface, { pointerId: 1, clientX: 160, clientY: 100 });
      }
    });

    // Then: one history entry covers the complete gesture, and Save persists it.
    expect(writes).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveProperty('disabled', false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })); });
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveProperty('disabled', true);
    const undone = new DOMParser().parseFromString(frame.srcdoc, 'text/html').querySelector('[data-readable-id="hero"]');
    expect(undone?.getAttribute('style') ?? '').not.toMatch(/translate|width/);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Redo' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });
    expect(writes).toHaveLength(1);
    const saved = new DOMParser().parseFromString(writes[0] ?? '', 'text/html').querySelector('[data-readable-id="hero"]');
    if (!(saved instanceof HTMLElement)) throw new TypeError('Expected saved element');
    expect(saved.textContent).toBe('Hero');
    if (gesture === 'resize') expect(saved.style.width).toBe('220px');
    else expect(saved.style.translate).toBe(gesture === 'keyboard' ? '2px 0px' : '60px 0px');
  });
});
