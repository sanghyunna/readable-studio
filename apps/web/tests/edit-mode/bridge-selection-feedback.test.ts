import { expect, it, vi } from 'vitest';
import { JSDOM } from './bridge-dom';
import { buildManualEditBridge, manualEditStableIdForElement } from '../../src/edit-mode/bridge';
import type { ManualEditTarget } from '../../src/edit-mode/types';

type TargetsPacket = { type: 'readable-edit-targets'; targets: ManualEditTarget[] };

async function selectedFixture(targetCount = 3, sourcePathOnly = false) {
  vi.useFakeTimers();
  const shapes = Array.from({ length: targetCount }, (_, index) => {
    const id = index === 0 ? 'first' : index === 1 ? 'second' : `shape-${index}`;
    const identity = sourcePathOnly ? `data-readable-source-path="path-0-${index}"` : `data-readable-id="${id}"`;
    return `<p ${identity}>${index === 0 ? '제 1막, OO를 OO합니다.' : `Shape ${index}`}</p>`;
  }).join('');
  const dom = new JSDOM(
    `<main>${shapes}</main>${buildManualEditBridge(true)}`,
    { runScripts: 'dangerously', url: 'http://localhost' },
  );
  dom.window.Date = Date;
  await dom.loaded;
  await vi.runAllTimersAsync();
  const paragraphs = dom.window.document.querySelectorAll('p');
  const first = paragraphs[0]!;
  const second = paragraphs[1]!;
  const geometryReads = { count: 0 };
  for (const target of dom.window.document.querySelectorAll('p')) {
    target.getBoundingClientRect = () => {
      geometryReads.count++;
      const x = Number.parseFloat(target.style.left) || 0;
      return { x, y: 0, left: x, top: 0, right: x + 200, bottom: 40, width: 200, height: 40, toJSON: () => ({}) };
    };
  }
  const send = (data: object) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  const select = (id: string | null) => {
    const selectedId = sourcePathOnly && id ? id === 'first' ? 'path-0-0' : 'path-0-1' : id;
    send({ type: 'readable-edit-selected-target', id: selectedId, revision: 1, documentEpoch: 'document-a' });
  };
  const postMessage = vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(() => {});
  send({ type: 'readable-edit-mode', enabled: true, documentEpoch: 'document-a' });
  select('first');
  await vi.advanceTimersByTimeAsync(64);
  postMessage.mockClear();
  return { dom, first, second, select, postMessage, geometryReads };
}

it.each([3, 100])('quiesces discovery for %i shapes after host selection echoes while still reporting content and geometry changes', async (targetCount) => {
  const { dom, first, select, postMessage, geometryReads } = await selectedFixture(targetCount);
  const packets: TargetsPacket[] = [];
  postMessage.mockImplementation((message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)
      || message.type !== 'readable-edit-targets') return;
    packets.push(message as TargetsPacket);
    // The host restores its selected id after each discovered-target refresh.
    dom.window.setTimeout(() => select('first'), 0);
  });

  await dom.nextMutation(() => {
    first.textContent = '제 1막, 수정한 문장입니다.';
    first.style.left = '42px';
  });
  await vi.advanceTimersByTimeAsync(64);

  expect(packets.length).toBeGreaterThan(0);
  expect(packets.at(-1)?.targets).toHaveLength(targetCount);
  expect(packets.at(-1)?.targets.find((target) => target.id === 'first')).toMatchObject({
    text: '제 1막, 수정한 문장입니다.', rect: { x: 42, width: 200 },
  });
  const settledCount = packets.length;
  const settledGeometryReads = geometryReads.count;
  await vi.advanceTimersByTimeAsync(128);
  expect(packets).toHaveLength(settledCount);
  expect(geometryReads.count).toBe(settledGeometryReads);
  expect(first.getAttribute('data-readable-edit-selected')).toBe('true');
});

it.each([3, 100])('quiesces discovery for %i source-path shapes without any host selection echo', async (targetCount) => {
  const { postMessage, geometryReads } = await selectedFixture(targetCount, true);
  const settledGeometryReads = geometryReads.count;

  await vi.advanceTimersByTimeAsync(128);

  expect(postMessage).not.toHaveBeenCalled();
  expect(geometryReads.count).toBe(settledGeometryReads);
});

it('keeps the exported stable-id lookup read-only after a source-path identity is established', async () => {
  const dom = new JSDOM('<p data-readable-source-path="path-0">Shape</p>', { url: 'http://localhost' });
  const target = dom.window.document.querySelector('p')!;
  expect(manualEditStableIdForElement(target)).toBe('path-0');
  const records: MutationRecord[] = [];
  const observer = new dom.window.MutationObserver((changes) => records.push(...changes));
  observer.observe(target, { attributes: true });

  expect(manualEditStableIdForElement(target)).toBe('path-0');
  expect(manualEditStableIdForElement(target)).toBe('path-0');
  await Promise.resolve();
  observer.disconnect();

  expect(records).toEqual([]);
});

it('leaves selection attributes untouched when the host repeats the current selected id', async () => {
  const { dom, first, select } = await selectedFixture();
  const records: MutationRecord[] = [];
  const observer = new dom.window.MutationObserver((changes) => records.push(...changes));
  observer.observe(dom.window.document.body, {
    attributes: true, subtree: true, attributeFilter: ['data-readable-edit-selected'],
  });
  select('first');
  select('first');
  await vi.advanceTimersByTimeAsync(64);
  observer.disconnect();

  expect(first.getAttribute('data-readable-edit-selected')).toBe('true');
  expect(records).toEqual([]);
});

it('moves selection to a different shape and clears the previous shape', async () => {
  const { dom, first, second, select, postMessage } = await selectedFixture();
  select('second');
  await vi.advanceTimersByTimeAsync(64);

  expect(first.hasAttribute('data-readable-edit-selected')).toBe(false);
  expect(second.getAttribute('data-readable-edit-selected')).toBe('true');
  expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-targets' }), '*');

  select(null);
  await vi.advanceTimersByTimeAsync(64);
  expect(dom.window.document.querySelector('[data-readable-edit-selected]')).toBeNull();
});
