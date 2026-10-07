// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewDrawOverlay, ANNOTATION_EVENT, type AnnotationEventDetail } from '../../src/components/PreviewDrawOverlay';
import { ChatComposer } from '../../src/components/ChatComposer';
import { ChatPane } from '../../src/components/ChatPane';
import { requireModelSelection, MODEL_SELECTION_REQUIRED_EVENT } from '../../src/components/agentModelSelection';
import { getKo } from '../../src/i18n/locales/ko';
const ko = getKo();

vi.mock('../../src/i18n', async () => {
  const { getKo } = await import('../../src/i18n/locales/ko');
  const dict = getKo();
  return { useT: () => (key: keyof typeof dict) => dict[key], useI18n: () => ({ locale: 'ko', t: (key: keyof typeof dict) => dict[key] }) };
});
vi.mock('../../src/state/mcp', () => ({ fetchMcpServers: async () => null }));
vi.mock('../../src/state/projects', () => ({ listPlugins: async () => [], patchProject: async () => null }));
vi.mock('../../src/providers/registry', () => ({ projectRawUrl: () => '', uploadProjectFiles: async () => ({ uploaded: [{ path: 'shot.png', name: 'shot.png', kind: 'image' }], failed: [] }) }));
const frames: FrameRequestCallback[] = [];
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 200, width: 320, height: 200, toJSON: () => ({}) });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, { get: () => () => {} }) as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(cb => cb(new Blob(['png'], { type: 'image/png' })));
  vi.stubGlobal('Image', class { onload?: () => void; set src(_: string) { queueMicrotask(() => this.onload?.()); } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); frames.length = 0; });
