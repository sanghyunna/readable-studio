import { describe, expect, it, vi } from 'vitest';
import { buildManualEditBridge } from '../../src/edit-mode/bridge';
import { resizeCssCommitStyles } from '../../src/edit-mode/resize-geometry';
import { JSDOM } from './bridge-dom';

function fixture(position: 'absolute' | 'fixed' | 'static', options: { nested?: boolean; ambiguous?: boolean; rotated?: boolean; capped?: boolean; right?: boolean; centeredParent?: boolean; translate?: string; ownScale?: number; ancestorScale?: number; unreliableWidth?: boolean; unreliableHeight?: boolean } = {}) {
  const dom = new JSDOM(`<!doctype html><html style="width:1024px;height:768px"><body style="margin:0;width:1024px;height:768px">
    <main style="position:relative;display:${options.ambiguous ? 'inline' : options.centeredParent ? 'flex' : 'block'};justify-content:center;align-items:center;width:800px;height:600px;transform-origin:0 0;${options.rotated ? 'transform:matrix(0.7,0.7,-0.7,0.7,0,0)' : options.ancestorScale ? `transform:matrix(${options.ancestorScale},0,0,${options.ancestorScale},0,0)` : ''}">
      ${options.nested ? '<section style="width:250px;height:200px">' : ''}
      <div data-readable-id="shape" style="position:${position};${options.right ? 'right:200px;left:auto' : 'left:200px'};top:200px;width:200px;height:100px;background:#88b4d7;${options.capped ? 'max-width:200px;' : ''}${options.translate ? `translate:${options.translate};` : ''}${options.ownScale ? `transform:matrix(${options.ownScale},0,0,${options.ownScale},0,0);` : ''}"></div>
      ${options.nested ? '</section>' : ''}
    </main>${buildManualEditBridge(true)}</body></html>`, { runScripts: 'dangerously', url: 'http://localhost' });
  const target = dom.window.document.querySelector<HTMLElement>('[data-readable-id="shape"]')!;
  const parent = dom.window.document.querySelector<HTMLElement>('main')!;
  for (const element of dom.window.document.querySelectorAll<HTMLElement>('html,body,main,section,[data-readable-id="shape"]')) {
    const cssSize = (axis: 'width' | 'height') => {
      const computed = dom.window.getComputedStyle(element);
      const size = Number.parseFloat(computed[axis]) || 0;
      const cap = Number.parseFloat(computed.getPropertyValue(`max-${axis}`));
      return Number.isFinite(cap) ? Math.min(size, cap) : size;
    };
    Object.defineProperties(element, {
      offsetWidth: { get: () => element === target && options.unreliableWidth ? 0 : cssSize('width') },
      offsetHeight: { get: () => element === target && options.unreliableHeight ? 0 : cssSize('height') },
      clientWidth: { get: () => cssSize('width') },
      clientHeight: { get: () => cssSize('height') },
    });
    element.getBoundingClientRect = () => {
      const marginLeft = Number.parseFloat(target.style.marginLeft) || 0;
      const marginTop = Number.parseFloat(target.style.marginTop) || 0;
      const translate = target.style.translate.split(/\s+/).map(Number.parseFloat);
      const width = cssSize('width'), height = cssSize('height');
      const x = element !== target ? 0 : (options.centeredParent ? (800 - width + marginLeft) / 2
        : options.right ? 800 - 200 - width : 200 + marginLeft) + (translate[0] || 0);
      const y = element !== target ? 0 : (options.centeredParent ? (600 - height + marginTop) / 2 : 200 + marginTop) + (translate[1] || 0);
      const ownScale = element === target ? options.ownScale ?? 1 : 1;
      const ancestorScale = element.tagName === 'HTML' || element.tagName === 'BODY' ? 1 : options.ancestorScale ?? 1;
      return new dom.window.DOMRect((x - (ownScale - 1) * width / 2) * ancestorScale,
        (y - (ownScale - 1) * height / 2) * ancestorScale, width * ownScale * ancestorScale, height * ownScale * ancestorScale);
    };
    element.getClientRects = () => [element.getBoundingClientRect()] as unknown as DOMRectList;
  }
  Object.defineProperty(target, 'offsetParent', { get: () => position === 'absolute' ? parent : null });
  const post = vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(() => {});
  const send = (data: object) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  send({ type: 'readable-edit-mode', enabled: true, documentEpoch: 'positioned-resize' });
  function resize(centered = false, direction: 'e' | 's' | 'se' = 'se') {
    const scale = (options.ownScale ?? 1) * (options.ancestorScale ?? 1);
    send({ type: 'readable-edit-preview-style', id: 'shape', version: 1,
      styles: resizeCssCommitStyles({ direction, size: { width: 240 * scale, height: 120 * scale }, startSize: { width: 200 * scale, height: 100 * scale },
        baseStyles: { width: '200px', height: '100px' }, baseMargins: { marginLeft: '0px', marginTop: '0px' }, rectScale: { x: scale, y: scale }, fromCenter: centered }),
      resize: { targetId: 'shape', documentEpoch: 'positioned-resize', transactionId: 'positioned-1', sourceRevision: 1,
        sequence: 1, stage: 'finalize', axes: direction === 'e' ? ['width'] : direction === 's' ? ['height'] : ['width', 'height'], requested: { width: 240 * scale, height: 120 * scale, ...(centered ? { fromCenter: true } : {}) }, includeDetails: true },
    });
    return JSON.parse(JSON.stringify(post.mock.calls.at(-1)?.[0]));
  }
  return { dom, target, resize };
}

