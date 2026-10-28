// @vitest-environment jsdom

import { expect, it, vi } from 'vitest';
import { MANUAL_EDIT_TARGET_SELECTOR } from '../../src/edit-mode/bridge';
import type { ManualEditTarget } from '../../src/edit-mode/types';
import { buildSrcdoc } from '../../src/runtime/srcdoc';
import { JSDOM } from './bridge-dom';

type Packet = { type: string; targets?: ManualEditTarget[]; target?: ManualEditTarget };

const source0 = '<main data-readable-id="canvas"><h1 data-readable-id="title">Title</h1><p>Paragraph</p><p>Cell</p></main>';
const source1 = source0.replace('>Title<', '>Title edited<');
const source2 = source1.replace('Paragraph', 'Paragraph two');

async function fixture(body = source0) {
  vi.useFakeTimers();
  const dom = new JSDOM(buildSrcdoc(body, { editBridge: true }), {
    runScripts: 'dangerously', url: 'http://localhost',
    beforeParse(window) {
      window.Date = Date;
      // Text-sized boxes keep discovery deterministic and make text edits move geometry.
      window.HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement) {
        const width = 100 + (this.textContent ?? '').length;
        return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 40, width, height: 40, toJSON: () => ({}) } as DOMRect;
      };
    },
  });
  await dom.loaded;
  const document = dom.window.document;
  // allTargets() is the only caller of body.querySelectorAll(targetSelector).
  const query = document.body.querySelectorAll.bind(document.body);
  let scans = 0;
  document.body.querySelectorAll = ((selector: string) => {
    if (selector === MANUAL_EDIT_TARGET_SELECTOR) scans++;
    return query(selector);
  }) as typeof document.body.querySelectorAll;
  const packets: Packet[] = [];
  vi.spyOn(dom.window.parent, 'postMessage').mockImplementation((message) => { packets.push(message as Packet); });
  const send = (data: object) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, source: dom.window.parent }));
  const targetPayloads = () => packets.filter((packet) => packet.type === 'readable-edit-targets').map((packet) => JSON.stringify(packet.targets));
  return { dom, document, packets, send, targetPayloads, scans: () => scans };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

// One host conversation: hover, host/hydrated/native selection, text-edit entry
// and exit, then the in-place source syncs that follow a save. Each step records
// its rediscovery count and every message the host received, in order.
async function converse(f: Fixture) {
  const title = f.document.querySelector('h1')!;
  const paragraph = f.document.querySelector('p')!;
  const scans: Record<string, number> = {};
  const messages: Record<string, string[]> = {};
  const step = async (name: string, run: () => void) => {
    const before = f.scans();
    const sent = f.packets.length;
    run();
    await vi.advanceTimersByTimeAsync(200);
    scans[name] = f.scans() - before;
    messages[name] = f.packets.slice(sent).map((packet) => packet.type);
  };
  await step('enable', () => f.send({ type: 'readable-edit-mode', enabled: true, documentEpoch: 'e1' }));
  await step('hover', () => paragraph.dispatchEvent(new f.dom.window.MouseEvent('pointerover', { bubbles: true })));
  await step('select', () => f.send({ type: 'readable-edit-select-target', id: 'path-0-1' }));
  await step('selected echo', () => f.send({ type: 'readable-edit-selected-target', id: 'path-0-1', revision: 1 }));
  await step('hydrate', () => f.send({ type: 'readable-edit-select-target', id: 'title', actionSeq: 1, documentEpoch: 'e1' }));
  await step('selected', () => f.send({ type: 'readable-edit-selected-target', id: 'title', revision: 1 }));
  await step('reclick', () => title.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));
  await step('enter', () => f.document.body.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  await step('begin', () => f.send({ type: 'readable-edit-begin-text-edit', id: 'title', selectAll: true }));
  await step('type', () => { title.textContent = 'Title edited'; });
  await step('end', () => f.send({ type: 'readable-edit-end-text-edit', documentEpoch: 'e1', requestId: 1 }));
  await step('sync commit', () => f.send({ type: 'readable-edit-preview-source', documentEpoch: 'e1', requestId: 1, beforeSource: source0, afterSource: source1, beforeId: 'title', afterId: 'title' }));
  await step('sync edit', () => f.send({ type: 'readable-edit-preview-source', documentEpoch: 'e1', requestId: 2, beforeSource: source1, afterSource: source2, beforeId: 'path-0-1', afterId: 'path-0-1' }));
  return { scans, messages };
}

