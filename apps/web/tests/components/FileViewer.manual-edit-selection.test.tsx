// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPerformanceProfileToDocument } from '../../src/state/config';
import { FileViewer } from '../../src/components/FileViewer';
import { buildManualEditBridge } from '../../src/edit-mode/bridge';
import { JSDOM } from '../edit-mode/bridge-dom';

const source = '<!doctype html><html><body><p data-readable-id="text">Original</p><a data-readable-id="link" href="/start">Link</a><div data-readable-id="structured">Headline<div class="glow"></div></div></body></html>';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  applyPerformanceProfileToDocument('full');
});

async function mount() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(source)));
  render(<FileViewer projectId="selection" projectKind="prototype" liveHtml={source}
    file={{ name: 'selection.html', path: 'selection.html', type: 'file', size: 100, mtime: 1, mime: 'text/html', kind: 'html' }} />);
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  const dom = new JSDOM(`${source}${buildManualEditBridge(true)}`, { runScripts: 'dangerously', url: 'http://localhost' });
  await dom.loaded;
  for (const el of dom.window.document.querySelectorAll('[data-readable-id]')) {
    el.getBoundingClientRect = () => ({ x: 20, y: 20, left: 20, top: 20, right: 220, bottom: 70, width: 200, height: 50, toJSON: () => ({}) });
  }
  const posts: Array<{ type: string; id?: string; value?: string }> = [];
  vi.spyOn(dom.window.parent, 'postMessage').mockImplementation((message) => {
    posts.push(message);
    window.dispatchEvent(new MessageEvent('message', { data: message, source: frame.contentWindow }));
  });
  const hostPosts = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((message) => {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message }));
  });
  const interior = () => screen.getByLabelText('Move element').querySelector('[data-region="interior"]');
  return { dom, posts, hostPosts, interior };
}

describe.each(['full', 'low'] as const)('direct-edit selection with %s host profile', (profile) => {
beforeEach(() => applyPerformanceProfileToDocument(profile));

it.each(['text', 'link', 'structured'])('selects %s, double-clicks its real element, then Escape steps out and deselects', async (id) => {
  const { dom, posts, hostPosts, interior } = await mount();
  const el = dom.window.document.querySelector(`[data-readable-id="${id}"]`)!;
  await act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); });
  expect(el.getAttribute('data-readable-edit-selected')).toBe('true');
  expect(el.hasAttribute('contenteditable')).toBe(false);
  expect(interior()).not.toBeNull();
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }));
    el.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
  });
  expect(hostPosts).toHaveBeenCalledWith({ type: 'readable-edit-begin-text-edit', id }, '*');
  expect(el.getAttribute('contenteditable')).toBe(id === 'link' ? 'plaintext-only' : 'true');
  expect(interior()).toBeNull();
  await act(async () => {
    el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
  });
  expect(el.hasAttribute('contenteditable')).toBe(false);
  expect(el.getAttribute('data-readable-edit-selected')).toBe('true');
  expect(interior()).not.toBeNull();
  expect(posts.filter((message) => message.type === 'readable-edit-deselect')).toHaveLength(0);
  await act(async () => {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
  });
  expect(screen.queryByLabelText('Move element')).toBeNull();
  expect(el.hasAttribute('data-readable-edit-selected')).toBe(false);
  expect(posts.filter((message) => message.type === 'readable-edit-deselect')).toHaveLength(1);
});

it.each(['text', 'structured'])('double-clicks the selected %s move surface through the existing command', async (id) => {
  const { dom, hostPosts, interior } = await mount();
  const el = dom.window.document.querySelector(`[data-readable-id="${id}"]`)!;
  await act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); });
  await act(async () => { fireEvent.doubleClick(interior()!); });
  expect(hostPosts).toHaveBeenCalledWith({ type: 'readable-edit-begin-text-edit', id }, '*');
  expect(el.getAttribute('contenteditable')).toBe('true');
});

it('carries the first native click across the newly mounted overlay and Enter commits text', async () => {
  const { dom, posts, interior } = await mount();
  const el = dom.window.document.querySelector('[data-readable-id="text"]')!;
  // Time is part of cross-document double-click recognition; freeze it rather than racing it.
  vi.spyOn(dom.window.Date, 'now').mockReturnValue(1000);
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }));
  });
  await act(async () => {
    fireEvent.pointerDown(interior()!, { pointerId: 1, clientX: 30, clientY: 30 });
    fireEvent.pointerUp(interior()!, { pointerId: 1, clientX: 30, clientY: 30 });
  });
  expect(el.getAttribute('contenteditable')).toBe('true');
  await act(async () => {
    el.textContent = 'Committed';
    el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }));
  });
  expect(posts).toContainEqual({ type: 'readable-edit-text-commit', id: 'text', value: 'Committed' });
  expect(el.hasAttribute('contenteditable')).toBe(false);
  expect(interior()).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Undo' }).hasAttribute('disabled')).toBe(false);
});
});
