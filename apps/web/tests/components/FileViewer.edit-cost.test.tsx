// @vitest-environment jsdom
import { Profiler, type ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import { buildManualEditBridge } from '../../src/edit-mode/bridge';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import { JSDOM } from '../edit-mode/bridge-dom';
import type { ProjectFile } from '../../src/types';
import { linkedAssetRequests, linkedCss, linkedInlinedCss, linkedFile, linkedHtml, linkedTarget } from './file-viewer-linked-assets';

const linkedControls = vi.hoisted(() => ({
  props: null as ComponentProps<typeof import('../../src/components/ManualEditShapeControls').ManualEditShapeControls> | null,
}));
vi.mock('../../src/components/ManualEditShapeControls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/components/ManualEditShapeControls')>();
  return {
    ...actual,
    ManualEditShapeControls: (props: ComponentProps<typeof actual.ManualEditShapeControls>) => {
      linkedControls.props = props;
      return <actual.ManualEditShapeControls {...props} />;
    },
  };
});

const html = '<!doctype html><html><head><style>p{width:640px;color:#123456}</style></head><body><main>'
  + Array.from({ length: 120 }, (_, i) => `<p data-readable-id="p${i}">${'Realistic document paragraph with editable content and layout. '.repeat(8)}</p>`).join('')
  + '</main></body></html>';
const file: ProjectFile = { name: 'preview.html', path: 'preview.html', type: 'file', size: html.length, mtime: 1, mime: 'text/html', kind: 'html' };
const target: ManualEditTarget = {
  id: 'p0', kind: 'text', label: 'Paragraph', tagName: 'p', className: '', text: 'Paragraph',
  rect: { x: 0, y: 0, width: 640, height: 80 }, fields: {}, attributes: {},
  styles: emptyManualEditStyles(), isLayoutContainer: false, outerHtml: '',
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  linkedControls.props = null;
  window.history.replaceState(null, '', '/');
});

async function setup() {
  const writes: string[] = [];
  const requestBytes: number[] = [];
  let completeSave = () => {};
  const saved = new Promise<void>((resolve) => { completeSave = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = String(init.body);
      const payload: { content: string } = JSON.parse(body);
      writes.push(payload.content);
      requestBytes.push(new TextEncoder().encode(body).byteLength);
      return new Response(JSON.stringify({ file }), { status: 200 });
    }
    return new Response(html, { status: 200 });
  }));
  const commits = vi.fn();
  await act(async () => { render(<Profiler id="viewer" onRender={commits}><FileViewer projectId="cost" projectKind="prototype" file={file} liveHtml={html} onFileSaved={completeSave} /></Profiler>); });
  fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
  const frame = screen.getByTestId('artifact-preview-frame');
  if (!(frame instanceof HTMLIFrameElement) || !frame.contentWindow) throw new Error('Missing preview frame');
  const frames: FrameRequestCallback[] = [];
  const dom = new JSDOM(`${html}${buildManualEditBridge(true)}`, {
    runScripts: 'dangerously', url: window.location.href,
    beforeParse(window) {
      window.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
      window.cancelAnimationFrame = () => { frames.length = 0; };
      window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 640, height: 80, top: 0, left: 0, right: 640, bottom: 80, toJSON: () => ({}) });
    },
  });
  await dom.loaded;
  const inbound: unknown[] = [];
  const messages: unknown[] = [];
  dom.window.parent.postMessage = (data: unknown) => { inbound.push(data); messages.push(data); };
  const outgoing = vi.spyOn(frame.contentWindow, 'postMessage').mockImplementation((data) => {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  });
  const dispatch = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data }));
  const drain = async () => { await act(async () => { while (inbound.length) dispatch(inbound.shift()); }); };
  const flushFrames = async () => {
    const pending = frames.splice(0);
    for (const callback of pending) callback(0);
    await drain();
  };
  await act(async () => { fireEvent.load(frame); });
  await drain();
  const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
  const styles = vi.spyOn(dom.window, 'getComputedStyle');
  return { dom, writes, requestBytes, saved, commits, messages, outgoing, dispatch, drain, flushFrames, parse, styles };
}