function brief(payload: string) {
  return (JSON.parse(payload) as ManualEditTarget[]).map((target) =>
    `${target.id}${target.stylesMeasured === false ? '' : '*'} ${target.text} ${target.rect.width}`);
}

// The host merges each discovery target over the selected target it got from
// readable-edit-select (FileViewer), so the rediscovery that follows a probed
// selection is load-bearing, not redundant.
it('rediscovers once after every authored-size probe of a selection or text-edit request', async () => {
  const f = await fixture();
  expect((await converse(f)).scans).toEqual({
    enable: 2, // discovery, then the runtime-id stamps it wrote
    hover: 0,
    select: 1,
    'selected echo': 0,
    hydrate: 1,
    selected: 1,
    reclick: 1,
    enter: 1,
    begin: 0,
    type: 0,
    end: 1,
    'sync commit': 1,
    'sync edit': 1,
  });
});

it('delivers every host message and targets payload in order', async () => {
  const f = await fixture();
  expect((await converse(f)).messages).toEqual({
    enable: ['readable-edit-targets', 'readable-edit-targets'],
    hover: ['readable-edit-hover'],
    select: ['readable-edit-hover', 'readable-edit-select', 'readable-edit-targets'],
    'selected echo': [],
    hydrate: ['readable-edit-select', 'readable-edit-targets'],
    selected: ['readable-edit-targets'],
    reclick: ['readable-edit-select', 'readable-edit-targets'],
    enter: ['readable-edit-select', 'readable-edit-targets'],
    begin: ['readable-edit-selection-state', 'readable-edit-selection-state'],
    type: [],
    end: ['readable-edit-selection-state', 'readable-edit-text-commit', 'readable-edit-text-flushed', 'readable-edit-targets'],
    'sync commit': ['readable-edit-preview-source-applied', 'readable-edit-targets'],
    'sync edit': ['readable-edit-preview-source-applied', 'readable-edit-targets'],
  });
  const before = ['canvas TitleParagraphCell 118', 'title Title 105', 'path-0-1 Paragraph 109', 'path-0-2 Cell 104'];
  const paragraphSelected = ['canvas TitleParagraphCell 118', 'title Title 105', 'path-0-1* Paragraph 109', 'path-0-2 Cell 104'];
  const titleSelected = ['canvas TitleParagraphCell 118', 'title* Title 105', 'path-0-1 Paragraph 109', 'path-0-2 Cell 104'];
  const edited = ['canvas Title editedParagraphCell 125', 'title* Title edited 112', 'path-0-1 Paragraph 109', 'path-0-2 Cell 104'];
  expect(f.targetPayloads().map(brief)).toEqual([
    before, before, // enable
    paragraphSelected, // select
    paragraphSelected, // hydrate
    titleSelected, // selected
    titleSelected, // reclick
    titleSelected, // enter
    edited, // end
    edited, // sync commit
    ['canvas Title editedParagraph twoCell 129', 'title* Title edited 112', 'path-0-1 Paragraph two 113', 'path-0-2 Cell 104'], // sync edit
  ]);
});