describe('positioned shape resize', () => {
  it.each([false, true])('accepts an ordinary measurable absolute shape (centered=%s)', (centered) => {
    const { target, resize } = fixture('absolute');
    const reply = resize(centered);
    expect(reply.resize).toMatchObject({ decision: 'ordinary', confidence: 'confirmed', constraints: [], safetyFailures: [] });
    expect(target.style.width).toBe('240px');
    expect(target.style.height).toBe('120px');
    if (centered) {
      const rect = target.getBoundingClientRect();
      expect(rect.x + rect.width / 2).toBe(300);
      expect(rect.y + rect.height / 2).toBe(250);
    }
  });

  it('uses the positioned containing block instead of a narrower static DOM parent', () => {
    const { target, resize } = fixture('absolute', { nested: true });
    expect(resize().resize).toMatchObject({ decision: 'ordinary', constraints: [], safetyFailures: [], availableContentWidth: 800 });
    expect(target.style.width).toBe('240px');
  });

  it('uses the viewport for a measurable fixed shape inside a static wrapper', () => {
    const { target, resize } = fixture('fixed', { nested: true });
    expect(resize(true).resize).toMatchObject({ decision: 'ordinary', constraints: [], safetyFailures: [], availableContentWidth: 1024 });
    expect(target.style.width).toBe('240px');
  });

  it('keeps a fractional center when resizing odd authored dimensions', () => {
    const { target, resize } = fixture('absolute');
    target.style.width = '201px';
    target.style.height = '101px';
    const before = target.getBoundingClientRect();
    const reply = resize(true);
    const after = target.getBoundingClientRect();
    expect(reply.resize.decision).toBe('ordinary');
    expect(reply.centerStyles.translate).toBe('-19.5px -9.5px');
    expect(after.x + after.width / 2).toBe(before.x + before.width / 2);
    expect(after.y + after.height / 2).toBe(before.y + before.height / 2);
  });

  it.each([
    { ambiguous: true },
    { rotated: true },
  ])('still refuses a positioned shape with unsupported or ambiguous geometry: %j', (options) => {
    const { target, resize } = fixture('absolute', options);
    const reply = resize(true);
    expect(reply.resize.decision).toBe('refused');
    expect(reply.resize.safetyFailures).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unsupported-geometry' })]));
    expect(target.style.width).toBe('200px');
    expect(target.style.marginLeft).toBe('');
  });

  it('retains the automatic width-release refusal for a capped positioned shape', () => {
    const { target, resize } = fixture('absolute', { capped: true });
    const reply = resize(true);
    expect(reply.resize.decision).toBe('refused');
    expect(reply.resize.proposedDeclarations).toEqual([]);
    expect(reply.resize.causes).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unsupported-geometry', facts: { reason: 'containing-block' } }),
    ]));
    expect(target.style.width).toBe('200px');
    expect(target.hasAttribute('data-readable-width-release')).toBe(false);
  });

  it.each([
    { position: 'absolute', right: true },
    { position: 'static', centeredParent: true },
    { position: 'absolute', right: true, translate: '10px 8px' },
    { position: 'absolute', ownScale: 2, ancestorScale: 0.8 },
  ] as const)('keeps the measured center for layout-driven positioning: %j', ({ position, ...options }) => {
    const { target, resize } = fixture(position, options);
    const before = target.getBoundingClientRect();
    const reply = resize(true);
    const after = target.getBoundingClientRect();
    expect(reply.resize.decision).toBe('ordinary');
    expect(after.width).toBeCloseTo(before.width * 1.2, 3);
    expect(after.height).toBeCloseTo(before.height * 1.2, 3);
    expect(after.x + after.width / 2).toBeCloseTo(before.x + before.width / 2, 3);
    expect(after.y + after.height / 2).toBeCloseTo(before.y + before.height / 2, 3);
    if (reply.centerStyles) expect(target.style.translate).toBe(reply.centerStyles.translate);
  });

  it.each([
    { direction: 's', unreliableWidth: true },
    { direction: 'e', unreliableHeight: true },
  ] as const)('does not accept an unmeasurable centered anchor on a single-axis resize: %j', ({ direction, ...options }) => {
    const { target, resize } = fixture('static', options);
    const reply = resize(true, direction);
    expect(reply.ok).toBe(false);
    expect(target.style.width).toBe('200px');
    expect(target.style.height).toBe('100px');
    expect(target.style.translate).toBe('');
  });
});