it('avoids repeated source parsing when selecting an object in a 120-paragraph document', async () => {
  // Given
  const h = await setup();
  h.parse.mockClear();
  h.commits.mockClear();
  // When
  await act(async () => { h.dispatch({ type: 'readable-edit-select', target }); });
  // Then
  expect(h.parse).toHaveBeenCalledTimes(1);
});

it('keeps unchanged caret state local while typing and durably saves the final text once', async () => {
  // Given
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  const h = await setup();
  await act(async () => { h.dispatch({ type: 'readable-edit-select', target, beginTextEdit: true }); });
  await h.drain();
  await h.flushFrames();
  // Finish mode-entry scroll restoration before measuring typing. Execute
  // queued timers during each keystroke too, so deferred typing work is counted.
  await act(async () => { await vi.runAllTimersAsync(); });
  const el = h.dom.window.document.querySelector('p');
  if (!el?.firstChild) throw new Error('Missing text');
  h.messages.length = 0;
  h.outgoing.mockClear();
  h.commits.mockClear();
  h.styles.mockClear();
  h.parse.mockClear();
  // When: each keystroke has its own DOM mutation, selection event and render frame.
  for (let i = 0; i < 12; i++) {
    await h.dom.nextMutation(() => { el.textContent += 'x'; });
    const range = h.dom.window.document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    h.dom.window.getSelection()?.removeAllRanges();
    h.dom.window.getSelection()?.addRange(range);
    h.dom.window.document.dispatchEvent(new h.dom.window.Event('selectionchange'));
    await h.flushFrames();
    await act(async () => { await vi.runAllTimersAsync(); });
  }
  // Then
  const typing = { bridge: h.messages.length + h.outgoing.mock.calls.length, commits: h.commits.mock.calls.length, computedStyles: h.styles.mock.calls.length, parses: h.parse.mock.calls.length };
  h.messages.length = 0;
  h.outgoing.mockClear();
  h.commits.mockClear();
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  await h.drain();
  await act(async () => { await h.saved; });
  expect(h.writes).toHaveLength(1);
  expect(h.writes[0]).toContain('xxxxxxxxxxxx</p>');
  expect(typing).toEqual({ bridge: 0, commits: 0, computedStyles: 0, parses: 0 });
});

it('parses a pending style only for its patch and reconciliation when saving', async () => {
  // Given
  const h = await setup();
  await act(async () => { h.dispatch({ type: 'readable-edit-select', target }); });
  expect(linkedControls.props).not.toBeNull();
  await act(async () => { linkedControls.props!.onStyleField('color', '#ef4444'); });
  await h.drain();
  h.parse.mockClear();
  h.commits.mockClear();
  h.messages.length = 0;
  h.outgoing.mockClear();
  // When
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });
  await act(async () => { await h.saved; });
  // Then
  expect(h.writes).toHaveLength(1);
  expect(h.writes[0]).toContain('color: rgb(239, 68, 68)');
  // Patch + reconciliation + the existing two preview-annotation parses.
  expect(h.parse).toHaveBeenCalledTimes(4);
});