function mount(streaming = false, onSend = vi.fn(), guard = vi.fn(() => true), captureSnapshot?: () => Promise<{ dataUrl: string; w: number; h: number } | null>) {
  render(<ChatComposer projectId="p" projectFiles={[]} streaming={streaming} modelSelectionGuard={guard} onEnsureProject={async () => 'p'} onSend={onSend} onStop={vi.fn()} />);
  function DrawOwner() {
    const [active, setActive] = useState(true);
    return <PreviewDrawOverlay active={active} onActiveChange={setActive} sendDisabled={streaming} captureViewport={Boolean(captureSnapshot)} captureSnapshot={captureSnapshot} captureTarget={captureSnapshot ? { position: { x: 20, y: 20, width: 100, height: 80 } } : null}><iframe /></PreviewDrawOverlay>;
  }
  const ui = render(<DrawOwner />);
  const input = ui.container.querySelector<HTMLInputElement>('.preview-draw-note-input')!;
  fireEvent.change(input, { target: { value: '한국어 명령' } });
  return { ui, input, onSend, guard };
}
function nextAck() {
  return new Promise<{ ok: boolean; outcome?: string; message?: string }>((resolve, reject) => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<AnnotationEventDetail>).detail;
      const ack = detail.ack;
      detail.ack = result => { window.clearTimeout(timeout); ack?.(result); resolve(result); };
    };
    const timeout = window.setTimeout(() => {
      window.removeEventListener(ANNOTATION_EVENT, listener, true);
      reject(new Error('Annotation ACK missing'));
    }, 2000);
    window.addEventListener(ANNOTATION_EVENT, listener, { once: true, capture: true });
  });
}
async function enter(input: HTMLInputElement) {
  const ack = nextAck();
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); while (frames.length) frames.shift()!(0); await ack; });
  return ack;
}
describe('screenshot floating prompt', () => {
  it.each([
    { streaming: false, trigger: 'enter' },
    { streaming: true, trigger: 'enter' },
    { streaming: false, trigger: 'send' },
    { streaming: true, trigger: 'queue' },
  ])('keeps chrome hidden from capture through accepted close ($trigger, streaming=$streaming)', async ({ streaming, trigger }) => {
    let accept!: (result: 'queued' | undefined) => void;
    let sent!: () => void;
    const sentSignal = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Send not reached')), 2000);
      sent = () => { window.clearTimeout(timeout); resolve(); };
    });
    const result = new Promise<'queued' | undefined>(resolve => { accept = resolve; });
    const onSend = vi.fn<(...args: unknown[]) => Promise<'queued' | undefined>>(() => { sent(); return result; });
    const capture = vi.fn(async () => ({ dataUrl: 'data:image/png;base64,AAAA', w: 320, h: 200 }));
    const { ui, input } = mount(streaming, onSend, vi.fn(() => true), capture);
    const toolbar = ui.container.querySelector<HTMLElement>('.preview-draw-toolbar')!;
    const ack = nextAck();
    try {
      await act(async () => {
        if (trigger === 'enter') fireEvent.keyDown(input, { key: 'Enter' });
        else fireEvent.click(within(toolbar).getByRole('button', { name: ko[trigger === 'send' ? 'chat.send' : 'chat.annotationQueue'] }));
        while (frames.length) frames.shift()!(0);
        await sentSignal;
      });
      expect(capture).toHaveBeenCalledTimes(1);
      expect(onSend.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'shot.png', kind: 'image' })]));
      expect(toolbar.style.visibility).toBe('hidden');
      await act(async () => { accept(streaming ? 'queued' : undefined); await ack; });
      expect(ui.container.querySelector('.preview-draw-toolbar')).toBeNull();
      expect(ui.container.querySelector('canvas')).toBeNull();
      expect(toolbar.style.visibility).toBe('hidden');
    } finally { accept(undefined); await ack; }
  });
  it('explicit add to input keeps draw mode open and clears its staged note', async () => {
    const { ui, input, onSend } = mount(false, vi.fn(), vi.fn(() => true), async () => ({ dataUrl: 'data:image/png;base64,AAAA', w: 320, h: 200 }));
    const ack = nextAck();
    await act(async () => {
      fireEvent.click(ui.getByRole('button', { name: ko['chat.annotationAddToInput'] }));
      while (frames.length) frames.shift()!(0);
      await ack;
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe('');
    expect(ui.container.querySelector<HTMLElement>('.preview-draw-toolbar')?.style.visibility).toBe('');
  });
  it('idle Enter sends without queueOnly and closes the accepted prompt', async () => {
    const { input, onSend } = mount();
    expect((await enter(input)).ok).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[3]?.queueOnly).not.toBe(true);
    expect(input.isConnected).toBe(false);
  });
  it('streaming Enter queues and closes the accepted prompt', async () => {
    const { input, onSend } = mount(true);
    expect((await enter(input)).ok).toBe(true);
    expect(onSend.mock.calls[0]?.[3]?.queueOnly).toBe(true);
    expect(input.isConnected).toBe(false);
  });
  it('awaits a real downstream rejection and retains the note', async () => {
    const onSend = vi.fn(async () => false);
    const { input, ui } = mount(false, onSend, vi.fn(() => true), async () => ({ dataUrl: 'data:image/png;base64,AAAA', w: 320, h: 200 }));
    expect((await enter(input)).ok).toBe(false);
    expect(input.value).toBe('한국어 명령');
    expect(input.isConnected).toBe(true);
    expect(ui.container.querySelector<HTMLElement>('.preview-draw-toolbar')?.style.visibility).toBe('');
    expect(ui.container.querySelector('[role=status]')).not.toBeNull();
  });
  it('ChatPane forwards a downstream rejection instead of acknowledging callback invocation', async () => {
    const onSend = vi.fn(async () => false);
    render(<ChatPane messages={[]} streaming={false} error={null} projectId="p" projectFiles={[]}
      conversations={[]} activeConversationId={null} onSelectConversation={vi.fn()} onDeleteConversation={vi.fn()}
      onEnsureProject={async () => 'p'} onSend={onSend} onStop={vi.fn()} />);
    const ack = nextAck();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(ANNOTATION_EVENT, { detail: { file: null, note: 'retry', action: 'send' } }));
      expect(await ack).toMatchObject({ ok: false, outcome: 'rejected' });
    });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
  it('accepts a downstream queued outcome', async () => {
    const onSend = vi.fn(async () => 'queued' as const);
    const { input } = mount(true, onSend);
    expect(await enter(input)).toMatchObject({ ok: true, outcome: 'queued' });
    expect(input.isConnected).toBe(false);
  });
  it('missing model invokes the shared guard feedback and keeps the note', async () => {
    const warned = vi.fn();
    window.addEventListener(MODEL_SELECTION_REQUIRED_EVENT, warned, { once: true });
    const guard = vi.fn(() => requireModelSelection({ mode: 'daemon', model: '', agentId: 'a', agentModels: {} }, [{ id: 'a', name: 'A', bin: 'a', available: true, models: [{ id: 'm', label: 'M' }] }]));
    const { input, ui, onSend } = mount(false, vi.fn(), guard, async () => ({ dataUrl: 'data:image/png;base64,AAAA', w: 320, h: 200 }));
    expect((await enter(input)).ok).toBe(false);
    expect(warned).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe('한국어 명령');
    expect(input.isConnected).toBe(true);
    expect(ui.container.querySelector<HTMLElement>('.preview-draw-toolbar')?.style.visibility).toBe('');
  });
  it.each([{ isComposing: true }, { keyCode: 229 }])('does not submit native Korean composition Enter %j', evidence => {
    const { input, onSend } = mount();
    fireEvent.compositionStart(input);
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter', ...evidence });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe('한국어 명령');
  });
  it('capture rejection displays a localized warning, retains text and region, and clears pending', async () => {
    const error = Object.assign(new Error('capture failed'), { code: 'CAPTURE_REFLOWED' });
    const capture = vi.fn<() => Promise<{ dataUrl: string; w: number; h: number } | null>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue({ dataUrl: 'data:image/png;base64,AAAA', w: 320, h: 200 });
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { input, ui, onSend } = mount(false, vi.fn(), vi.fn(() => true), capture);
    const annotation = vi.fn();
    window.addEventListener(ANNOTATION_EVENT, annotation);
    // Observe the exact warning insertion before triggering capture.
    const warning = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => { observer.disconnect(); reject(new Error('Capture warning missing')); }, 2000);
      const observer = new MutationObserver(() => {
        if (ui.container.querySelector('[role=status]')) { window.clearTimeout(timeout); observer.disconnect(); resolve(); }
      });
      observer.observe(ui.container, { childList: true, subtree: true });
    });
    try {
      await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); while (frames.length) frames.shift()!(0); });
      await warning;
      expect(ui.container.querySelector('[role=status]')?.textContent).toContain(ko['chat.annotationCaptureFailed']);
      expect(input.value).toBe('한국어 명령');
      expect(input.disabled).toBe(false);
      expect(input.isConnected).toBe(true);
      expect(ui.container.querySelector<HTMLElement>('.preview-draw-toolbar')?.style.visibility).toBe('');
      expect(onSend).not.toHaveBeenCalled();
      expect(annotation).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ code: 'CAPTURE_REFLOWED' }));
      expect((await enter(input)).ok).toBe(true);
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(annotation.mock.calls[0]?.[0].detail).toMatchObject({ bounds: { x: 20, y: 20, width: 100, height: 80 } });
      expect(input.isConnected).toBe(false);
    } finally { window.removeEventListener(ANNOTATION_EVENT, annotation); }
  });
});