it('follows a re-click select with the discovery shape of the same target', async () => {
  // A scaled deck: fractional used width, integer offsetWidth.
  const f = await fixture('<main data-readable-id="canvas"><p data-readable-id="para" style="width: 333.3px">Paragraph</p></main>');
  const paragraph = f.document.querySelector('p')!;
  paragraph.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 166.65, bottom: 40, width: 166.65, height: 40, toJSON: () => ({}) } as DOMRect);
  Object.defineProperty(paragraph, 'offsetWidth', { configurable: true, get: () => 333 });
  const click = () => paragraph.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  f.send({ type: 'readable-edit-mode', enabled: true, documentEpoch: 'e1' });
  click();
  f.send({ type: 'readable-edit-selected-target', id: 'para', revision: 1 });
  await vi.advanceTimersByTimeAsync(200);
  const sent = f.packets.length;

  click();
  await vi.advanceTimersByTimeAsync(200);

  const reply = f.packets.slice(sent);
  expect(reply.map((packet) => packet.type)).toEqual(['readable-edit-select', 'readable-edit-targets']);
  const select = reply[0]!, targets = reply[1]!;
  expect(select.target).toMatchObject({ id: 'para', rectScale: { x: 0.5, y: 1 }, hasInlineStyle: true });
  expect(select.target!.outerHtml).toContain('width: 333.3px');
  expect(select.target!.inlineDeclarations).toEqual([{ property: 'width', value: '333.3px', priority: '' }]);
  const discovered = targets.targets!.find((target) => target.id === 'para')!;
  expect(discovered).toMatchObject({ rectScale: { x: 0.5005, y: 1 }, outerHtml: '' });
  expect(discovered).not.toHaveProperty('inlineDeclarations');
  expect(discovered).not.toHaveProperty('hasInlineStyle');
});

it('rediscovers when a host alias re-selects a node by its canonical id', async () => {
  // The host can address a node by its stamped runtime alias; a native click then
  // selects the same node by its canonical id without any attribute mutation.
  const f = await fixture('<main data-readable-id="canvas"><p data-readable-id="para" data-readable-runtime-id="alias">Paragraph</p></main>');
  f.send({ type: 'readable-edit-mode', enabled: true, documentEpoch: 'e1' });
  f.send({ type: 'readable-edit-selected-target', id: 'alias', revision: 1 });
  await vi.advanceTimersByTimeAsync(200);
  const paragraph = f.document.querySelector('p')!;
  expect(paragraph.hasAttribute('data-readable-edit-selected')).toBe(true);
  expect(brief(f.targetPayloads().at(-1)!)).toEqual(['canvas Paragraph 109', 'para Paragraph 109']);
  const before = f.scans();

  paragraph.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  await vi.advanceTimersByTimeAsync(200);

  expect(f.scans() - before).toBe(1);
  expect(brief(f.targetPayloads().at(-1)!)).toEqual(['canvas Paragraph 109', 'para* Paragraph 109']);
});

it('rediscovers a document change that shares a task with a probed selection', async () => {
  const f = await fixture();
  await converse(f);
  const paragraph = f.document.querySelector('p')!;
  const before = f.scans();

  f.send({ type: 'readable-edit-select-target', id: 'title', actionSeq: 2, documentEpoch: 'e1' });
  paragraph.textContent = 'Paragraph three';
  await vi.advanceTimersByTimeAsync(200);

  expect(f.scans() - before).toBe(1);
  expect(brief(f.targetPayloads().at(-1)!)).toContain('path-0-1 Paragraph three 115');
});

it('rediscovers an inline style write measured with its authored size', async () => {
  const f = await fixture();
  await converse(f);
  const before = f.scans();

  f.send({ type: 'readable-edit-preview-style', id: 'path-0-1', styles: { width: '140px' }, version: 3, includeAuthoredSize: true });
  await vi.advanceTimersByTimeAsync(200);

  expect(f.document.querySelector('p')!.style.width).toBe('140px');
  expect(f.scans() - before).toBe(1);
  expect(JSON.parse(f.targetPayloads().at(-1)!)[2].attributes.style).toBe('width: 140px;');
});