async function setupLinked(schedule: 'resolved' | 'pending', css = linkedCss) {
  window.history.replaceState(null, '', '/?forceInline=1');
  const requests = linkedAssetRequests(css);
  vi.stubGlobal('fetch', vi.fn(requests.fetch));
  const srcdocTransitions: string[] = [];
  const recordSrcdoc = () => {
    const current = window.document.querySelector<HTMLIFrameElement>('[data-testid="artifact-preview-frame"]')?.srcdoc;
    if (current && srcdocTransitions.at(-1) !== current) srcdocTransitions.push(current);
  };
  const view = render(<Profiler id="linked-viewer" onRender={recordSrcdoc}>
    <FileViewer projectId="linked" projectKind="prototype" file={linkedFile} liveHtml={linkedHtml} />
  </Profiler>);
  await act(async () => {});
  expect(requests.pending).toHaveLength(1);
  if (schedule === 'resolved') {
    await act(async () => { requests.resolve(0); });
  }
  requests.boundary('frozen');
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  const entry = frame.srcdoc;
  const dom = new JSDOM(entry, {
    runScripts: 'dangerously', url: window.location.href,
    beforeParse(window) {
      // jsdom omits element scrolling; the bridge reads the resulting coordinates.
      if (!window.Element.prototype.scrollTo) {
        window.Element.prototype.scrollTo = function (this: Element, position?: number | ScrollToOptions, top?: number) {
          const options = typeof position === 'number' ? { left: position, top } : position;
          if (options?.left !== undefined) this.scrollLeft = options.left;
          if (options?.top !== undefined) this.scrollTop = options.top;
        };
      }
    },
  });
  await dom.loaded;
  dom.window.parent.postMessage = (data: unknown) => {
    window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow }));
  };
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((data: unknown) => {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, source: dom.window.parent }));
  });
  await act(async () => { fireEvent.load(frame); });
  const document = () => frame.srcdoc === entry ? dom.window.document : new DOMParser().parseFromString(frame.srcdoc, 'text/html');
  const select = async () => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: frame.contentWindow, data: { type: 'readable-edit-select', target: linkedTarget },
      }));
    });
    expect(linkedControls.props).not.toBeNull();
  };
  const patch = async (kind: 'style' | 'remove') => {
    await select();
    await act(async () => {
      linkedControls.props!.onApplyPatch(
        kind === 'style' ? { kind: 'set-style', id: 'hero', styles: { color: '#ef4444' } }
          : { kind: 'remove-element', id: 'hero' },
        kind,
      );
    });
  };
  return { requests, view, frame, entry, document, select, patch, srcdocTransitions };
}

it.each(['resolved', 'pending'] as const)('pins linked frozen entry with assets %s before entry', async (schedule) => {
  const h = await setupLinked(schedule);
  const entry = h.document();
  expect(entry.querySelector('base')?.href).toContain('/api/projects/linked/raw/');
  expect(entry.querySelector('img')?.getAttribute('src')).toBe('assets/images/photo.svg');
  if (schedule === 'resolved') {
    expect(entry.querySelector('style[data-readable-inline-asset]')?.textContent).toContain(linkedInlinedCss);
    expect(entry.querySelector('link[rel="stylesheet"]')).toBeNull();
  } else {
    expect(entry.querySelector('link[rel="stylesheet"]')?.getAttribute('href')).toBe('assets/css/site.css');
    await act(async () => { h.requests.resolve(0); });
    expect(h.frame.srcdoc).toBe(h.entry);
  }
  expect(h.requests.timeline.filter((event) => event.kind === 'inliner-fetch')).toEqual([
    expect.objectContaining({ phase: 'before-entry' }),
  ]);
  console.info('linked-entry-timeline', schedule, JSON.stringify(h.requests.timeline));
});

it.each(['resolved', 'pending'] as const)('does no redundant linked inliner fetches while frozen after style and remove (%s entry)', async (schedule) => {
  const h = await setupLinked(schedule);
  if (schedule === 'pending') await act(async () => { h.requests.resolve(0); });
  await h.patch('style');
  expect(h.frame.srcdoc).toBe(h.entry);
  const afterStyle = h.requests.timeline.filter((event) => event.phase === 'frozen' && event.kind === 'inliner-fetch').length;
  await h.patch('remove');
  expect(h.document().querySelector('[data-readable-id="hero"]')).toBeNull();
  if (schedule === 'resolved') expect(h.document().querySelector('style[data-readable-inline-asset]')?.textContent).toContain(linkedInlinedCss);
  else expect(h.document().querySelector('link[rel="stylesheet"]')?.getAttribute('href')).toBe('assets/css/site.css');
  expect(h.frame.srcdoc).toBe(h.entry);
  expect(h.document().querySelector('base')?.href).toContain('/api/projects/linked/raw/');
  // Complete every observed request, including work started before entry,
  // without resetting counters or hiding continuation work.
  await act(async () => {
    h.requests.pending.forEach((request, index) => { if (!request.completed) h.requests.resolve(index); });
  });
  const afterRemove = h.requests.timeline.filter((event) => event.phase === 'frozen' && event.kind === 'inliner-fetch').length;
  expect(h.requests.writes).toHaveLength(0);
  console.info('linked-frozen-timeline', schedule, JSON.stringify({ afterStyle, afterRemove, timeline: h.requests.timeline }));
  expect({ afterStyle, afterRemove }).toEqual({ afterStyle: 0, afterRemove: 0 });
});

