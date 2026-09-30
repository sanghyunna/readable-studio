// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState, type ComponentProps } from 'react';
import type { ProjectFile } from '../../src/types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import { ChatPane } from '../../src/components/ChatPane';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import { composerText, flushMounts, typeInComposer } from '../helpers/lexical-composer';
import { I18nProvider } from '../../src/i18n';
import { getKo } from '../../src/i18n/locales/ko';

const source = '<!doctype html><html><body><main data-readable-id="hero">Hero</main></body></html>';
const target: ManualEditTarget = { id: 'hero', tagName: 'main', kind: 'text', label: 'Hero', text: 'Hero', className: '', rect: { x: 0, y: 0, width: 160, height: 48 }, styles: emptyManualEditStyles(), fields: {}, attributes: {}, outerHtml: '<main data-readable-id="hero">Hero</main>', isLayoutContainer: false, parentId: 'row' };
const file: ProjectFile = { name: 'preview.html', path: 'preview.html', type: 'file' as const, size: 100, mtime: 1, mime: 'text/html', kind: 'html' as const, artifactManifest: { schema: 'readable-studio.artifact-manifest.v1' as const, kind: 'html' as const, title: 'Preview', entry: 'preview.html', renderer: 'html', exports: ['html'] } };
let posts: unknown[];
let conflict: boolean;
let initialSource: string;
let send = vi.fn<ComponentProps<typeof ChatPane>['onSend']>();
beforeEach(() => {
  posts = []; conflict = false; initialSource = source; send = vi.fn();
  const host = document.createElement('div'); host.id = 'width-inspector'; document.body.appendChild(host);
  vi.stubGlobal('fetch', vi.fn(async (input, init?: RequestInit) => {
    if (String(input).includes('/files') && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(conflict ? { error: 'FILE_CONTENT_CONFLICT' } : { file }), { status: conflict ? 409 : 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(String(input).includes('/files') ? initialSource : '{}', { headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); document.getElementById('width-inspector')?.remove(); vi.unstubAllGlobals(); localStorage.clear(); });
function Harness() {
  const [signal, setSignal] = useState<{ text: string; nonce: number; mode: 'append' }>();
  return <><ChatPane projectKindForTracking="prototype" projectId="p" projectFiles={[]} messages={[]} streaming={false} error={null} onEnsureProject={async () => 'p'} onSend={send} onStop={vi.fn()} conversations={[]} activeConversationId={null} onSelectConversation={vi.fn()} onDeleteConversation={vi.fn()} composerDraftSignal={signal} />
    <FileViewer projectId="p" projectKind="prototype" file={file} liveHtml={initialSource} manualEditPortalId="width-inspector" onRequestAgentDraft={(text) => setSignal({ text, nonce: 1, mode: 'append' })} /></>;
}
async function prepare(dirty = false) {
  render(<Harness />); await flushMounts(); typeInComposer('Keep my text');
  await act(async () => fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')));
  const frame = document.querySelector<HTMLIFrameElement>('iframe[data-readable-active="true"]')!;
  const post = (data: unknown) => act(async () => { window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow })); });
  await post({ type: 'readable-edit-select', target });
  if (dirty) await post({ type: 'readable-edit-text-commit', id: 'hero', value: 'Changed' });
  await post({ type: 'readable-edit-preview-style-applied', id: 'hero', version: 1000, ok: true, rect: target.rect,
    resize: { announce: true, decision: 'parent-owned', confidence: 'confirmed', requested: { width: 320, height: 48 }, actual: target.rect, availableContentWidth: 600,
      causes: [{ code: 'parent-flex-allocation', axis: 'width', confidence: 'confirmed', facts: { basis: '0px', direction: 'row' } }],
      constraints: [{ axis: 'width', requested: 320, applied: 160, reason: 'layout', confidence: 'confirmed', classification: 'parent-owned' }] } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Make this widenable' })));
}
it.each(['Save changes', 'Discard changes'])('gates a dirty request on explicit %s and leaves Send to the user', async (action) => {
  await prepare(true);
  expect(composerText()).toBe('Keep my text'); expect(posts).toHaveLength(0); expect(send).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: action })));
  const text = composerText();
  const payload = JSON.parse(text.split('<readable-width-request>')[1]!.split('</readable-width-request>')[0]!);
  expect(text.startsWith('Keep my text\n\n')).toBe(true);
  expect(payload).toMatchObject({ filePath: 'preview.html', target: { id: 'hero' }, requestedRectWidth: 320, actualRectWidth: 160, availableContentWidth: 600 });
  expect(payload.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(posts).toHaveLength(action === 'Save changes' ? 1 : 0);
  expect(document.querySelector('.manual-edit-left-inspector')).toBeNull();
  expect(send).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByTestId('chat-send')));
  expect(send).toHaveBeenCalledTimes(1);
});
it('uses the shipped Korean boundary explanation in the inspector and unsent draft for shared styles', async () => {
  // Given: exercise the real inspector/composer wiring, not prose wording.
  render(<I18nProvider initial="ko"><Harness /></I18nProvider>);
  await flushMounts();
  await act(async () => fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')));
  const frame = document.querySelector<HTMLIFrameElement>('iframe[data-readable-active="true"]');
  if (!frame?.contentWindow) throw new Error('Missing preview frame');
  const sender = frame.contentWindow;
  const causes = [{ code: 'shared-style-width', axis: 'width', confidence: 'confirmed', facts: {},
    declaration: { property: 'max-width', value: '65ch', priority: 'important', origin: 'stylesheet', selector: '.measure', conditions: [], complete: true } }];
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: sender, data: { type: 'readable-edit-select', target } }));
  });
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: sender, data: { type: 'readable-edit-preview-style-applied', id: 'hero', version: 1000, ok: true, rect: target.rect,
      resize: { announce: true, decision: 'refused', classification: 'shared-style', confidence: 'confirmed', requested: { width: 320, height: 48 }, actual: target.rect, causes,
        constraints: [{ axis: 'width', requested: 320, applied: 160, reason: 'max', property: 'max-width', value: '65ch', confidence: 'confirmed', causes }] } } }));
  });
  // When
  const explanation = getKo()['manualEdit.resize.sharedStyleLimit'];
  expect(screen.getAllByText(explanation).length).toBeGreaterThan(0);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: getKo()['manualEdit.resize.requestAgent'] })));
  // Then: shipped-copy equality guards localization wiring without pinning wording.
  expect(composerText().split('\n')[0]).toBe(explanation);
  const payload = JSON.parse(composerText().split('<readable-width-request>')[1]?.split('</readable-width-request>')[0] ?? 'null');
  expect(payload.causes).toEqual(causes);
  expect(posts).toHaveLength(0);
  expect(send).not.toHaveBeenCalled();
});

it('retains the inspector and request when Save conflicts', async () => {
  conflict = true; await prepare(true);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })));
  expect(posts).toHaveLength(1); expect(composerText()).toBe('Keep my text');
  expect(document.querySelector('.manual-edit-left-inspector')).not.toBeNull(); expect(send).not.toHaveBeenCalled();
});
it('does not prepare a stale target missing from saved source', async () => {
  initialSource = '<html><body><main data-readable-id="other">Other</main></body></html>';
  await prepare(); expect(composerText()).toBe('Keep my text'); expect(posts).toHaveLength(0);
  expect(document.querySelector('.manual-edit-left-inspector')).not.toBeNull(); expect(send).not.toHaveBeenCalled();
});
