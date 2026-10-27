import { expect, it, vi } from 'vitest';
import { buildManualEditBridge } from '../../src/edit-mode/bridge';
import type { ManualEditTarget } from '../../src/edit-mode/types';
import { JSDOM } from './bridge-dom';

type TargetPacket = { type: string; targets?: ManualEditTarget[]; target?: ManualEditTarget };

async function discoveryFixture(count = 3) {
  vi.useFakeTimers();
  const shapes = Array.from({ length: count }, (_, index) =>
    `<p data-readable-id="shape-${index}" class="${index === 0 ? 'first' : 'other'}">Shape ${index}</p>`,
  ).join('');
  const dom = new JSDOM(`<style>
    .first { font-size: 24px; font-weight: 400; color: rgb(10, 20, 30); }
    .other { font-size: 36px; font-weight: 700; color: rgb(40, 50, 60); }
    .emphasis { font-size: 32px; font-weight: 900; color: rgb(70, 80, 90); }
  </style><main>${shapes}</main>${buildManualEditBridge(true)}`, {
    runScripts: 'dangerously', url: 'http://localhost',
  });
  dom.window.Date = Date;
  await dom.loaded;
  await vi.runAllTimersAsync();
  const elements = Array.from(dom.window.document.querySelectorAll<HTMLParagraphElement>('p'));
  elements.forEach((element, index) => {
    element.getBoundingClientRect = () => ({
      x: index * 10, y: 0, left: index * 10, top: 0,
      right: index * 10 + 200, bottom: 40, width: 200, height: 40, toJSON: () => ({}),
    });
  });
  const styleOnlyReads = new Map<Element, number>();
  const styleOnlyProperties = new Set(['fontSize', 'fontWeight', 'fontFamily', 'color', 'backgroundColor', 'borderRadius']);
  const computed = dom.window.getComputedStyle.bind(dom.window);
  vi.spyOn(dom.window, 'getComputedStyle').mockImplementation((element, pseudo) => new Proxy(computed(element, pseudo), {
    get(style, property) {
      if (typeof property === 'string' && styleOnlyProperties.has(property)) {
        styleOnlyReads.set(element, (styleOnlyReads.get(element) ?? 0) + 1);
      }
      const value = Reflect.get(style, property, style) as unknown;
      return typeof value === 'function' ? value.bind(style) : value;
    },
  }));
  const packets: TargetPacket[] = [];
  vi.spyOn(dom.window.parent, 'postMessage').mockImplementation((message) => packets.push(message as TargetPacket));
  const send = (data: object) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    source: dom.window.parent, data,
  }));
  send({ type: 'readable-edit-mode', enabled: true, documentEpoch: 'style-document' });
  send({ type: 'readable-edit-selected-target', id: 'shape-0', revision: 1 });
  await vi.advanceTimersByTimeAsync(64);
  const latestTargets = () => packets.filter((packet) => packet.type === 'readable-edit-targets').at(-1)?.targets;
  return { dom, elements, packets, send, styleOnlyReads, latestTargets };
}

it.each([3, 100])('does not resolve unused appearance properties for %i unselected discovery shapes', async (count) => {
  const { elements, styleOnlyReads, latestTargets } = await discoveryFixture(count);
  const targets = latestTargets();
  expect(targets?.map((target) => target.id)).toEqual(elements.map((_, index) => `shape-${index}`));
  expect(targets?.[1]?.rect).toMatchObject({ x: 10, width: 200, height: 40 });
  expect(elements.slice(1).reduce((sum, element) => sum + (styleOnlyReads.get(element) ?? 0), 0)).toBe(0);
  expect(styleOnlyReads.get(elements[0]!)).toBeGreaterThan(0);
  expect(targets?.[0]?.styles).toMatchObject({ fontSize: '24px', fontWeight: '400', color: 'rgb(10, 20, 30)' });
});

it('keeps the selected discovery target complete after a genuine stylesheet-class change', async () => {
  const { dom, elements, latestTargets } = await discoveryFixture();
  expect(latestTargets()?.[0]?.styles.fontSize).toBe('24px');

  await dom.nextMutation(() => elements[0]!.classList.add('emphasis'));
  await vi.advanceTimersByTimeAsync(64);

  expect(latestTargets()?.[0]?.styles).toMatchObject({
    fontSize: '32px', fontWeight: '900', color: 'rgb(70, 80, 90)',
  });
});

it('hydrates an explicitly requested discovery shape through the existing full-selection path', async () => {
  const { dom, elements, packets, send, styleOnlyReads } = await discoveryFixture();
  const oldRange = dom.window.document.createRange();
  oldRange.selectNodeContents(elements[0]!);
  dom.window.getSelection()!.removeAllRanges();
  dom.window.getSelection()!.addRange(oldRange);
  styleOnlyReads.clear();
  packets.length = 0;

  send({ type: 'readable-edit-select-target', id: 'shape-1', actionSeq: 7, documentEpoch: 'style-document' });
  await vi.advanceTimersByTimeAsync(64);

  const selected = packets.find((packet) => packet.type === 'readable-edit-select')?.target;
  expect(selected?.id).toBe('shape-1');
  expect(selected?.styles).toMatchObject({ fontSize: '36px', fontWeight: '700', color: 'rgb(40, 50, 60)' });
  expect(selected?.outerHtml).toContain('Shape 1');
  expect(selected?.authoredSize).toBeDefined();
  expect(styleOnlyReads.get(elements[1]!)).toBeGreaterThan(0);
  expect(elements[0]!.getAttribute('data-readable-edit-selected')).toBe('true');
  expect(elements[1]!.hasAttribute('data-readable-edit-selected')).toBe(false);
});