it('runs one linked inlining pass on eligible exit and preserves the image and CSS', async () => {
  const h = await setupLinked('resolved');
  const exitTransitionStart = h.srcdocTransitions.length;
  h.requests.boundary('exit');
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  const exitRequests = h.requests.timeline.filter((event) => event.phase === 'exit' && event.kind === 'inliner-fetch');
  await act(async () => {
    h.requests.pending.forEach((request, index) => { if (!request.completed) h.requests.resolve(index); });
  });
  console.info('linked-exit-timeline', JSON.stringify(h.requests.timeline));
  console.info('linked-exit-srcdoc-transitions', JSON.stringify(h.srcdocTransitions.slice(exitTransitionStart).map((srcdoc) => {
    const doc = new DOMParser().parseFromString(srcdoc, 'text/html');
    return {
      inlined: doc.querySelector('style[data-readable-inline-asset]') !== null,
      stylesheet: doc.querySelector('link[rel="stylesheet"]')?.getAttribute('href') ?? null,
      base: doc.querySelector('base')?.href,
      image: doc.querySelector('img')?.getAttribute('src'),
    };
  })));
  expect(h.document().querySelector('img')?.getAttribute('src')).toBe('assets/images/photo.svg');
  expect(h.document().querySelector('style[data-readable-inline-asset]')?.textContent).toContain(linkedInlinedCss);
  expect(exitRequests).toHaveLength(1);
});

it('resolves nested CSS image URLs equivalently before and after linked inlining', async () => {
  const h = await setupLinked('resolved');
  const doc = h.document();
  const base = doc.querySelector('base')!.href;
  const css = doc.querySelector('style[data-readable-inline-asset]')!.textContent!;
  const imageRef = /url\(["']?([^"')]+)["']?\)/.exec(css)![1];
  if (imageRef === undefined) throw new Error('Expected an image URL in the inlined stylesheet');
  const linkedStylesheet = new URL('assets/css/site.css', base);
  const beforeInlining = new URL('../images/pattern.svg', linkedStylesheet).href;
  const afterInlining = new URL(imageRef, base).href;
  expect(afterInlining).toBe(beforeInlining);
});

it('keeps a rejected stylesheet raw with its base and does not write the document', async () => {
  const h = await setupLinked('pending');
  await act(async () => { h.requests.resolve(0, 503); });
  expect(h.frame.srcdoc).toBe(h.entry);
  expect(h.document().querySelector('link[rel="stylesheet"]')?.getAttribute('href')).toBe('assets/css/site.css');
  expect(h.document().querySelector('base')?.href).toContain('/api/projects/linked/raw/');
  expect(h.requests.writes).toHaveLength(0);
});

it('ignores a late linked stylesheet response after switching documents', async () => {
  const h = await setupLinked('pending');
  const next = '<!doctype html><html><body><p>Different document</p></body></html>';
  await act(async () => {
    h.view.rerender(<Profiler id="linked-viewer" onRender={() => {}}>
      <FileViewer projectId="other" projectKind="prototype"
        file={{ ...linkedFile, name: 'other.html', path: 'other.html' }} liveHtml={next} />
    </Profiler>);
  });
  await act(async () => { h.requests.resolve(0); });
  expect(h.frame.srcdoc).toContain('Different document');
  expect(h.frame.srcdoc).not.toContain('data-readable-inline-asset');
  expect(h.frame.srcdoc).not.toContain('Fixture photo');
  expect(h.requests.writes).toHaveLength(0);
});

it('rebases quoted, unquoted and import CSS references without changing absolute references', async () => {
  const css = '@import "../theme.css";@import url(\'../print.css\');'
    + '.pattern{background:url(../images/pattern.svg);mask:url(\'../images/mask.svg\');'
    + '--https:url("https://example.com/a.svg");--data:url("data:image/svg+xml,x");'
    + '--blob:url(blob:fixture);--fragment:url(#mask);--protocol:url(//example.com/a.svg);'
    + '--root:url("/root.svg")}';
  const h = await setupLinked('resolved', css);
  const inlined = h.document().querySelector('style[data-readable-inline-asset]')!.textContent!;
  const root = 'http://localhost:3000/api/projects/linked/raw/assets/';
  expect(inlined).toContain(`@import "${root}theme.css"`);
  expect(inlined).toContain(`@import url('${root}print.css')`);
  expect(inlined).toContain(`url(${root}images/pattern.svg)`);
  expect(inlined).toContain(`url('${root}images/mask.svg')`);
  for (const ref of ['"https://example.com/a.svg"', '"data:image/svg+xml,x"', 'blob:fixture', '#mask', '//example.com/a.svg', '"/root.svg"']) {
    expect(inlined).toContain(`url(${ref})`);
  }
});

it.each(['Save changes', 'Discard changes'])('re-inlines once after %s and freezes the current source on re-entry', async (action) => {
  const h = await setupLinked('resolved');
  await h.patch('remove');
  h.requests.boundary('exit');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: action })); });
  expect(h.requests.timeline.filter((event) => event.phase === 'exit' && event.kind === 'inliner-fetch')).toHaveLength(1);
  await act(async () => { h.requests.resolve(h.requests.pending.length - 1); });
  expect(h.document().querySelector('[data-readable-id="hero"]') === null).toBe(action === 'Save changes');
  expect(h.document().querySelector('style[data-readable-inline-asset]')).not.toBeNull();
  expect(h.requests.writes).toHaveLength(action === 'Save changes' ? 1 : 0);
  h.requests.boundary('re-entry');
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  expect(h.requests.timeline.filter((event) => event.phase === 're-entry' && event.kind === 'inliner-fetch')).toHaveLength(0);
  expect(h.document().querySelector('[data-readable-id="hero"]') === null).toBe(action === 'Save changes');
});

it('keeps explicit reload and source-mode transitions frozen until normal exit', async () => {
  const h = await setupLinked('resolved');
  await h.patch('remove');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload Preview' })); });
  await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Code' })); });
  expect(h.requests.timeline.filter((event) => event.phase === 'frozen' && event.kind === 'inliner-fetch')).toHaveLength(0);
  expect(h.requests.writes).toHaveLength(0);
});

it('ignores an unfrozen exit pass that resolves after another document opens', async () => {
  const h = await setupLinked('resolved');
  await act(async () => { fireEvent.click(screen.getByTestId('manual-edit-mode-toggle')); });
  expect(h.requests.pending).toHaveLength(2);
  const next = '<!doctype html><html><body><p>Current document</p></body></html>';
  await act(async () => {
    h.view.rerender(<Profiler id="linked-viewer" onRender={() => {}}>
      <FileViewer projectId="other" projectKind="prototype"
        file={{ ...linkedFile, name: 'other.html', path: 'other.html' }} liveHtml={next} />
    </Profiler>);
  });
  await act(async () => { h.requests.resolve(1); });
  expect(h.frame.srcdoc).toContain('Current document');
  expect(h.frame.srcdoc).not.toContain('Fixture photo');
  expect(h.frame.srcdoc).not.toContain('data-readable-inline-asset');
});
