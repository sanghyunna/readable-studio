import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  buildManualEditBridge,
  isMeaningfulManualEditElement,
  isManualEditHostNode,
  isSourceMappableManualEditElement,
  manualEditDomPathForElement,
  manualEditStableIdForElement,
} from '../../src/edit-mode/bridge';

describe('manual edit bridge target normalization', () => {
  it('prefers explicit data-readable-id over generated ids', () => {
    const dom = new JSDOM('<main><h1 data-readable-id="hero">Title</h1></main>');
    const target = dom.window.document.querySelector('h1')!;

    expect(manualEditStableIdForElement(target)).toBe('hero');
    expect(target.getAttribute('data-readable-runtime-id')).toBeNull();
  });

  it('generates stable DOM path ids for unannotated elements', () => {
    const dom = new JSDOM('<main><section><p>First</p><p>Second</p></section></main>');
    const target = dom.window.document.querySelectorAll('p')[1]!;

    expect(manualEditDomPathForElement(target)).toBe('path-0-0-1');
    expect(manualEditStableIdForElement(target)).toBe('path-0-0-1');
    expect(manualEditStableIdForElement(target)).toBe('path-0-0-1');
    expect(target.getAttribute('data-readable-runtime-id')).toBe('path-0-0-1');
  });

  it('generates DOM path ids against source-shaped children, ignoring host shim nodes', () => {
    const dom = new JSDOM(
      '<script data-readable-sandbox-shim></script><main><section><p>First</p><p>Second</p></section></main><script data-readable-edit-bridge></script>',
    );
    const target = dom.window.document.querySelectorAll('p')[1]!;

    expect(isManualEditHostNode(dom.window.document.querySelector('[data-readable-sandbox-shim]')!)).toBe(true);
    expect(manualEditDomPathForElement(target)).toBe('path-0-0-1');
  });

  it('discovers meaningful elements and ignores tiny or irrelevant elements', () => {
    const dom = new JSDOM('<main><h1 data-readable-source-path="path-0-0">Title</h1><script>1</script></main>');
    const title = dom.window.document.querySelector('h1')!;
    const script = dom.window.document.querySelector('script')!;

    expect(isMeaningfulManualEditElement(title, { width: 80, height: 24 })).toBe(true);
    expect(isMeaningfulManualEditElement(title, { width: 3, height: 24 })).toBe(false);
    expect(isMeaningfulManualEditElement(script, { width: 80, height: 24 })).toBe(false);
  });

  it('does not discover inline formatting leaves inside a text passage as separate targets', () => {
    const dom = new JSDOM('<main><p data-readable-source-path="path-0-0">Hello <strong data-readable-source-path="path-0-0-0">world</strong></p></main>');
    const paragraph = dom.window.document.querySelector('p')!;
    const strong = dom.window.document.querySelector('strong')!;

    expect(isMeaningfulManualEditElement(paragraph, { width: 120, height: 24 })).toBe(true);
    expect(isMeaningfulManualEditElement(strong, { width: 60, height: 24 })).toBe(false);
  });

  it('keeps source-mappable display:none targets available for the layers panel', async () => {
    const posts: Array<{ type?: string; targets?: Array<{ id: string; isHidden?: boolean }> }> = [];
    const dom = new JSDOM(
      `<main>
        <h1 data-readable-source-path="path-0-0">Visible title</h1>
        <section data-readable-source-path="path-0-1" style="display:none">
          <p data-readable-source-path="path-0-1-0">Hidden author notes</p>
        </section>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const visible = dom.window.document.querySelector('h1')!;
    const hiddenSection = dom.window.document.querySelector('section')!;
    const hiddenParagraph = dom.window.document.querySelector('p')!;
    visible.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 160, height: 32,
      top: 0, right: 160, bottom: 32, left: 0,
      toJSON: () => ({}),
    } as DOMRect);
    hiddenSection.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 0, height: 0,
      top: 0, right: 0, bottom: 0, left: 0,
      toJSON: () => ({}),
    } as DOMRect);
    hiddenParagraph.getBoundingClientRect = hiddenSection.getBoundingClientRect;
    dom.window.parent.postMessage = ((message: unknown) => {
      posts.push(message as { type?: string; targets?: Array<{ id: string; isHidden?: boolean }> });
    }) as typeof dom.window.parent.postMessage;

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true },
    }));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

    const targetsMessage = posts.find((message) => message.type === 'readable-edit-targets');
    expect(targetsMessage?.targets?.map((target) => target.id)).toEqual([
      'path-0-0',
      'path-0-1',
      'path-0-1-0',
    ]);
    expect(targetsMessage?.targets?.find((target) => target.id === 'path-0-1')?.isHidden).toBe(true);
    expect(targetsMessage?.targets?.find((target) => target.id === 'path-0-1-0')?.isHidden).toBe(true);

    dom.window.close();
  });

  it('treats hidden containers as layout editable targets', async () => {
    const posts: Array<{ type?: string; targets?: Array<{ id: string; isHidden?: boolean; isLayoutContainer?: boolean }> }> = [];
    const dom = new JSDOM(
      `<main>
        <section data-readable-source-path="path-0-0" style="display:none">
          <p data-readable-source-path="path-0-0-0">Hidden layout copy</p>
        </section>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const section = dom.window.document.querySelector('section')!;
    const paragraph = dom.window.document.querySelector('p')!;
    section.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 0, height: 0,
      top: 0, right: 0, bottom: 0, left: 0,
      toJSON: () => ({}),
    } as DOMRect);
    paragraph.getBoundingClientRect = section.getBoundingClientRect;
    dom.window.parent.postMessage = ((message: unknown) => {
      posts.push(message as { type?: string; targets?: Array<{ id: string; isHidden?: boolean; isLayoutContainer?: boolean }> });
    }) as typeof dom.window.parent.postMessage;

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true },
    }));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

    const targetsMessage = posts.find((message) => message.type === 'readable-edit-targets');
    const hiddenSection = targetsMessage?.targets?.find((target) => target.id === 'path-0-0');
    const hiddenParagraph = targetsMessage?.targets?.find((target) => target.id === 'path-0-0-0');
    expect(hiddenSection?.isHidden).toBe(true);
    expect(hiddenSection?.isLayoutContainer).toBe(true);
    expect(hiddenParagraph?.isLayoutContainer).toBe(false);

    dom.window.close();
  });

  it('does not treat visibility-hidden block containers as layout editable targets', async () => {
    const posts: Array<{ type?: string; targets?: Array<{ id: string; isHidden?: boolean; isLayoutContainer?: boolean }> }> = [];
    const dom = new JSDOM(
      `<main>
        <section data-readable-source-path="path-0-0" style="visibility:hidden">
          <p data-readable-source-path="path-0-0-0">Hidden block copy</p>
        </section>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const section = dom.window.document.querySelector('section')!;
    const paragraph = dom.window.document.querySelector('p')!;
    section.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 160, height: 32,
      top: 0, right: 160, bottom: 32, left: 0,
      toJSON: () => ({}),
    } as DOMRect);
    paragraph.getBoundingClientRect = () => ({
      x: 8, y: 8, width: 140, height: 20,
      top: 8, right: 148, bottom: 28, left: 8,
      toJSON: () => ({}),
    } as DOMRect);
    dom.window.parent.postMessage = ((message: unknown) => {
      posts.push(message as { type?: string; targets?: Array<{ id: string; isHidden?: boolean; isLayoutContainer?: boolean }> });
    }) as typeof dom.window.parent.postMessage;

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true },
    }));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

    const targetsMessage = posts.find((message) => message.type === 'readable-edit-targets');
    const hiddenSection = targetsMessage?.targets?.find((target) => target.id === 'path-0-0');
    expect(hiddenSection?.isHidden).toBe(true);
    expect(hiddenSection?.isLayoutContainer).toBe(false);

    dom.window.close();
  });

  it('does not treat block containers hidden only by an ancestor as layout editable targets', async () => {
    const posts: Array<{ type?: string; targets?: Array<{ id: string; isHidden?: boolean; isLayoutContainer?: boolean }> }> = [];
    const dom = new JSDOM(
      `<main>
        <div data-readable-source-path="path-0-0" style="display:none">
          <section data-readable-source-path="path-0-0-0">Nested hidden section</section>
        </div>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const wrapper = dom.window.document.querySelector('div')!;
    const section = dom.window.document.querySelector('section')!;
    wrapper.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 0, height: 0,
      top: 0, right: 0, bottom: 0, left: 0,
      toJSON: () => ({}),
    } as DOMRect);
    section.getBoundingClientRect = wrapper.getBoundingClientRect;
    dom.window.parent.postMessage = ((message: unknown) => {
      posts.push(message as { type?: string; targets?: Array<{ id: string; isHidden?: boolean; isLayoutContainer?: boolean }> });
    }) as typeof dom.window.parent.postMessage;

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true },
    }));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

    const targetsMessage = posts.find((message) => message.type === 'readable-edit-targets');
    const hiddenSection = targetsMessage?.targets?.find((target) => target.id === 'path-0-0-0');
    expect(hiddenSection?.isHidden).toBe(true);
    expect(hiddenSection?.isLayoutContainer).toBe(false);

    dom.window.close();
  });

  it('does not mark visibility:visible descendants as hidden', async () => {
    const posts: Array<{ type?: string; targets?: Array<{ id: string; isHidden?: boolean }> }> = [];
    const dom = new JSDOM(
      `<main>
        <section data-readable-source-path="path-0-0" style="visibility:hidden">
          <p data-readable-source-path="path-0-0-0" style="visibility:visible">Visible child copy</p>
        </section>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const section = dom.window.document.querySelector('section')!;
    const visibleChild = dom.window.document.querySelector('p')!;
    section.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 160, height: 32,
      top: 0, right: 160, bottom: 32, left: 0,
      toJSON: () => ({}),
    } as DOMRect);
    visibleChild.getBoundingClientRect = () => ({
      x: 8, y: 8, width: 140, height: 20,
      top: 8, right: 148, bottom: 28, left: 8,
      toJSON: () => ({}),
    } as DOMRect);
    dom.window.parent.postMessage = ((message: unknown) => {
      posts.push(message as { type?: string; targets?: Array<{ id: string; isHidden?: boolean }> });
    }) as typeof dom.window.parent.postMessage;

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true },
    }));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

    const targetsMessage = posts.find((message) => message.type === 'readable-edit-targets');
    expect(targetsMessage?.targets?.find((target) => target.id === 'path-0-0')?.isHidden).toBe(true);
    expect(targetsMessage?.targets?.find((target) => target.id === 'path-0-0-0')?.isHidden).toBe(false);

    dom.window.close();
  });

  it('does not expose path targets unless they carry a source path marker', () => {
    const dom = new JSDOM('<main><h1>Runtime title</h1><p data-readable-source-path="path-0-1">Source text</p></main>');
    const runtimeTitle = dom.window.document.querySelector('h1')!;
    const sourceText = dom.window.document.querySelector('p')!;

    expect(isSourceMappableManualEditElement(runtimeTitle)).toBe(false);
    expect(isSourceMappableManualEditElement(sourceText)).toBe(true);
    expect(isMeaningfulManualEditElement(runtimeTitle, { width: 80, height: 24 })).toBe(false);
  });

  it('omits selected outerHTML from bulk target posts but includes it for selected targets', () => {
    const bridge = buildManualEditBridge(true);

    expect(bridge).toContain('targets.push(targetFrom(nodes[i], false, false))');
    expect(bridge).toContain("target: el ? targetFrom(el, true, false) : null");
    expect(bridge).toContain("type: 'readable-edit-select', target: targetFrom(el, true, true)");
    expect(bridge).toContain('if (!isSourceMappable(nodes[i])) continue;');
    expect(bridge).toContain('return el;');
    expect(bridge).not.toContain('if (isPrimaryTarget(el)) return el;');
  });

  it('prefers the deepest source-mapped child over an annotated group on hover', async () => {
    const posts: Array<{ type?: string; target?: { id: string; label?: string; authoredSize?: unknown } }> = [];
    const dom = new JSDOM(
      `<main>
        <section data-readable-id="hero-group">
          <span data-readable-source-path="path-0-0-0">Small label</span>
        </section>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const span = dom.window.document.querySelector('span')!;
    const createElement = vi.spyOn(dom.window.document, 'createElement');
    dom.window.parent.postMessage = ((message: unknown) => {
      posts.push(message as { type?: string; target?: { id: string; label?: string; authoredSize?: unknown } });
    }) as typeof dom.window.parent.postMessage;

    span.dispatchEvent(new dom.window.Event('pointerover', { bubbles: true }));

    const hover = posts.find((message) => message.type === 'readable-edit-hover');
    expect(hover?.target?.id).toBe('path-0-0-0');
    expect(hover?.target?.label).toBe('Small label');
    expect(hover?.target).not.toHaveProperty('authoredSize');
    expect(createElement.mock.calls.filter(([tag]) => tag === 'style')).toHaveLength(0);

    dom.window.close();
  });

  it('clears a prior hover when overlay coordinates land on the selected target', () => {
    const posts: Array<{ type?: string; target?: { id: string } | null }> = [];
    const dom = new JSDOM(
      `<main>
        <button data-readable-id="top">Top</button>
        <button data-readable-id="middle">Selected middle</button>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const top = dom.window.document.querySelector('[data-readable-id="top"]')!;
    const middle = dom.window.document.querySelector('[data-readable-id="middle"]')!;
    let pointTargets: Element[] = [top];
    Object.defineProperty(dom.window.document, 'elementsFromPoint', {
      configurable: true,
      value: () => pointTargets,
    });
    dom.window.parent.postMessage = ((message: unknown) => {
      posts.push(message as { type?: string; target?: { id: string } | null });
    }) as typeof dom.window.parent.postMessage;

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true, documentEpoch: 'epoch-1' },
    }));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-selected-target', id: 'middle' },
    }));
    top.dispatchEvent(new dom.window.MouseEvent('pointerover', {
      bubbles: true,
      clientX: 10,
      clientY: 10,
    }));
    expect(top.getAttribute('data-readable-runtime-hovered')).toBe('true');

    posts.length = 0;
    pointTargets = [middle];
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'readable-edit-hover-at',
        clientX: 80,
        clientY: 10,
        selectedId: 'middle',
        documentEpoch: 'epoch-1',
      },
    }));

    expect(dom.window.document.querySelectorAll('[data-readable-runtime-hovered]')).toHaveLength(0);
    expect(posts).toContainEqual(expect.objectContaining({ type: 'readable-edit-hover', target: null }));
    dom.window.close();
  });

  it('clears hover immediately when a click selects its current target', () => {
    const posts: Array<{ type?: string; target?: { id: string } | null }> = [];
    const dom = new JSDOM(
      `<main><img data-readable-id="middle" alt="Middle"></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const middle = dom.window.document.querySelector('[data-readable-id="middle"]')!;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', {
      configurable: true,
      value: () => [middle],
    });
    dom.window.parent.postMessage = ((message: unknown) => {
      posts.push(message as { type?: string; target?: { id: string } | null });
    }) as typeof dom.window.parent.postMessage;

    middle.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }));
    expect(middle.getAttribute('data-readable-runtime-hovered')).toBe('true');

    middle.dispatchEvent(new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    }));

    expect(middle.hasAttribute('data-readable-runtime-hovered')).toBe(false);
    expect(posts).toContainEqual(expect.objectContaining({ type: 'readable-edit-hover', target: null }));
    dom.window.close();
  });

  it('keeps the top pointer target hovered when z-stack cycling selects behind it', () => {
    const dom = new JSDOM(
      `<main><img data-readable-id="front" alt="Front"><img data-readable-id="back" alt="Back"></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const front = dom.window.document.querySelector('[data-readable-id="front"]')!;
    const back = dom.window.document.querySelector('[data-readable-id="back"]')!;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', {
      configurable: true,
      value: () => [front, back],
    });

    for (let click = 0; click < 2; click += 1) {
      front.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
      }));
    }

    expect(front.getAttribute('data-readable-runtime-hovered')).toBe('true');
    expect(back.hasAttribute('data-readable-runtime-hovered')).toBe(false);
    dom.window.close();
  });

  it('clears hover immediately when the host selects the hovered target', () => {
    const posts: Array<{ type?: string; target?: { id: string } | null }> = [];
    const dom = new JSDOM(
      `<main><img data-readable-id="middle" alt="Middle"></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const middle = dom.window.document.querySelector('[data-readable-id="middle"]')!;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', {
      configurable: true,
      value: () => [middle],
    });
    dom.window.parent.postMessage = ((message: unknown) => {
      posts.push(message as { type?: string; target?: { id: string } | null });
    }) as typeof dom.window.parent.postMessage;

    middle.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }));
    expect(middle.getAttribute('data-readable-runtime-hovered')).toBe('true');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-select-target', id: 'middle' },
    }));

    expect(middle.hasAttribute('data-readable-runtime-hovered')).toBe(false);
    expect(posts).toContainEqual(expect.objectContaining({ type: 'readable-edit-hover', target: null }));
    dom.window.close();
  });

  it('keeps a separate child hovered inside the selected parent', () => {
    const posts: Array<{ type?: string; target?: { id: string } | null }> = [];
    const dom = new JSDOM(
      `<main><section data-readable-id="parent"><button data-readable-id="child">Child</button></section></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const parent = dom.window.document.querySelector('[data-readable-id="parent"]')!;
    const child = dom.window.document.querySelector('[data-readable-id="child"]')!;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', {
      configurable: true,
      value: () => [child, parent],
    });
    dom.window.parent.postMessage = ((message: unknown) => {
      posts.push(message as { type?: string; target?: { id: string } | null });
    }) as typeof dom.window.parent.postMessage;

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true, documentEpoch: 'epoch-1' },
    }));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-selected-target', id: 'parent' },
    }));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'readable-edit-hover-at',
        clientX: 20,
        clientY: 20,
        selectedId: 'parent',
        documentEpoch: 'epoch-1',
      },
    }));

    expect(parent.hasAttribute('data-readable-runtime-hovered')).toBe(false);
    expect(child.getAttribute('data-readable-runtime-hovered')).toBe('true');
    expect(posts).toContainEqual(expect.objectContaining({
      type: 'readable-edit-hover',
      target: expect.objectContaining({ id: 'child' }),
    }));
    dom.window.close();
  });

  it('replaces the previous hover marker on native pointer move', () => {
    const posts: Array<{ type?: string; target?: { id: string } | null }> = [];
    const dom = new JSDOM(
      `<main><button data-readable-id="top">Top</button><button data-readable-id="bottom">Bottom</button></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const top = dom.window.document.querySelector('[data-readable-id="top"]')!;
    const bottom = dom.window.document.querySelector('[data-readable-id="bottom"]')!;
    let pointTargets: Element[] = [top];
    Object.defineProperty(dom.window.document, 'elementsFromPoint', {
      configurable: true,
      value: () => pointTargets,
    });
    dom.window.parent.postMessage = ((message: unknown) => {
      posts.push(message as { type?: string; target?: { id: string } | null });
    }) as typeof dom.window.parent.postMessage;

    top.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }));
    pointTargets = [bottom];
    bottom.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 60 }));

    expect(top.hasAttribute('data-readable-runtime-hovered')).toBe(false);
    expect(bottom.getAttribute('data-readable-runtime-hovered')).toBe('true');
    expect(posts.filter((message) => message.type === 'readable-edit-hover').map((message) => message.target?.id)).toEqual([
      'top',
      'bottom',
    ]);
    dom.window.close();
  });

  it('ignores stale overlay hover coordinates', () => {
    const posts: Array<{ type?: string; target?: { id: string } | null }> = [];
    const dom = new JSDOM(
      `<main><button data-readable-id="top">Top</button><button data-readable-id="bottom">Bottom</button></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const top = dom.window.document.querySelector('[data-readable-id="top"]')!;
    const bottom = dom.window.document.querySelector('[data-readable-id="bottom"]')!;
    let pointTargets: Element[] = [top];
    Object.defineProperty(dom.window.document, 'elementsFromPoint', {
      configurable: true,
      value: () => pointTargets,
    });
    dom.window.parent.postMessage = ((message: unknown) => {
      posts.push(message as { type?: string; target?: { id: string } | null });
    }) as typeof dom.window.parent.postMessage;

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true, documentEpoch: 'epoch-current' },
    }));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-selected-target', id: 'top' },
    }));
    // Establish a non-selected hover before testing stale overlay messages.
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-selected-target', id: 'other' },
    }));
    top.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }));
    const hoverCount = posts.filter((message) => message.type === 'readable-edit-hover').length;
    pointTargets = [bottom];

    for (const data of [
      {
        type: 'readable-edit-hover-at', clientX: 10, clientY: 60,
        selectedId: 'other', documentEpoch: 'epoch-stale',
      },
      {
        type: 'readable-edit-hover-at', clientX: 10, clientY: 60,
        selectedId: 'top', documentEpoch: 'epoch-current',
      },
    ]) {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
    }

    expect(top.getAttribute('data-readable-runtime-hovered')).toBe('true');
    expect(bottom.hasAttribute('data-readable-runtime-hovered')).toBe(false);
    expect(posts.filter((message) => message.type === 'readable-edit-hover')).toHaveLength(hoverCount);
    dom.window.close();
  });

  it('omits inline formatting leaves from bulk target posts when a text passage owns them', async () => {
    const posts: Array<{ type?: string; targets?: Array<{ id: string }> }> = [];
    const dom = new JSDOM(
      `<main><p data-readable-source-path="path-0-0">Hello <strong data-readable-source-path="path-0-0-0">world</strong></p></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const paragraph = dom.window.document.querySelector('p')!;
    const strong = dom.window.document.querySelector('strong')!;
    paragraph.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 120, height: 24,
      top: 0, right: 120, bottom: 24, left: 0,
      toJSON: () => ({}),
    } as DOMRect);
    strong.getBoundingClientRect = () => ({
      x: 40, y: 0, width: 60, height: 24,
      top: 0, right: 100, bottom: 24, left: 40,
      toJSON: () => ({}),
    } as DOMRect);
    dom.window.parent.postMessage = ((message: unknown) => {
      posts.push(message as { type?: string; targets?: Array<{ id: string }> });
    }) as typeof dom.window.parent.postMessage;

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true },
    }));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

    const targetsMessage = posts.find((message) => message.type === 'readable-edit-targets');
    expect(targetsMessage?.targets?.map((target) => target.id)).toEqual(['path-0-0']);

    dom.window.close();
  });

  it('acks live preview style patches by id and version', () => {
    const bridge = buildManualEditBridge(true);

    expect(bridge).toContain("type: 'readable-edit-preview-style-applied'");
    expect(bridge).toContain('version: Number(version) || 0,');
    expect(bridge).toContain('ok: true,');
    expect(bridge).toContain("ok: false, error: 'Target not found'");
  });

  it('moves the runtime selected marker between selected targets', () => {
    const dom = new JSDOM(
      `<main>
        <h1 data-readable-id="title">Title</h1>
        <p data-readable-id="body">Body</p>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const title = dom.window.document.querySelector('[data-readable-id="title"]')!;
    const body = dom.window.document.querySelector('[data-readable-id="body"]')!;

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-selected-target', id: 'title' },
    }));
    expect(title.getAttribute('data-readable-edit-selected')).toBe('true');
    expect(body.hasAttribute('data-readable-edit-selected')).toBe(false);

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-selected-target', id: 'body' },
    }));
    expect(title.hasAttribute('data-readable-edit-selected')).toBe(false);
    expect(body.getAttribute('data-readable-edit-selected')).toBe('true');

    dom.window.close();
  });

  it('clears runtime selected markers for null selection and edit-mode exit', () => {
    const dom = new JSDOM(
      `<main>
        <h1 data-readable-id="title">Title</h1>
        <p data-readable-id="body" data-readable-edit-selected="true">Body</p>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const body = dom.window.document.querySelector('[data-readable-id="body"]')!;

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-selected-target', id: null },
    }));
    expect(body.hasAttribute('data-readable-edit-selected')).toBe(false);

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-selected-target', id: 'body' },
    }));
    expect(body.getAttribute('data-readable-edit-selected')).toBe('true');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: false },
    }));
    expect(body.hasAttribute('data-readable-edit-selected')).toBe(false);

    dom.window.close();
  });

  it('cycles plain clicks at the same point through the z-stack top-to-bottom', () => {
    const dom = new JSDOM(
      `<main>
        <div data-readable-id="bottom" data-readable-edit="container"><span>Bottom</span></div>
        <div data-readable-id="top" data-readable-edit="container"><span>Top</span></div>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const top = dom.window.document.querySelector('[data-readable-id="top"]') as HTMLElement;
    const bottom = dom.window.document.querySelector('[data-readable-id="bottom"]') as HTMLElement;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', {
      configurable: true,
      value: () => [top, bottom],
    });
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    top.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'readable-edit-select', target: expect.objectContaining({ id: 'top' }) }),
      '*',
    );

    postMessage.mockClear();
    top.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'readable-edit-select', target: expect.objectContaining({ id: 'bottom' }) }),
      '*',
    );

    // A third click at the same spot wraps back to the topmost target.
    postMessage.mockClear();
    top.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'readable-edit-select', target: expect.objectContaining({ id: 'top' }) }),
      '*',
    );

    dom.window.close();
  });

  it('cycles a 3-deep Alt+click stack and wraps to the top target', () => {
    const dom = new JSDOM(
      `<main>
        <div data-readable-id="back" data-readable-edit="container"><span>Back</span></div>
        <div data-readable-id="middle" data-readable-edit="container"><span>Middle</span></div>
        <div data-readable-id="front" data-readable-edit="container"><span>Front</span></div>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const front = dom.window.document.querySelector('[data-readable-id="front"]') as HTMLElement;
    const middle = dom.window.document.querySelector('[data-readable-id="middle"]') as HTMLElement;
    const back = dom.window.document.querySelector('[data-readable-id="back"]') as HTMLElement;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', {
      configurable: true,
      value: () => [front, middle, back],
    });
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    for (let i = 0; i < 4; i++) {
      front.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, altKey: true, clientX: 10, clientY: 10 }));
    }

    const selectedIds = postMessage.mock.calls
      .map(([message]) => message as { type?: string; target?: { id?: string } })
      .filter((message) => message.type === 'readable-edit-select')
      .map((message) => message.target?.id);
    expect(selectedIds).toEqual(['middle', 'back', 'front', 'middle']);

    dom.window.close();
  });

  it('keeps cycling through duplicate enabled-mode feedback and a forwarded Alt+click', () => {
    const dom = new JSDOM(
      `<main>
        <div data-readable-id="back" data-readable-edit="container"><span>Back</span></div>
        <div data-readable-id="middle" data-readable-edit="container"><span>Middle</span></div>
        <div data-readable-id="front" data-readable-edit="container"><span>Front</span></div>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const front = dom.window.document.querySelector('[data-readable-id="front"]') as HTMLElement;
    const middle = dom.window.document.querySelector('[data-readable-id="middle"]') as HTMLElement;
    const back = dom.window.document.querySelector('[data-readable-id="back"]') as HTMLElement;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', {
      configurable: true,
      value: () => [front, middle, back],
    });
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    front.dispatchEvent(new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      altKey: true,
      clientX: 10,
      clientY: 10,
    }));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true },
    }));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-alt-click', clientX: 10, clientY: 10 },
    }));

    const selectedIds = postMessage.mock.calls
      .map(([message]) => message as { type?: string; target?: { id?: string } })
      .filter((message) => message.type === 'readable-edit-select')
      .map((message) => message.target?.id);
    expect(selectedIds).toEqual(['middle', 'back']);

    dom.window.close();
  });

  it('resets cycling when the click point moves beyond tolerance', () => {
    const dom = new JSDOM(
      `<main>
        <div data-readable-id="back" data-readable-edit="container"><span>Back</span></div>
        <div data-readable-id="middle" data-readable-edit="container"><span>Middle</span></div>
        <div data-readable-id="front" data-readable-edit="container"><span>Front</span></div>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const front = dom.window.document.querySelector('[data-readable-id="front"]') as HTMLElement;
    const middle = dom.window.document.querySelector('[data-readable-id="middle"]') as HTMLElement;
    const back = dom.window.document.querySelector('[data-readable-id="back"]') as HTMLElement;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', {
      configurable: true,
      value: () => [front, middle, back],
    });
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    front.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, altKey: true, clientX: 10, clientY: 10 }));
    front.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, altKey: true, clientX: 20, clientY: 10 }));

    const selectedIds = postMessage.mock.calls
      .map(([message]) => message as { type?: string; target?: { id?: string } })
      .filter((message) => message.type === 'readable-edit-select')
      .map((message) => message.target?.id);
    expect(selectedIds).toEqual(['middle', 'middle']);

    dom.window.close();
  });

  it('resets cycling when the stack composition changes', () => {
    const dom = new JSDOM(
      `<main>
        <div data-readable-id="back" data-readable-edit="container"><span>Back</span></div>
        <div data-readable-id="middle" data-readable-edit="container"><span>Middle</span></div>
        <div data-readable-id="front" data-readable-edit="container"><span>Front</span></div>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const front = dom.window.document.querySelector('[data-readable-id="front"]') as HTMLElement;
    const middle = dom.window.document.querySelector('[data-readable-id="middle"]') as HTMLElement;
    const back = dom.window.document.querySelector('[data-readable-id="back"]') as HTMLElement;
    let stack = [front, middle, back];
    Object.defineProperty(dom.window.document, 'elementsFromPoint', {
      configurable: true,
      value: () => stack,
    });
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    front.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, altKey: true, clientX: 10, clientY: 10 }));
    stack = [front, back];
    front.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, altKey: true, clientX: 10, clientY: 10 }));

    const selectedIds = postMessage.mock.calls
      .map(([message]) => message as { type?: string; target?: { id?: string } })
      .filter((message) => message.type === 'readable-edit-select')
      .map((message) => message.target?.id);
    expect(selectedIds).toEqual(['middle', 'back']);

    dom.window.close();
  });

  it('selects text and link targets on Alt+click without entering inline edit', () => {
    const dom = new JSDOM(
      `<main><a data-readable-id="cta" href="/start">Start</a></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const link = dom.window.document.querySelector('[data-readable-id="cta"]') as HTMLElement;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', {
      configurable: true,
      value: () => [link],
    });
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, altKey: true, clientX: 10, clientY: 10 }));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'readable-edit-select', target: expect.objectContaining({ id: 'cta', kind: 'link' }) }),
      '*',
    );
    expect(link.hasAttribute('data-readable-editing')).toBe(false);
    expect(link.hasAttribute('contenteditable')).toBe(false);

    dom.window.close();
  });

  it('still enters inline edit for plain clicks on text and link targets', () => {
    const dom = new JSDOM(
      `<main>
        <h1 data-readable-id="title">Title</h1>
        <a data-readable-id="cta" href="/start">Start</a>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const title = dom.window.document.querySelector('[data-readable-id="title"]') as HTMLElement;
    const link = dom.window.document.querySelector('[data-readable-id="cta"]') as HTMLElement;

    title.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(title.getAttribute('data-readable-editing')).toBe('true');
    title.dispatchEvent(new dom.window.FocusEvent('blur', { bubbles: false }));

    link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(link.getAttribute('data-readable-editing')).toBe('true');

    dom.window.close();
  });

  it('does not enter inline edit when a cycled plain click lands on a text target', () => {
    const dom = new JSDOM(
      `<main>
        <div data-readable-id="card" data-readable-edit="container"><span>Card</span></div>
        <h1 data-readable-id="title">Title</h1>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const card = dom.window.document.querySelector('[data-readable-id="card"]') as HTMLElement;
    const title = dom.window.document.querySelector('[data-readable-id="title"]') as HTMLElement;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', {
      configurable: true,
      value: () => [card, title],
    });

    card.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    expect(card.getAttribute('data-readable-edit-selected')).toBe('true');

    card.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    expect(title.getAttribute('data-readable-edit-selected')).toBe('true');
    expect(title.hasAttribute('data-readable-editing')).toBe(false);
    expect(title.hasAttribute('contenteditable')).toBe(false);

    dom.window.close();
  });

  it('cycles a forwarded readable-edit-click message from the overlay', () => {
    const dom = new JSDOM(
      `<main>
        <div data-readable-id="back" data-readable-edit="container"><span>Back</span></div>
        <div data-readable-id="front" data-readable-edit="container"><span>Front</span></div>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const front = dom.window.document.querySelector('[data-readable-id="front"]') as HTMLElement;
    const back = dom.window.document.querySelector('[data-readable-id="back"]') as HTMLElement;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', {
      configurable: true,
      value: () => [front, back],
    });
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    front.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-click', clientX: 10, clientY: 10 },
    }));

    const selectedIds = postMessage.mock.calls
      .map(([message]) => message as { type?: string; target?: { id?: string } })
      .filter((message) => message.type === 'readable-edit-select')
      .map((message) => message.target?.id);
    expect(selectedIds).toEqual(['front', 'back']);

    dom.window.close();
  });

  it('selects a contained child from the overlay while ignoring a stale parent text range', () => {
    const dom = new JSDOM(
      `<main><div data-readable-id="parent" data-readable-edit="container">Parent <button data-readable-id="child">Child</button></div></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const parent = dom.window.document.querySelector('[data-readable-id="parent"]') as HTMLElement;
    const child = dom.window.document.querySelector('[data-readable-id="child"]') as HTMLElement;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', { configurable: true, value: () => [child, parent] });
    Object.defineProperty(dom.window.document, 'elementFromPoint', { configurable: true, value: () => child });
    const range = dom.window.document.createRange();
    range.selectNodeContents(parent.firstChild!);
    dom.window.getSelection()!.addRange(range);
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-click', clientX: 10, clientY: 10, selectedId: 'parent' },
    }));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'readable-edit-select', target: expect.objectContaining({ id: 'child' }) }),
      '*',
    );
    dom.window.close();
  });

  it('ignores stale ranges for forwarded Alt clicks but preserves them for native clicks', () => {
    const makeDom = () => {
      const dom = new JSDOM(
        `<main><div data-readable-id="parent" data-readable-edit="container">Parent <button data-readable-id="child">Child</button></div></main>${buildManualEditBridge(true)}`,
        { runScripts: 'dangerously', url: 'http://localhost' },
      );
      const parent = dom.window.document.querySelector('[data-readable-id="parent"]') as HTMLElement;
      const child = dom.window.document.querySelector('[data-readable-id="child"]') as HTMLElement;
      const range = dom.window.document.createRange();
      range.selectNodeContents(parent.firstChild!);
      dom.window.getSelection()!.addRange(range);
      return { dom, parent, child, postMessage: vi.spyOn(dom.window.parent, 'postMessage') };
    };
    const overlay = makeDom();
    Object.defineProperty(overlay.dom.window.document, 'elementsFromPoint', { configurable: true, value: () => [overlay.child] });
    Object.defineProperty(overlay.dom.window.document, 'elementFromPoint', { configurable: true, value: () => overlay.child });
    overlay.dom.window.dispatchEvent(new overlay.dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-alt-click', clientX: 10, clientY: 10 },
    }));
    expect(overlay.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'readable-edit-select', target: expect.objectContaining({ id: 'child' }) }), '*',
    );
    overlay.dom.window.close();

    const native = makeDom();
    Object.defineProperty(native.dom.window.document, 'elementsFromPoint', { configurable: true, value: () => [native.child] });
    native.child.dispatchEvent(new native.dom.window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    expect(native.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'readable-edit-select', target: expect.objectContaining({ id: 'parent' }) }), '*',
    );
    native.dom.window.close();
  });

  it('re-enters the same selected text target from an overlay click', () => {
    const dom = new JSDOM(
      `<main><h1 data-readable-id="title">Title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const title = dom.window.document.querySelector('[data-readable-id="title"]') as HTMLElement;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', { configurable: true, value: () => [title] });
    Object.defineProperty(dom.window.document, 'elementFromPoint', { configurable: true, value: () => title });

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-click', clientX: 10, clientY: 10, selectedId: 'title' },
    }));

    expect(title.getAttribute('data-readable-editing')).toBe('true');
    expect(title.getAttribute('contenteditable')).toBe('true');
    dom.window.close();
  });

  it('clears stale hover feedback across overlay selection and DOM replacement', async () => {
    const dom = new JSDOM(
      `<main><div data-readable-id="parent"><button data-readable-id="child">Child</button></div><img data-readable-id="image" data-readable-runtime-hovered="true" alt="Preview"></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const parent = dom.window.document.querySelector('[data-readable-id="parent"]') as HTMLElement;
    const child = dom.window.document.querySelector('[data-readable-id="child"]') as HTMLElement;
    const image = dom.window.document.querySelector('[data-readable-id="image"]') as HTMLElement;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', { configurable: true, value: () => [child, parent] });
    Object.defineProperty(dom.window.document, 'elementFromPoint', { configurable: true, value: () => child });

    expect(image.hasAttribute('data-readable-runtime-hovered')).toBe(false);
    parent.dispatchEvent(new dom.window.MouseEvent('pointerover', { bubbles: true }));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-selected-target', id: 'parent' },
    }));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-click', clientX: 10, clientY: 10, selectedId: 'parent' },
    }));

    expect(parent.hasAttribute('data-readable-runtime-hovered')).toBe(false);

    image.dispatchEvent(new dom.window.MouseEvent('pointerover', { bubbles: true }));
    const clone = image.cloneNode(true);
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-hover-reset' },
    }));
    image.replaceWith(clone);
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    expect(dom.window.document.querySelectorAll('[data-readable-runtime-hovered]')).toHaveLength(0);

    dom.window.close();
  });

  it('inspects the top target without advancing the click cycle', () => {
    const dom = new JSDOM(
      `<main><div data-readable-id="back" data-readable-edit="container"><button>Back</button></div><div data-readable-id="front" data-readable-edit="container"><button>Front</button></div></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const front = dom.window.document.querySelector('[data-readable-id="front"]') as HTMLElement;
    const back = dom.window.document.querySelector('[data-readable-id="back"]') as HTMLElement;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', { configurable: true, value: () => [front, back] });
    Object.defineProperty(dom.window.document, 'elementFromPoint', { configurable: true, value: () => front });
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-click', clientX: 10, clientY: 10, selectedId: 'front' },
    }));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'readable-edit-select', target: expect.objectContaining({ id: 'front' }) }), '*',
    );
    dom.window.close();
  });

  it('falls back to ordinary overlay selection for an invalid selected id', () => {
    const dom = new JSDOM(
      `<main><button data-readable-id="child">Child</button></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const child = dom.window.document.querySelector('[data-readable-id="child"]') as HTMLElement;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', { configurable: true, value: () => [child] });
    Object.defineProperty(dom.window.document, 'elementFromPoint', { configurable: true, value: () => child });
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-click', clientX: 10, clientY: 10, selectedId: 'missing' },
    }));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'readable-edit-select', target: expect.objectContaining({ id: 'child' }) }), '*',
    );
    dom.window.close();
  });

  it('falls back immediately when an overlay activation carries an old selected id that still exists', () => {
    vi.useFakeTimers();
    const dom = new JSDOM(
      `<main><div data-readable-id="old">Old<div class="glow"></div></div><p data-readable-id="current">Current</p></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const old = dom.window.document.querySelector('[data-readable-id="old"]') as HTMLElement;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', { configurable: true, value: () => [old] });
    Object.defineProperty(dom.window.document, 'elementFromPoint', { configurable: true, value: () => old });
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-selected-target', id: 'current' },
    }));

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-click', clientX: 10, clientY: 10, selectedId: 'old' },
    }));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'readable-edit-select', target: expect.objectContaining({ id: 'old' }) }), '*',
    );
    expect(postMessage.mock.calls.filter(([message]) => message.type === 'readable-edit-select')).toHaveLength(1);
    vi.advanceTimersByTime(350);
    expect(postMessage.mock.calls.filter(([message]) => message.type === 'readable-edit-select')).toHaveLength(1);
    dom.window.close();
    vi.useRealTimers();
  });

  it('defers only a same selected structured container and keeps same-id feedback alive', () => {
    vi.useFakeTimers();
    const dom = new JSDOM(
      `<main><div data-readable-id="fancy">Headline<div class="glow"></div></div></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const fancy = dom.window.document.querySelector('[data-readable-id="fancy"]') as HTMLElement;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', { configurable: true, value: () => [fancy] });
    Object.defineProperty(dom.window.document, 'elementFromPoint', { configurable: true, value: () => fancy });
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'readable-edit-selected-target', id: 'fancy' } }));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-click', clientX: 10, clientY: 10, selectedId: 'fancy' },
    }));
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-select' }), '*');
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'readable-edit-selected-target', id: 'fancy' } }));
    vi.advanceTimersByTime(350);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'readable-edit-select', target: expect.objectContaining({ id: 'fancy' }) }), '*',
    );
    dom.window.close();
    vi.useRealTimers();
  });

  it.each([
    ['explicit cancel', { type: 'readable-edit-click-cancel' }],
    ['selection change', { type: 'readable-edit-selected-target', id: 'other' }],
    ['select target', { type: 'readable-edit-select-target', id: 'other' }],
    ['begin text edit', { type: 'readable-edit-begin-text-edit', id: 'other' }],
    ['mode exit', { type: 'readable-edit-mode', enabled: false }],
  ])('cancels a deferred structured click on %s', (_label, cancellation) => {
    vi.useFakeTimers();
    const dom = new JSDOM(
      `<main><div data-readable-id="fancy">Headline<div class="glow"></div></div><p data-readable-id="other">Other</p></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const fancy = dom.window.document.querySelector('[data-readable-id="fancy"]') as HTMLElement;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', { configurable: true, value: () => [fancy] });
    Object.defineProperty(dom.window.document, 'elementFromPoint', { configurable: true, value: () => fancy });
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'readable-edit-selected-target', id: 'fancy' } }));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-click', clientX: 10, clientY: 10, selectedId: 'fancy' },
    }));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: cancellation }));
    postMessage.mockClear();
    vi.advanceTimersByTime(350);
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'readable-edit-select', target: expect.objectContaining({ id: 'fancy' }) }), '*',
    );
    dom.window.close();
    vi.useRealTimers();
  });

  it.each(['normal overlay', 'Alt overlay', 'native click'])('cancels a deferred structured click on a new %s', (nextClick) => {
    vi.useFakeTimers();
    const dom = new JSDOM(
      `<main><div data-readable-id="fancy">Headline<div class="glow"></div></div><button data-readable-id="other">Other</button></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const fancy = dom.window.document.querySelector('[data-readable-id="fancy"]') as HTMLElement;
    const other = dom.window.document.querySelector('[data-readable-id="other"]') as HTMLElement;
    let hit: HTMLElement = fancy;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', { configurable: true, value: () => [hit] });
    Object.defineProperty(dom.window.document, 'elementFromPoint', { configurable: true, value: () => hit });
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'readable-edit-selected-target', id: 'fancy' } }));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-click', clientX: 10, clientY: 10, selectedId: 'fancy' },
    }));
    hit = other;
    if (nextClick === 'native click') {
      other.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    } else {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
        data: {
          type: nextClick === 'Alt overlay' ? 'readable-edit-alt-click' : 'readable-edit-click',
          clientX: 20,
          clientY: 20,
          selectedId: 'fancy',
        },
      }));
    }
    postMessage.mockClear();
    vi.advanceTimersByTime(350);
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'readable-edit-select', target: expect.objectContaining({ id: 'fancy' }) }), '*',
    );
    dom.window.close();
    vi.useRealTimers();
  });

  it('emits a background message for empty click regions', () => {
    const dom = new JSDOM(
      `<main><div>Empty</div></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    dom.window.document.body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(postMessage).toHaveBeenCalledWith({ type: 'readable-edit-background' }, '*');

    dom.window.close();
  });

  it('moves the selected marker to the deeper target on Alt+click', () => {
    const dom = new JSDOM(
      `<main>
        <div data-readable-id="bottom" data-readable-edit="container"><span>Bottom</span></div>
        <div data-readable-id="top" data-readable-edit="container"><span>Top</span></div>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const top = dom.window.document.querySelector('[data-readable-id="top"]') as HTMLElement;
    const bottom = dom.window.document.querySelector('[data-readable-id="bottom"]') as HTMLElement;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', {
      configurable: true,
      value: () => [top, bottom],
    });

    top.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, altKey: true, clientX: 10, clientY: 10 }));

    expect(top.hasAttribute('data-readable-edit-selected')).toBe(false);
    expect(bottom.getAttribute('data-readable-edit-selected')).toBe('true');

    dom.window.close();
  });

  it('keeps runtime selection marker out of source-shaped target data', () => {
    const bridge = buildManualEditBridge(true);

    expect(bridge).toContain("attr.name === 'data-readable-edit-selected'");
    expect(bridge).toContain('replace(/\\sdata-readable-edit-selected="[^"]*"/g, \'\')');
    expect(bridge).toContain('[data-readable-edit-selected]');
  });

  it('marks flex/grid targets as layout containers', () => {
    const bridge = buildManualEditBridge(true);

    expect(bridge).toContain('isLayoutContainer: isLayoutContainer(el)');
    expect(bridge).toContain("display.indexOf('flex') >= 0 || display.indexOf('grid') >= 0");
  });

  it('turns text targets into inline editors and commits changed text', () => {
    const dom = new JSDOM(
      `<main><h1 data-readable-id="title">Original title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const title = dom.window.document.querySelector('[data-readable-id="title"]') as HTMLElement;
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    title.dispatchEvent(new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: 8,
      clientY: 8,
    }));
    expect(title.getAttribute('contenteditable')).toBe('true');
    expect(title.getAttribute('data-readable-editing')).toBe('true');
    expect(postMessage).toHaveBeenCalledWith({
      type: 'readable-edit-select',
      target: expect.objectContaining({
        id: 'title',
        kind: 'text',
      }),
    }, '*');

    title.textContent = 'Edited title';
    title.dispatchEvent(new dom.window.FocusEvent('blur', { bubbles: false }));

    expect(title.hasAttribute('contenteditable')).toBe(false);
    expect(title.hasAttribute('data-readable-editing')).toBe(false);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'readable-edit-text-commit',
      id: 'title',
      value: 'Edited title',
    }, '*');

    dom.window.close();
  });

  it('clears sibling hover feedback when the pointer returns to an inline editor', () => {
    const dom = new JSDOM(
      `<main><h1 data-readable-id="title">Title</h1><img data-readable-id="image" alt="Preview"></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const title = dom.window.document.querySelector('[data-readable-id="title"]') as HTMLElement;
    const image = dom.window.document.querySelector('[data-readable-id="image"]') as HTMLElement;

    title.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    image.dispatchEvent(new dom.window.MouseEvent('pointerover', { bubbles: true }));
    expect(image.getAttribute('data-readable-runtime-hovered')).toBe('true');

    title.dispatchEvent(new dom.window.MouseEvent('pointerover', { bubbles: true }));
    expect(dom.window.document.querySelectorAll('[data-readable-runtime-hovered]')).toHaveLength(0);

    dom.window.close();
  });

  it('turns text-only container targets into inline editors', () => {
    const dom = new JSDOM(
      `<main><div data-readable-id="tagline">Original tagline</div></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const tagline = dom.window.document.querySelector('[data-readable-id="tagline"]') as HTMLElement;
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    tagline.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(tagline.getAttribute('contenteditable')).toBe('true');
    expect(postMessage).toHaveBeenCalledWith({
      type: 'readable-edit-select',
      target: expect.objectContaining({
        id: 'tagline',
        kind: 'text',
      }),
    }, '*');

    tagline.textContent = 'Edited tagline';
    tagline.dispatchEvent(new dom.window.FocusEvent('blur', { bubbles: false }));

    expect(postMessage).toHaveBeenCalledWith({
      type: 'readable-edit-text-commit',
      id: 'tagline',
      value: 'Edited tagline',
    }, '*');

    dom.window.close();
  });

  it('turns lower-level heading targets into inline editors', () => {
    const dom = new JSDOM(
      `<main><h4 data-readable-id="eyebrow">Original eyebrow</h4></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const eyebrow = dom.window.document.querySelector('[data-readable-id="eyebrow"]') as HTMLElement;
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    eyebrow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(eyebrow.getAttribute('contenteditable')).toBe('true');
    expect(postMessage).toHaveBeenCalledWith({
      type: 'readable-edit-select',
      target: expect.objectContaining({
        id: 'eyebrow',
        kind: 'text',
      }),
    }, '*');

    dom.window.close();
  });

  it('targets the text passage when clicking inline formatting leaves', () => {
    const dom = new JSDOM(
      `<main><div data-readable-id="wrapper" class="zh"><b data-readable-source-path="path-0-0-0">Visible text</b></div></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const leaf = dom.window.document.querySelector('b') as HTMLElement;
    const wrapper = dom.window.document.querySelector('[data-readable-id="wrapper"]') as HTMLElement;
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    leaf.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(wrapper.getAttribute('contenteditable')).toBe('true');
    expect(leaf.hasAttribute('contenteditable')).toBe(false);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'readable-edit-select',
      target: expect.objectContaining({
        id: 'wrapper',
        kind: 'text',
        tagName: 'div',
      }),
    }, '*');

    dom.window.close();
  });

  it('turns single-inline value wrappers into inline editors', () => {
    const dom = new JSDOM(
      `<main><div class="value" data-readable-source-path="path-0-0"><strong data-readable-source-path="path-0-0-0">42</strong></div></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const value = dom.window.document.querySelector('.value') as HTMLElement;
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    value.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(value.getAttribute('contenteditable')).toBe('true');
    expect(postMessage).toHaveBeenCalledWith({
      type: 'readable-edit-select',
      target: expect.objectContaining({
        id: 'path-0-0',
        kind: 'text',
        tagName: 'div',
        className: 'value',
      }),
    }, '*');

    dom.window.close();
  });

  it('keeps nested containers out of inline text editing', () => {
    const dom = new JSDOM(
      `<main><section data-readable-id="hero"><h1 data-readable-id="title">Original title</h1></section></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const section = dom.window.document.querySelector('[data-readable-id="hero"]') as HTMLElement;
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    section.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(section.hasAttribute('contenteditable')).toBe(false);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'readable-edit-select',
      target: expect.objectContaining({
        id: 'hero',
        kind: 'container',
        textEditTargetId: undefined,
      }),
    }, '*');

    dom.window.close();
  });

  it('commits inline text edits with Escape (PPT: keeps typed text, promotes to object-select)', () => {
    const dom = new JSDOM(
      `<main><p data-readable-id="body">Original body</p></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const body = dom.window.document.querySelector('[data-readable-id="body"]') as HTMLElement;
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    body.textContent = 'Draft body';
    body.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape',
    }));

    expect(body.hasAttribute('data-readable-editing')).toBe(false);
    expect(body.textContent).toBe('Draft body');
    expect(postMessage).toHaveBeenCalledWith({
      type: 'readable-edit-text-commit',
      id: 'body',
      value: 'Draft body',
    }, '*');

    dom.window.close();
  });

  it('enters inline text edit on an readable-edit-begin-text-edit message', () => {
    const dom = new JSDOM(
      `<main><h1 data-readable-id="title">Original title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const title = dom.window.document.querySelector('[data-readable-id="title"]') as HTMLElement;

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true },
    }));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-begin-text-edit', id: 'title' },
    }));

    expect(title.getAttribute('contenteditable')).toBe('true');
    expect(title.getAttribute('data-readable-editing')).toBe('true');

    dom.window.close();
  });

  it('exposes structured text containers as container objects with a text edit target', async () => {
    const posts: Array<{ type?: string; targets?: Array<{ id: string; kind?: string; textEditTargetId?: string }>; html?: string }> = [];
    const dom = new JSDOM(
      `<main><div data-readable-id="fancy-title">Big Headline<div class="glow-underline"></div></div></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const title = dom.window.document.querySelector('[data-readable-id="fancy-title"]') as HTMLElement;
    title.getBoundingClientRect = () => ({ x: 0, y: 0, width: 240, height: 64, top: 0, right: 240, bottom: 64, left: 0, toJSON: () => ({}) } as DOMRect);
    dom.window.parent.postMessage = ((m: unknown) => { posts.push(m as { type?: string; targets?: Array<{ id: string; kind?: string; textEditTargetId?: string }>; html?: string }); }) as typeof dom.window.parent.postMessage;

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true },
    }));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

    const targets = posts.find((m) => m.type === 'readable-edit-targets')?.targets ?? [];
    expect(targets.find((target) => target.id === 'fancy-title')).toMatchObject({
      kind: 'container',
      textEditTargetId: 'fancy-title',
    });

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-begin-text-edit', id: 'fancy-title' },
    }));

    expect(title.getAttribute('contenteditable')).toBe('true');
    title.firstChild!.textContent = 'Edited Headline';
    title.querySelector('.glow-underline')!.setAttribute('data-readable-runtime-hovered', 'true');
    title.dispatchEvent(new dom.window.FocusEvent('blur', { bubbles: false }));

    expect(posts).toContainEqual(expect.objectContaining({
      type: 'readable-edit-html-commit',
      html: 'Edited Headline<div class="glow-underline"></div>',
    }));

    dom.window.close();
  });

  it('exposes split and icon text containers as self-editable structured text', async () => {
    const posts: Array<{ type?: string; targets?: Array<{ id: string; kind?: string; textEditTargetId?: string }> }> = [];
    const dom = new JSDOM(
      `<main>
        <div data-readable-id="grad"><span data-readable-source-path="path-0-0-0">Half</span> <span data-readable-source-path="path-0-0-1">Title</span></div>
        <div data-readable-id="icon-label"><svg viewBox="0 0 1 1"><path d="M0 0h1v1z"></path></svg><span>Label</span></div>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const grad = dom.window.document.querySelector('[data-readable-id="grad"]') as HTMLElement;
    const icon = dom.window.document.querySelector('[data-readable-id="icon-label"]') as HTMLElement;
    grad.getBoundingClientRect = () => ({ x: 0, y: 0, width: 240, height: 64, top: 0, right: 240, bottom: 64, left: 0, toJSON: () => ({}) } as DOMRect);
    icon.getBoundingClientRect = () => ({ x: 0, y: 80, width: 180, height: 40, top: 80, right: 180, bottom: 120, left: 0, toJSON: () => ({}) } as DOMRect);
    dom.window.parent.postMessage = ((m: unknown) => { posts.push(m as { type?: string; targets?: Array<{ id: string; kind?: string; textEditTargetId?: string }> }); }) as typeof dom.window.parent.postMessage;

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true },
    }));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

    const targets = posts.find((m) => m.type === 'readable-edit-targets')?.targets ?? [];
    expect(targets.find((target) => target.id === 'grad')).toMatchObject({
      kind: 'container',
      textEditTargetId: 'grad',
    });
    expect(targets.find((target) => target.id === 'icon-label')).toMatchObject({
      kind: 'container',
      textEditTargetId: 'icon-label',
    });
    expect(targets.some((target) => target.id === 'path-0-0-0')).toBe(false);
    expect(targets.some((target) => target.id === 'path-0-0-1')).toBe(false);

    dom.window.close();
  });

  it('does not expose containers with non-round-trippable children as structured text', async () => {
    const posts: Array<{ type?: string; targets?: Array<{ id: string; kind?: string; textEditTargetId?: string }> }> = [];
    const dom = new JSDOM(
      `<main>
        <div data-readable-id="image-label">Logo <img src="icon.png"></div>
        <div data-readable-id="svg-title"><svg viewBox="0 0 1 1"><title>Search</title><path d="M0 0h1v1z"></path></svg><span>Label</span></div>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const imageLabel = dom.window.document.querySelector('[data-readable-id="image-label"]') as HTMLElement;
    const svgTitle = dom.window.document.querySelector('[data-readable-id="svg-title"]') as HTMLElement;
    imageLabel.getBoundingClientRect = () => ({ x: 0, y: 0, width: 180, height: 40, top: 0, right: 180, bottom: 40, left: 0, toJSON: () => ({}) } as DOMRect);
    svgTitle.getBoundingClientRect = () => ({ x: 0, y: 80, width: 180, height: 40, top: 80, right: 180, bottom: 120, left: 0, toJSON: () => ({}) } as DOMRect);
    dom.window.parent.postMessage = ((m: unknown) => { posts.push(m as { type?: string; targets?: Array<{ id: string; kind?: string; textEditTargetId?: string }> }); }) as typeof dom.window.parent.postMessage;

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true },
    }));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

    const targets = posts.find((m) => m.type === 'readable-edit-targets')?.targets ?? [];
    expect(targets.find((target) => target.id === 'image-label')).toMatchObject({
      kind: 'container',
      textEditTargetId: undefined,
    });
    expect(targets.find((target) => target.id === 'svg-title')).toMatchObject({
      kind: 'container',
      textEditTargetId: undefined,
    });

    dom.window.close();
  });

  it('exits inline text edit (blur -> commit) on an readable-edit-end-text-edit message', () => {
    const posts: Array<{ type?: string; editing?: boolean }> = [];
    const dom = new JSDOM(
      `<main><h1 data-readable-id="title">Original title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const title = dom.window.document.querySelector('[data-readable-id="title"]') as HTMLElement;
    dom.window.parent.postMessage = ((m: unknown) => { posts.push(m as { type?: string; editing?: boolean }); }) as typeof dom.window.parent.postMessage;

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true },
    }));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-begin-text-edit', id: 'title' },
    }));
    expect(title.getAttribute('data-readable-editing')).toBe('true');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-end-text-edit' },
    }));

    expect(title.hasAttribute('data-readable-editing')).toBe(false);
    const state = posts.filter((m) => m.type === 'readable-edit-selection-state').pop();
    expect(state?.editing).toBe(false);

    dom.window.close();
  });

  it('reports the element translate in select target styles', () => {
    const dom = new JSDOM(
      `<main><h1 data-readable-id="hero" style="translate: 12px 34px">Title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    dom.window.document.querySelector('[data-readable-id="hero"]')!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
    );

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'readable-edit-select',
        target: expect.objectContaining({
          styles: expect.objectContaining({ translate: '12px 34px' }),
        }),
      }),
      '*',
    );

    dom.window.close();
  });

  it('blocks clicks on unmapped elements while edit mode is enabled', () => {
    const dom = new JSDOM(
      `<main><button id="cta">Launch</button></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const button = dom.window.document.getElementById('cta') as HTMLButtonElement;
    const clicked = vi.fn();
    button.addEventListener('click', clicked);

    const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    const result = button.dispatchEvent(event);

    expect(result).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(clicked).not.toHaveBeenCalled();

    dom.window.close();
  });

  it('re-broadcasts targets when layout mutates without a resize or scroll event', async () => {
    // Deck slide navigation, transition settle, and media loads reflow the page
    // with no resize/scroll event; without an in-bridge layout observer the host
    // overlays (resize handles, inspector panel, hover icon) render stale rects.
    const posts: Array<{ type?: string }> = [];
    const dom = new JSDOM(
      `<main><h1 data-readable-source-path="path-0-0">Title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    dom.window.parent.postMessage = ((message: unknown) => {
      posts.push(message as { type?: string });
    }) as typeof dom.window.parent.postMessage;

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true },
    }));
    // Let initial discovery (and any runtime-id stamping it performs) settle.
    await new Promise((resolve) => dom.window.setTimeout(resolve, 60));

    const countBefore = posts.filter((message) => message.type === 'readable-edit-targets').length;
    expect(countBefore).toBeGreaterThan(0);

    // A deck-style class flip: mutates layout, fires neither resize nor scroll.
    dom.window.document.querySelector('h1')!.setAttribute('class', 'slide-active');
    await new Promise((resolve) => dom.window.setTimeout(resolve, 60));

    const countAfter = posts.filter((message) => message.type === 'readable-edit-targets').length;
    expect(countAfter).toBeGreaterThan(countBefore);

    dom.window.close();
  });

  it('coalesces preview-write layout echoes into one deferred post after the stream quiets', async () => {
    // readable-edit-preview-style streams one inline-style write per frame during a
    // drag; the layout observer must not echo a per-frame readable-edit-targets storm
    // back at the host, but the FINAL layout state must still re-broadcast once
    // the stream quiets. Dropping it (instead of deferring it) strands the host
    // overlays on stale rects after every drag: no resize/scroll event follows
    // a pointerup, so nothing else re-measures.
    const posts: Array<{ type?: string }> = [];
    const dom = new JSDOM(
      `<main><h1 data-readable-source-path="path-0-0">Title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    dom.window.parent.postMessage = ((message: unknown) => {
      posts.push(message as { type?: string });
    }) as typeof dom.window.parent.postMessage;

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true },
    }));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 60));

    const countBefore = posts.filter((message) => message.type === 'readable-edit-targets').length;
    for (const width of ['120px', '130px', '140px']) {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
        data: { type: 'readable-edit-preview-style', id: 'path-0-0', styles: { width }, version: 7 },
      }));
      await new Promise((resolve) => dom.window.setTimeout(resolve, 10));
    }

    // Inside the mute window: no per-frame storm.
    const countDuring = posts.filter((message) => message.type === 'readable-edit-targets').length;
    expect(countDuring).toBe(countBefore);

    // After the stream quiets: exactly one coalesced re-broadcast.
    await new Promise((resolve) => dom.window.setTimeout(resolve, 200));
    const countAfter = posts.filter((message) => message.type === 'readable-edit-targets').length;
    expect(countAfter).toBe(countBefore + 1);

    dom.window.close();
  });

  it('includes the freshly measured target rect in preview-style acks', () => {
    // During a drag the host renders the resize handles from the element's REAL
    // box, not the mouse-implied one: flex/grid/min-content constraints can
    // clamp or ignore the streamed width/height. The per-frame ack is the
    // feedback channel, so it must carry the post-apply rect.
    const dom = new JSDOM(
      `<main><h1 data-readable-id="hero">Title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const hero = dom.window.document.querySelector('[data-readable-id="hero"]') as HTMLElement;
    hero.getBoundingClientRect = () => ({
      x: 10, y: 20, width: 300, height: 80,
      top: 20, right: 310, bottom: 100, left: 10,
      toJSON: () => ({}),
    } as DOMRect);
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'readable-edit-preview-style',
        id: 'hero',
        styles: { width: '300px' },
        version: 9,
        includeAuthoredSize: true,
      },
    }));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'readable-edit-preview-style-applied',
        id: 'hero',
        version: 9,
        ok: true,
        rect: { x: 10, y: 20, width: 300, height: 80 },
        // Post-apply computed width/height: the host's resize baseline needs
        // the value layout actually used, not the (possibly clamped) request.
        cssSize: { width: expect.any(String), height: expect.any(String) },
        authoredSize: { width: '300px', height: '' },
      }),
      '*',
    );

    dom.window.close();
  });

  it('reports a generic constraint only for requested resize axes', () => {
    const dom = new JSDOM(
      `<main><h1 data-readable-id="hero">Title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const hero = dom.window.document.querySelector('[data-readable-id="hero"]') as HTMLElement;
    hero.getBoundingClientRect = () => ({
      x: 10, y: 20, width: 560.625, height: 80,
      top: 20, right: 570.625, bottom: 100, left: 10,
      toJSON: () => ({}),
    } as DOMRect);
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    const createElement = vi.spyOn(dom.window.document, 'createElement');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'readable-edit-preview-style',
        id: 'hero',
        styles: { width: '741px' },
        version: 12,
        resize: {
          axes: ['width'],
          requested: { width: 741, height: 200 },
        },
      },
    }));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'readable-edit-preview-style-applied',
        resize: {
          announce: false,
          constraints: [{
            axis: 'width',
            requested: 741,
            applied: 560.625,
            reason: 'layout',
          }],
        },
      }),
      '*',
    );
    expect(createElement.mock.calls.filter(([tag]) => tag === 'style')).toHaveLength(0);

    dom.window.close();
  });

  it('treats resize differences of one pixel or less as applied', () => {
    const dom = new JSDOM(
      `<main><h1 data-readable-id="hero">Title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const hero = dom.window.document.querySelector('[data-readable-id="hero"]') as HTMLElement;
    hero.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 320, height: 80,
      top: 0, right: 320, bottom: 80, left: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'readable-edit-preview-style',
        id: 'hero',
        styles: { width: '321px' },
        version: 13,
        resize: {
          axes: ['width'],
          requested: { width: 321, height: 80 },
          includeDetails: true,
        },
      },
    }));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'readable-edit-preview-style-applied',
        resize: { constraints: [], announce: true },
      }),
      '*',
    );

    dom.window.close();
  });

  it('attributes detailed max and min constraints when the applied rect matches the authored limits', () => {
    const dom = new JSDOM(
      `<style>.hero { max-width: 320px; min-height: 90px; }</style><main><h1 class="hero" data-readable-id="hero">Title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const hero = dom.window.document.querySelector('[data-readable-id="hero"]') as HTMLElement;
    hero.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 320, height: 90,
      top: 0, right: 320, bottom: 90, left: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'readable-edit-preview-style',
        id: 'hero',
        styles: { width: '500px', height: '60px' },
        version: 13,
        resize: {
          axes: ['width', 'height'],
          requested: { width: 500, height: 60 },
          includeDetails: true,
        },
      },
    }));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'readable-edit-preview-style-applied',
        resize: {
          announce: true,
          constraints: [
            {
              axis: 'width', requested: 500, applied: 320, reason: 'max',
              property: 'max-width', value: '320px',
            },
            {
              axis: 'height', requested: 60, applied: 90, reason: 'min',
              property: 'min-height', value: '90px',
            },
          ],
        },
      }),
      '*',
    );

    dom.window.close();
  });

  it('keeps unprovable detailed constraints generic without probing authored CSS', () => {
    const dom = new JSDOM(
      `<style>.hero { max-width: 50%; }</style><main><h1 class="hero" data-readable-id="hero">Title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const hero = dom.window.document.querySelector('[data-readable-id="hero"]') as HTMLElement;
    hero.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 320, height: 80,
      top: 0, right: 320, bottom: 80, left: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    const createElement = vi.spyOn(dom.window.document, 'createElement');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'readable-edit-preview-style',
        id: 'hero',
        styles: { width: '500px' },
        version: 14,
        resize: {
          axes: ['width'],
          requested: { width: 500, height: 80 },
          includeDetails: true,
        },
      },
    }));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        resize: {
          announce: true,
          constraints: [{
            axis: 'width', requested: 500, applied: 320, reason: 'layout',
          }],
        },
      }),
      '*',
    );
    expect(createElement.mock.calls.filter(([tag]) => tag === 'style')).toHaveLength(0);

    dom.window.close();
  });

  it('omits authored-size work for high-frequency sizing preview frames', () => {
    const dom = new JSDOM(
      `<style>.hero { width: 320px; }</style><main><h1 class="hero" data-readable-id="hero">Title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    const createElement = vi.spyOn(dom.window.document, 'createElement');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-preview-style', id: 'hero', styles: { width: '340px' }, version: 10 },
    }));

    const ack = postMessage.mock.calls
      .map(([message]) => message as { type?: string; authoredSize?: unknown })
      .find((message) => message.type === 'readable-edit-preview-style-applied');
    expect(ack).toBeTruthy();
    expect(ack).not.toHaveProperty('authoredSize');
    expect(createElement.mock.calls.filter(([tag]) => tag === 'style')).toHaveLength(0);

    dom.window.close();
  });

  it('probes the winning authored size once for low-frequency inspector updates', () => {
    const dom = new JSDOM(
      `<style>.hero { width: 320px !important; }</style><main><h1 class="hero" data-readable-id="hero">Title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    for (const width of ['100%', '']) {
      postMessage.mockClear();
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
        data: {
          type: 'readable-edit-preview-style',
          id: 'hero',
          styles: { width },
          version: 11,
          includeAuthoredSize: true,
        },
      }));
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'readable-edit-preview-style-applied',
          authoredSize: { width: '320px', height: '' },
        }),
        '*',
      );
    }

    dom.window.close();
  });

  it('includes computed and stylesheet-authored sizes on selected targets', () => {
    const dom = new JSDOM(
      `<style>.hero-size { width: 320px; height: 100%; }</style><main><h1 class="hero-size" data-readable-id="hero">Title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    dom.window.document.querySelector('[data-readable-id="hero"]')!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
    );

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'readable-edit-select',
        target: expect.objectContaining({
          id: 'hero',
          cssSize: { width: expect.any(String), height: expect.any(String) },
          authoredSize: { width: '320px', height: '100%' },
        }),
      }),
      '*',
    );

    dom.window.close();
  });

  it('hydrates a lightweight hover target when the host selects its affordance', () => {
    const dom = new JSDOM(
      `<style>.hero-size { width: 320px; }</style><main><h1 class="hero-size" data-readable-id="hero">Title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-select-target', id: 'hero' },
    }));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'readable-edit-select',
        target: expect.objectContaining({
          id: 'hero',
          authoredSize: { width: '320px', height: '' },
        }),
      }),
      '*',
    );

    dom.window.close();
  });

  it('preserves stylesheet activation conditions when resolving authored sizes', () => {
    const dom = new JSDOM(
      `<style>.hero-size { height: 48px; }</style>
       <style media="print">.hero-size { width: 900px; }</style>
       <style id="disabled-size">.hero-size { width: 800px; }</style>
       <main><h1 class="hero-size" data-readable-id="hero">Title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const disabledSheet = (dom.window.document.getElementById('disabled-size') as HTMLStyleElement).sheet;
    if (!disabledSheet) throw new Error('Expected disabled test stylesheet');
    Object.defineProperty(disabledSheet, 'disabled', { configurable: true, value: true });
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    dom.window.document.querySelector('[data-readable-id="hero"]')!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
    );

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'readable-edit-select',
        target: expect.objectContaining({
          authoredSize: { width: '', height: '48px' },
        }),
      }),
      '*',
    );

    dom.window.close();
  });

  it('uses HTML width and height hints below winning CSS declarations', () => {
    const dom = new JSDOM(
      `<style>.photo { width: 50%; }</style>
       <main><img class="photo" data-readable-id="photo" width="640" height="360" alt="Preview"></main>
       ${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    dom.window.document.querySelector('[data-readable-id="photo"]')!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
    );

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'readable-edit-select',
        target: expect.objectContaining({
          authoredSize: { width: '50%', height: '360px' },
        }),
      }),
      '*',
    );

    dom.window.close();
  });

  it('ignores width attributes that are not valid image pixel hints', () => {
    const dom = new JSDOM(
      `<main>
         <div data-readable-id="box" width="640">Box</div>
         <img data-readable-id="photo" width="50%" height="360" alt="Preview">
       </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    for (const [id, authoredSize] of [
      ['box', { width: '', height: '' }],
      ['photo', { width: '', height: '360px' }],
    ] as const) {
      postMessage.mockClear();
      dom.window.document.querySelector(`[data-readable-id="${id}"]`)!.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'readable-edit-select',
          target: expect.objectContaining({ authoredSize }),
        }),
        '*',
      );
    }

    dom.window.close();
  });

  it('reports the flex main axis for flex-item targets', () => {
    // Dragging width on a flex-row item (or height on a flex-column item) is a
    // main-axis resize: layout ignores the bare width/height unless the commit
    // also pins the item (flex: none). The host needs to know the axis.
    const dom = new JSDOM(
      `<main>
        <div style="display:flex"><h1 data-readable-id="row-item">Row</h1></div>
        <div style="display:flex;flex-direction:column"><h2 data-readable-id="column-item">Column</h2></div>
        <div><h3 data-readable-id="block-item">Block</h3></div>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    for (const [id, axis] of [['row-item', 'row'], ['column-item', 'column'], ['block-item', null]] as const) {
      postMessage.mockClear();
      dom.window.document.querySelector(`[data-readable-id="${id}"]`)!.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'readable-edit-select',
          target: expect.objectContaining({ id, flexItemAxis: axis }),
        }),
        '*',
      );
    }

    dom.window.close();
  });

  it('reports the rect-to-CSS scale of transformed elements on each axis', () => {
    // Under an ancestor transform (deck fit-to-canvas), getBoundingClientRect
    // px = CSS px * k. The host needs k to convert drag deltas back to the CSS
    // width/height space the inspector shows and the source file stores.
    const dom = new JSDOM(
      `<main><h1 data-readable-id="title">Title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const title = dom.window.document.querySelector('[data-readable-id="title"]') as HTMLElement;
    title.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 200, height: 50,
      top: 0, right: 200, bottom: 50, left: 0,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(title, 'offsetWidth', { value: 160 });
    Object.defineProperty(title, 'offsetHeight', { value: 40 });
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    title.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(postMessage).toHaveBeenCalledWith({
      type: 'readable-edit-select',
      target: expect.objectContaining({
        id: 'title',
        rectScale: { x: 1.25, y: 1.25 },
      }),
    }, '*');

    dom.window.close();
  });

  it('re-broadcasts targets on scroll so a selected element rect does not go stale', async () => {
    const posts: Array<{ type?: string }> = [];
    const dom = new JSDOM(
      `<main><h1 data-readable-source-path="path-0-0">Title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    dom.window.parent.postMessage = ((message: unknown) => {
      posts.push(message as { type?: string });
    }) as typeof dom.window.parent.postMessage;

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true },
    }));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

    const countBeforeScroll = posts.filter((message) => message.type === 'readable-edit-targets').length;
    expect(countBeforeScroll).toBeGreaterThan(0);

    dom.window.document.dispatchEvent(new dom.window.Event('scroll'));

    const countAfterScroll = posts.filter((message) => message.type === 'readable-edit-targets').length;
    expect(countAfterScroll).toBeGreaterThan(countBeforeScroll);

    dom.window.close();
  });
});

describe('manual edit duplicate preview bridge', () => {
  it('creates, updates, and removes a transient source-derived clone without discovering it', () => {
    const dom = new JSDOM(
      `<main><h1 data-readable-id="original">Original</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const original = dom.window.document.querySelector('[data-readable-id="original"]') as HTMLElement;
    const rect = () => ({
      x: 10, y: 20, width: 100, height: 30, top: 20, right: 110, bottom: 50, left: 10,
      toJSON: () => ({}),
    } as DOMRect);
    dom.window.HTMLElement.prototype.getBoundingClientRect = rect;
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true, documentEpoch: 'epoch-1' },
    }));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'readable-edit-duplicate-create',
        documentEpoch: 'epoch-1',
        transactionId: 'duplicate-1',
        sequence: 1,
        originalId: 'original',
        duplicateRootId: 'original-copy',
        previewHtml: '<h1 data-readable-id="original-copy">Original</h1>',
        baselineTranslate: '',
      },
    }));

    const duplicate = dom.window.document.querySelector('[data-readable-id="original-copy"]') as HTMLElement;
    expect(duplicate).not.toBeNull();
    expect(duplicate.getAttribute('data-readable-edit-transient')).toBe('true');
    expect(duplicate.getAttribute('aria-hidden')).toBe('true');
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'readable-edit-duplicate-preview',
      transactionId: 'duplicate-1',
      documentEpoch: 'epoch-1',
      sequence: 1,
      ok: true,
    }), '*');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'readable-edit-duplicate-update',
        documentEpoch: 'epoch-1',
        transactionId: 'duplicate-1',
        sequence: 2,
        translate: '12px 7px',
      },
    }));
    expect(duplicate.style.getPropertyValue('translate')).toBe('12px 7px');
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'readable-edit-duplicate-preview',
      transactionId: 'duplicate-1',
      sequence: 2,
      ok: true,
    }), '*');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'readable-edit-duplicate-cancel',
        documentEpoch: 'epoch-1',
        transactionId: 'duplicate-1',
        sequence: 3,
      },
    }));
    expect(dom.window.document.querySelector('[data-readable-id="original-copy"]')).toBeNull();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'readable-edit-duplicate-removed',
      transactionId: 'duplicate-1',
      sequence: 3,
    }), '*');
    expect(original.getAttribute('data-readable-edit-transient')).toBeNull();
    dom.window.close();
  });

  it('returns insertion offsets in CSS pixels under an ancestor transform', () => {
    const dom = new JSDOM(
      `<main><h1 data-readable-id="original">Original</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const original = dom.window.document.querySelector('[data-readable-id="original"]') as HTMLElement;
    Object.defineProperty(original, 'offsetWidth', { configurable: true, value: 50 });
    Object.defineProperty(original, 'offsetHeight', { configurable: true, value: 30 });
    dom.window.HTMLElement.prototype.getBoundingClientRect = function getRect() {
      const isDuplicate = this.getAttribute('data-readable-id') === 'original-copy';
      const translateX = Number.parseFloat(this.style.getPropertyValue('translate').split(/\s+/)[0] || '0') || 0;
      return {
        x: isDuplicate ? translateX * 2 : 20,
        y: 10,
        width: 100,
        height: 60,
        top: 10,
        right: isDuplicate ? translateX * 2 + 100 : 120,
        bottom: 70,
        left: isDuplicate ? translateX * 2 : 20,
        toJSON: () => ({}),
      } as DOMRect;
    };
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true, documentEpoch: 'epoch-scale' },
    }));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'readable-edit-duplicate-create', documentEpoch: 'epoch-scale', transactionId: 'duplicate-scale',
        sequence: 1, originalId: 'original', duplicateRootId: 'original-copy',
        previewHtml: '<h1 data-readable-id="original-copy">Original</h1>', baselineTranslate: '',
      },
    }));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'readable-edit-duplicate-preview',
      placementOffset: { x: 10, y: 0 },
      ok: true,
    }), '*');
    dom.window.close();
  });

  it('removes a rejected in-flight clone and invalidates a transaction after external reflow', () => {
    const dom = new JSDOM(
      `<main><h1 data-readable-id="original">Original</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const original = dom.window.document.querySelector('[data-readable-id="original"]') as HTMLElement;
    let originalMoved = false;
    dom.window.HTMLElement.prototype.getBoundingClientRect = function getRect() {
      const moved = this === original && originalMoved;
      return {
        x: moved ? 11 : 10,
        y: 20,
        width: this.getAttribute('data-readable-edit-transient') === 'true' ? 80 : 100,
        height: 30,
        top: 20,
        right: moved ? 91 : 110,
        bottom: 50,
        left: moved ? 11 : 10,
        toJSON: () => ({}),
      } as DOMRect;
    };
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true, documentEpoch: 'epoch-1' },
    }));
    const create = {
      type: 'readable-edit-duplicate-create', documentEpoch: 'epoch-1', transactionId: 'duplicate-reject',
      sequence: 1, originalId: 'original', duplicateRootId: 'original-copy',
      previewHtml: '<h1 data-readable-id="original-copy">Original</h1>', baselineTranslate: '',
    };
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: create }));
    expect(dom.window.document.querySelector('[data-readable-id="original-copy"]')).toBeNull();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'readable-edit-duplicate-preview', ok: false, transactionId: 'duplicate-reject',
    }), '*');

    // A successful preflight followed by an external layout change must remove
    // the transient before it can be committed against stale geometry.
    dom.window.HTMLElement.prototype.getBoundingClientRect = function getStableRect() {
      return {
        x: originalMoved && this === original ? 13 : 10,
        y: 20,
        width: 100,
        height: 30,
        top: 20,
        right: originalMoved && this === original ? 113 : 110,
        bottom: 50,
        left: originalMoved && this === original ? 13 : 10,
        toJSON: () => ({}),
      } as DOMRect;
    };
    const validCreate = { ...create, transactionId: 'duplicate-reflow', sequence: 1 };
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: validCreate }));
    expect(dom.window.document.querySelector('[data-readable-id="original-copy"]')).not.toBeNull();
    originalMoved = true;
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'readable-edit-duplicate-update', documentEpoch: 'epoch-1', transactionId: 'duplicate-reflow',
        sequence: 2, translate: '12px 0px',
      },
    }));
    expect(dom.window.document.querySelector('[data-readable-id="original-copy"]')).toBeNull();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'readable-edit-duplicate-preview', ok: false, transactionId: 'duplicate-reflow', sequence: 2,
    }), '*');
    dom.window.close();
  });

  it('rejects a clone that changes computed styles through a sibling-sensitive selector', () => {
    const dom = new JSDOM(
      `<style>[data-readable-id="original"]:last-child { color: rgb(1, 2, 3); }</style>
       <main><h1 data-readable-id="original">Original</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    dom.window.HTMLElement.prototype.getBoundingClientRect = (() => ({
      x: 10, y: 20, width: 100, height: 30, top: 20, right: 110, bottom: 50, left: 10,
      toJSON: () => ({}),
    } as DOMRect));
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true, documentEpoch: 'epoch-style' },
    }));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'readable-edit-duplicate-create', documentEpoch: 'epoch-style', transactionId: 'duplicate-style',
        sequence: 1, originalId: 'original', duplicateRootId: 'original-copy',
        previewHtml: '<h1 data-readable-id="original-copy">Original</h1>', baselineTranslate: '',
      },
    }));
    expect(dom.window.document.querySelector('[data-readable-id="original-copy"]')).toBeNull();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'readable-edit-duplicate-preview', transactionId: 'duplicate-style', ok: false,
    }), '*');
    dom.window.close();
  });

  it('rejects native interactive content and itemref references before insertion', () => {
    const cases = [
      { name: 'button', previewHtml: '<button data-readable-id="original-copy">Copy</button>' },
      { name: 'itemref', previewHtml: '<div data-readable-id="original-copy" itemref="title">Copy</div>' },
    ];
    for (const testCase of cases) {
      const dom = new JSDOM(
        `<main><h1 data-readable-id="original">Original</h1></main>${buildManualEditBridge(true)}`,
        { runScripts: 'dangerously', url: 'http://localhost' },
      );
      dom.window.HTMLElement.prototype.getBoundingClientRect = (() => ({
        x: 0, y: 0, width: 100, height: 20, top: 0, right: 100, bottom: 20, left: 0,
        toJSON: () => ({}),
      } as DOMRect));
      const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
        data: { type: 'readable-edit-mode', enabled: true, documentEpoch: 'epoch-unsafe' },
      }));
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
        data: {
          type: 'readable-edit-duplicate-create',
          documentEpoch: 'epoch-unsafe',
          transactionId: `duplicate-${testCase.name}`,
          sequence: 1,
          originalId: 'original',
          duplicateRootId: 'original-copy',
          previewHtml: testCase.previewHtml,
          baselineTranslate: '',
        },
      }));
      expect(dom.window.document.querySelector('[data-readable-id="original-copy"]')).toBeNull();
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'readable-edit-duplicate-preview',
        ok: false,
      }), '*');
      dom.window.close();
    }
  });

  it('rejects stale epochs and stale command sequences without touching the original', () => {
    const dom = new JSDOM(
      `<main><h1 data-readable-id="original">Original</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    dom.window.HTMLElement.prototype.getBoundingClientRect = (() => ({
      x: 0, y: 0, width: 100, height: 20, top: 0, right: 100, bottom: 20, left: 0,
      toJSON: () => ({}),
    } as DOMRect));
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true, documentEpoch: 'epoch-2' },
    }));
    const create = {
      type: 'readable-edit-duplicate-create', documentEpoch: 'epoch-2', transactionId: 'duplicate-2',
      sequence: 1, originalId: 'original', duplicateRootId: 'original-copy',
      previewHtml: '<h1 data-readable-id="original-copy">Original</h1>', baselineTranslate: '',
    };
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { ...create, documentEpoch: 'old-epoch' },
    }));
    expect(dom.window.document.querySelector('[data-readable-id="original-copy"]')).toBeNull();
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: create }));
    const duplicate = dom.window.document.querySelector('[data-readable-id="original-copy"]') as HTMLElement;
    expect(duplicate).not.toBeNull();
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-duplicate-update', documentEpoch: 'epoch-2', transactionId: 'duplicate-2', sequence: 1, translate: '99px 99px' },
    }));
    expect(duplicate.style.getPropertyValue('translate')).toBe('');
    expect(postMessage.mock.calls.filter(([message]) => (message as { type?: string }).type === 'readable-edit-duplicate-preview')).toHaveLength(1);
    dom.window.close();
  });
});

describe('manual edit bridge rich-text editing', () => {
  function selectContents(window: Window & typeof globalThis, el: Element): void {
    const sel = window.getSelection();
    const range = window.document.createRange();
    range.selectNodeContents(el);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  it('opens text targets in a formatting-capable contenteditable', () => {
    const dom = new JSDOM(
      `<main><h1 data-readable-id="title">Original title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const title = dom.window.document.querySelector('[data-readable-id="title"]') as HTMLElement;

    title.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(title.getAttribute('contenteditable')).toBe('true');

    dom.window.close();
  });

  it('keeps link targets on the plain-text editing path', () => {
    const dom = new JSDOM(
      `<main><a data-readable-id="cta" href="/start">Start</a></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const link = dom.window.document.querySelector('[data-readable-id="cta"]') as HTMLElement;

    link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(link.getAttribute('contenteditable')).toBe('plaintext-only');

    dom.window.close();
  });

  // jsdom does not implement document.execCommand at all (calling it throws
  // "not a function"), so these tests stub it and assert the bridge *routes*
  // Ctrl/Cmd+B/I/U through it rather than doing raw Range surgery. The actual
  // formatting/undo behavior can only be observed in a real browser (see the
  // Playwright verification script referenced in the PR description).
  function stubExecCommand(win: Window & typeof globalThis): ReturnType<typeof vi.fn> {
    const execCommand = vi.fn();
    (win.document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;
    return execCommand;
  }

  it.each([
    ['b', 'bold'],
    ['i', 'italic'],
    ['u', 'underline'],
  ])('routes Ctrl+%s through document.execCommand(%s) for native undo integration', (key, command) => {
    const dom = new JSDOM(
      `<main><p data-readable-id="copy">Hello world</p></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const win = dom.window as unknown as Window & typeof globalThis;
    const copy = dom.window.document.querySelector('[data-readable-id="copy"]') as HTMLElement;
    const execCommand = stubExecCommand(win);

    copy.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    selectContents(win, copy);
    execCommand.mockClear(); // drop the styleWithCSS call fired on session start

    const event = new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key,
      ctrlKey: true,
    });
    copy.dispatchEvent(event);

    expect(execCommand).toHaveBeenCalledWith(command);
    expect(event.defaultPrevented).toBe(true);

    dom.window.close();
  });

  it('enables styleWithCSS-off once per rich edit session so toggles emit tags, not style spans', () => {
    const dom = new JSDOM(
      `<main><p data-readable-id="copy">Hello world</p></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const win = dom.window as unknown as Window & typeof globalThis;
    const copy = dom.window.document.querySelector('[data-readable-id="copy"]') as HTMLElement;
    const execCommand = stubExecCommand(win);

    copy.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(execCommand).toHaveBeenCalledWith('styleWithCSS', false, 'false');
    expect(execCommand).toHaveBeenCalledTimes(1);

    dom.window.close();
  });

  it('does not call execCommand for link (plaintext-only) targets', () => {
    const dom = new JSDOM(
      `<main><a data-readable-id="cta" href="/start">Start</a></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const win = dom.window as unknown as Window & typeof globalThis;
    const link = dom.window.document.querySelector('[data-readable-id="cta"]') as HTMLElement;
    const execCommand = stubExecCommand(win);

    link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(execCommand).not.toHaveBeenCalled();

    dom.window.close();
  });

  function selectTextRange(window: Window & typeof globalThis, node: Node, start: number, end: number): void {
    const sel = window.getSelection();
    const range = window.document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  it('preserves a drag selection when entering rich-text edit mode', () => {
    const dom = new JSDOM(
      `<main><p data-readable-id="copy">Hello world</p></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const win = dom.window as unknown as Window & typeof globalThis;
    const copy = dom.window.document.querySelector('[data-readable-id="copy"]') as HTMLElement;
    const textNode = copy.firstChild!; // Text "Hello world"

    selectTextRange(win, textNode, 0, 5); // "Hello"
    copy.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    const selection = win.getSelection();
    expect(copy.getAttribute('contenteditable')).toBe('true');
    expect(selection?.toString()).toBe('Hello');
    expect(selection?.getRangeAt(0).collapsed).toBe(false);

    dom.window.close();
  });

  it('uses the source-mapped ancestor when a drag selection ends on an inline child', () => {
    const dom = new JSDOM(
      `<main><p data-readable-id="copy"><span data-readable-source-path="path-0-0">Hello</span> <span data-readable-source-path="path-0-1">world</span></p></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const win = dom.window as unknown as Window & typeof globalThis;
    const copy = dom.window.document.querySelector('[data-readable-id="copy"]') as HTMLElement;
    const spans = copy.querySelectorAll('span');
    const firstText = spans[0]!.firstChild!;
    const secondText = spans[1]!.firstChild!;

    selectTextRange(win, firstText, 0, 5);
    const range = win.getSelection()!.getRangeAt(0);
    range.setEnd(secondText, 5);
    spans[1]!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    const selection = win.getSelection();
    expect(copy.getAttribute('contenteditable')).toBe('true');
    expect(spans[1]!.hasAttribute('contenteditable')).toBe(false);
    expect(selection?.toString()).toBe('Hello world');
    expect(selection?.getRangeAt(0).collapsed).toBe(false);

    dom.window.close();
  });

  it('selects a semantic SVG root instead of its structural parent and keeps decorative SVG icons on their button', async () => {
    const dom = new JSDOM(
      `<main>
        <div data-readable-id="card" data-readable-edit="container">
          <svg data-readable-source-path="path-0-0-0" role="img" aria-label="Diagram">
            <text>Diagram label</text>
          </svg>
          <svg data-readable-source-path="hidden-attribute" role="img" aria-label="Hidden attribute" hidden><rect width="10" height="10"></rect></svg>
          <svg data-readable-source-path="hidden-display" role="img" aria-label="Hidden display" style="display:none"><rect width="10" height="10"></rect></svg>
          <svg data-readable-source-path="hidden-visibility" role="img" aria-label="Hidden visibility" style="visibility:hidden"><rect width="10" height="10"></rect></svg>
          <div aria-hidden="true"><svg data-readable-source-path="hidden-ancestor" role="img" aria-label="Hidden ancestor"><rect width="10" height="10"></rect></svg></div>
        </div>
        <button data-readable-id="save"><svg viewBox="0 0 1 1" aria-hidden="true"><path d="M0 0h1v1z"></path></svg>Save</button>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const card = dom.window.document.querySelector('[data-readable-id="card"]') as HTMLElement;
    const diagram = dom.window.document.querySelector('svg[role="img"]') as SVGSVGElement;
    const diagramText = diagram.querySelector('text') as SVGTextElement;
    const icon = dom.window.document.querySelector('path') as SVGPathElement;
    diagram.getBoundingClientRect = () => ({
      x: 10, y: 20, width: 100, height: 40,
      top: 20, right: 110, bottom: 60, left: 10,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(dom.window.document, 'elementsFromPoint', {
      configurable: true,
      value: () => [diagramText, diagram, card],
    });
    Object.defineProperty(dom.window.document, 'elementFromPoint', {
      configurable: true,
      value: () => diagramText,
    });
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true },
    }));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    const targetsMessage = postMessage.mock.calls
      .map(([message]) => message as { type?: string; targets?: Array<{ id: string; kind: string; tagName: string }> })
      .find((message) => message.type === 'readable-edit-targets');
    expect(targetsMessage?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'path-0-0-0', kind: 'container', tagName: 'svg' }),
    ]));
    expect(targetsMessage?.targets?.some((target) => target.tagName === 'svg' && target.id !== 'path-0-0-0')).toBe(false);
    expect(targetsMessage?.targets?.some((target) => ['hidden-attribute', 'hidden-display', 'hidden-visibility', 'hidden-ancestor'].includes(target.id))).toBe(false);

    diagramText.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 20 }));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'readable-edit-select',
        target: expect.objectContaining({ id: 'path-0-0-0', kind: 'container', tagName: 'svg', label: 'Diagram' }),
      }),
      '*',
    );
    expect(diagram.getAttribute('data-readable-edit-selected')).toBe('true');
    expect(diagram.hasAttribute('contenteditable')).toBe(false);

    const save = dom.window.document.querySelector('[data-readable-id="save"]') as HTMLButtonElement;
    Object.defineProperty(dom.window.document, 'elementsFromPoint', {
      configurable: true,
      value: () => [icon, save],
    });
    icon.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'readable-edit-select', target: expect.objectContaining({ id: 'save' }) }),
      '*',
    );

    dom.window.close();
  });

  it('keeps an explicitly identified inline child owned by its text passage', () => {
    const dom = new JSDOM(
      `<main><p data-readable-id="copy">Hello <span data-readable-id="emphasis">world</span></p></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const paragraph = dom.window.document.querySelector('[data-readable-id="copy"]') as HTMLElement;
    const emphasis = dom.window.document.querySelector('[data-readable-id="emphasis"]') as HTMLElement;
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    emphasis.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'readable-edit-select', target: expect.objectContaining({ id: 'copy' }) }),
      '*',
    );
    expect(paragraph.getAttribute('data-readable-editing')).toBe('true');
    expect(emphasis.hasAttribute('data-readable-edit-selected')).toBe(false);
    dom.window.close();
  });

  it('selects titled and aria-labelledby SVG roots when their children are clicked', async () => {
    const dom = new JSDOM(
      `<main>
        <div data-readable-id="card">
          <svg data-readable-source-path="path-0-0-0"><title>Chart</title><path d="M0 0h1v1z"></path></svg>
          <svg data-readable-source-path="path-0-0-1" aria-labelledby="chart-label"><path d="M0 0h1v1z"></path></svg>
          <span id="chart-label">Accessible chart</span>
        </div>
      </main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const roots = Array.from(dom.window.document.querySelectorAll('svg')) as SVGSVGElement[];
    const paths = roots.map((root) => root.querySelector('path') as SVGPathElement);
    roots.forEach((root, index) => {
      root.getBoundingClientRect = () => ({
        x: 10, y: index * 50, width: 100, height: 40,
        top: index * 50, right: 110, bottom: index * 50 + 40, left: 10,
        toJSON: () => ({}),
      } as DOMRect);
    });
    Object.defineProperty(dom.window.document, 'elementsFromPoint', {
      configurable: true,
      value: () => [paths[0], roots[0]],
    });
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true },
    }));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    const targetsMessage = postMessage.mock.calls
      .map(([message]) => message as { type?: string; targets?: Array<{ id: string; kind: string; label?: string }> })
      .find((message) => message.type === 'readable-edit-targets');
    expect(targetsMessage).toBeDefined();
    expect(targetsMessage!.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'path-0-0-0', kind: 'container' }),
      expect.objectContaining({ id: 'path-0-0-1', kind: 'container', label: 'Accessible chart' }),
    ]));

    paths[0]!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'readable-edit-select', target: expect.objectContaining({ id: 'path-0-0-0' }) }),
      '*',
    );

    dom.window.close();
  });

  it('excludes semantic SVG roots under aria-hidden body and html ancestors', async () => {
    const dom = new JSDOM(
      `<main><svg data-readable-source-path="path-0-0-0" role="img" aria-label="Diagram"><path d="M0 0h1v1z"></path></svg></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const diagram = dom.window.document.querySelector('svg[role="img"]') as SVGSVGElement;
    diagram.getBoundingClientRect = () => ({
      x: 10, y: 20, width: 100, height: 40,
      top: 20, right: 110, bottom: 60, left: 10,
      toJSON: () => ({}),
    } as DOMRect);
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    const latestTargets = () => {
      const messages = postMessage.mock.calls
        .map(([message]) => message as { type?: string; targets?: Array<{ id: string }> })
        .filter((message) => message.type === 'readable-edit-targets');
      return messages[messages.length - 1]?.targets || [];
    };

    dom.window.document.body.setAttribute('aria-hidden', 'true');
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true },
    }));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    expect(latestTargets().some((target) => target.id === 'path-0-0-0')).toBe(false);

    dom.window.document.body.removeAttribute('aria-hidden');
    dom.window.document.documentElement.setAttribute('aria-hidden', 'true');
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'readable-edit-mode', enabled: true },
    }));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    expect(latestTargets().some((target) => target.id === 'path-0-0-0')).toBe(false);

    dom.window.close();
  });

  it('commits mixed-markup paragraph edits as inner html', () => {
    const dom = new JSDOM(
      `<main><p data-readable-id="nested"><strong>Nested</strong> copy</p></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const nested = dom.window.document.querySelector('[data-readable-id="nested"]') as HTMLElement;
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    nested.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(nested.getAttribute('contenteditable')).toBe('true');

    nested.innerHTML = '<strong>Nested</strong> revised copy';
    nested.dispatchEvent(new dom.window.FocusEvent('blur', { bubbles: false }));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'readable-edit-html-commit',
        id: 'nested',
        html: '<strong>Nested</strong> revised copy',
      }),
      '*',
    );

    dom.window.close();
  });
});

describe('manual edit bridge keyboard forwarding', () => {
  it('forwards an arrow key as a nudge when an object is selected', () => {
    const dom = new JSDOM(
      `<main><img data-readable-id="image" alt="Preview"></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    const image = dom.window.document.querySelector('[data-readable-id="image"]') as HTMLElement;
    image.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    postMessage.mockClear();

    const event = new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowRight',
    });
    dom.window.document.dispatchEvent(event);

    expect(postMessage).toHaveBeenCalledWith({
      type: 'readable-edit-nudge',
      direction: 'right',
      targetId: 'image',
      revision: 0,
    }, '*');
    expect(event.defaultPrevented).toBe(true);

    dom.window.close();
  });

  it('forwards a nudge-commit when the last held arrow key is released', () => {
    const dom = new JSDOM(
      `<main><img data-readable-id="image" alt="Preview"></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    const image = dom.window.document.querySelector('[data-readable-id="image"]') as HTMLElement;
    image.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, key: 'ArrowRight',
    }));
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, key: 'ArrowUp',
    }));
    postMessage.mockClear();

    // Releasing one of two held keys must NOT commit yet.
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keyup', {
      bubbles: true, cancelable: true, key: 'ArrowRight',
    }));
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'readable-edit-nudge-commit' }), '*',
    );

    // Releasing the last held key commits.
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keyup', {
      bubbles: true, cancelable: true, key: 'ArrowUp',
    }));
    expect(postMessage).toHaveBeenCalledWith({
      type: 'readable-edit-nudge-commit',
      targetId: 'image',
      revision: 0,
    }, '*');

    dom.window.close();
  });

  it('leaves arrow keys alone without an object-selected target', () => {
    const dom = new JSDOM(
      `<main><img data-readable-id="image" alt="Preview"></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    const event = new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowRight',
    });

    dom.window.document.dispatchEvent(event);

    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-nudge' }), '*');
    expect(event.defaultPrevented).toBe(false);

    dom.window.close();
  });

  it('does not forward arrow keys when focus is on a blocked target', () => {
    const dom = new JSDOM(
      `<main><img data-readable-id="image" alt="Preview"><input id="f"></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    const image = dom.window.document.querySelector('[data-readable-id="image"]') as HTMLElement;
    image.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    postMessage.mockClear();

    const input = dom.window.document.querySelector('#f') as HTMLElement;
    input.focus();
    const event = new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowRight',
    });
    input.dispatchEvent(event);

    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-nudge' }), '*');
    expect(event.defaultPrevented).toBe(false);

    dom.window.close();
  });

  it('does not forward arrow keys from inside an ARIA widget role', () => {
    const dom = new JSDOM(
      `<main><img data-readable-id="image" alt="Preview"><div role="slider"><span id="thumb"></span></div></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    const image = dom.window.document.querySelector('[data-readable-id="image"]') as HTMLElement;
    image.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    postMessage.mockClear();

    // Dispatch from a descendant of the slider so the role walk must climb.
    const thumb = dom.window.document.querySelector('#thumb') as HTMLElement;
    const event = new dom.window.KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, key: 'ArrowRight',
    });
    thumb.dispatchEvent(event);

    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-nudge' }), '*');
    expect(event.defaultPrevented).toBe(false);

    dom.window.close();
  });

  it('does not forward arrow keys while an IME composition is active', () => {
    const dom = new JSDOM(
      `<main><img data-readable-id="image" alt="Preview"></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    const image = dom.window.document.querySelector('[data-readable-id="image"]') as HTMLElement;
    image.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    postMessage.mockClear();

    const event = new dom.window.KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, key: 'ArrowRight', isComposing: true,
    });
    dom.window.document.dispatchEvent(event);

    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-nudge' }), '*');
    expect(event.defaultPrevented).toBe(false);

    dom.window.close();
  });

  it('forwards Escape as a burst-cancel while a nudge burst is held', () => {
    const dom = new JSDOM(
      `<main><img data-readable-id="image" alt="Preview"></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    const image = dom.window.document.querySelector('[data-readable-id="image"]') as HTMLElement;
    image.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    postMessage.mockClear();

    // Escape only owns the key while a burst is physically held.
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, key: 'ArrowRight',
    }));
    postMessage.mockClear();

    const event = new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape',
    });
    dom.window.document.dispatchEvent(event);

    expect(postMessage).toHaveBeenCalledWith({ type: 'readable-edit-burst-cancel' }, '*');
    expect(event.defaultPrevented).toBe(true);

    dom.window.close();
  });

  it('leaves Escape untouched when no nudge burst is held', () => {
    const dom = new JSDOM(
      `<main><img data-readable-id="image" alt="Preview"></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    const image = dom.window.document.querySelector('[data-readable-id="image"]') as HTMLElement;
    image.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    postMessage.mockClear();

    const event = new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape',
    });
    dom.window.document.dispatchEvent(event);

    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-burst-cancel' }), '*');
    expect(event.defaultPrevented).toBe(false);

    dom.window.close();
  });

  it('latches held arrow repeats after Escape until the held key is released', () => {
    const dom = new JSDOM(
      `<main><img data-readable-id="image" alt="Preview"></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    const image = dom.window.document.querySelector('[data-readable-id="image"]') as HTMLElement;
    image.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    postMessage.mockClear();

    const keyDown = (key: string) => {
      const event = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key });
      dom.window.document.dispatchEvent(event);
      return event;
    };

    keyDown('ArrowRight');
    keyDown('Escape'); // cancels the held burst and latches the held key
    expect(postMessage).toHaveBeenCalledWith({ type: 'readable-edit-burst-cancel' }, '*');
    postMessage.mockClear();

    // Repeats of the still-held key are swallowed (no nudge, no commit) but
    // stay consumed so artifact/deck handlers never see a half-owned key.
    const repeat = keyDown('ArrowRight');
    keyDown('ArrowRight');
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-nudge' }), '*');
    expect(repeat.defaultPrevented).toBe(true);

    // Releasing the latched key ends the latch without committing anything.
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keyup', {
      bubbles: true, cancelable: true, key: 'ArrowRight',
    }));
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-nudge-commit' }), '*');

    // A genuinely fresh press after the release nudges normally.
    keyDown('ArrowRight');
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-nudge' }), '*');

    dom.window.close();
  });

  it('posts nudge-commit on window blur while arrow keys are held', () => {
    const dom = new JSDOM(
      `<main><img data-readable-id="image" alt="Preview"></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    const image = dom.window.document.querySelector('[data-readable-id="image"]') as HTMLElement;
    image.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    postMessage.mockClear();

    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, key: 'ArrowRight',
    }));
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, key: 'ArrowUp',
    }));

    dom.window.dispatchEvent(new dom.window.Event('blur'));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'readable-edit-nudge-commit',
      targetId: 'image',
    }), '*');
    const commitsAfterBlur = postMessage.mock.calls.filter(([m]) => (m as { type?: string }).type === 'readable-edit-nudge-commit');
    expect(commitsAfterBlur).toHaveLength(1);

    // The late keyup after the blur-finalized burst does nothing.
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keyup', {
      bubbles: true, cancelable: true, key: 'ArrowRight',
    }));
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keyup', {
      bubbles: true, cancelable: true, key: 'ArrowUp',
    }));
    const commits = postMessage.mock.calls.filter(([m]) => (m as { type?: string }).type === 'readable-edit-nudge-commit');
    expect(commits).toHaveLength(1);

    dom.window.close();
  });

  it('posts nudge-commit on visibility loss while arrow keys are held', () => {
    const dom = new JSDOM(
      `<main><img data-readable-id="image" alt="Preview"></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    const image = dom.window.document.querySelector('[data-readable-id="image"]') as HTMLElement;
    image.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    postMessage.mockClear();

    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, key: 'ArrowLeft',
    }));

    Object.defineProperty(dom.window.document, 'visibilityState', { value: 'hidden', configurable: true });
    dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'readable-edit-nudge-commit',
      targetId: 'image',
    }), '*');

    dom.window.close();
  });

  it('ignores arrow keys dispatched while the deck synthetic flag is set', () => {
    const dom = new JSDOM(
      `<main><img data-readable-id="image" alt="Preview"></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    const image = dom.window.document.querySelector('[data-readable-id="image"]') as HTMLElement;
    image.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    postMessage.mockClear();

    (dom.window as unknown as { __readableStudioDeckSynthetic?: boolean }).__readableStudioDeckSynthetic = true;
    const synthetic = new dom.window.KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, key: 'ArrowRight',
    });
    dom.window.document.dispatchEvent(synthetic);
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-nudge' }), '*');
    expect(synthetic.defaultPrevented).toBe(false);

    // Synthetic keyups are not forwarded to the host either.
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keyup', {
      bubbles: true, cancelable: true, key: 'ArrowRight',
    }));
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-nudge-keyup' }), '*');

    // Once the flag clears, real keys nudge again.
    (dom.window as unknown as { __readableStudioDeckSynthetic?: boolean }).__readableStudioDeckSynthetic = false;
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, key: 'ArrowRight',
    }));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-nudge' }), '*');

    dom.window.close();
  });

  it('forwards unowned arrow keyups so a host-origin burst can end across the iframe boundary', () => {
    const dom = new JSDOM(
      `<main><img data-readable-id="image" alt="Preview"></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    const image = dom.window.document.querySelector('[data-readable-id="image"]') as HTMLElement;
    image.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    postMessage.mockClear();

    // A keyup the bridge never tracked (the keydown happened on the host side)
    // is forwarded with target + revision identity; no preventDefault on keyup.
    const keyup = new dom.window.KeyboardEvent('keyup', {
      bubbles: true, cancelable: true, key: 'ArrowRight',
    });
    dom.window.document.dispatchEvent(keyup);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'readable-edit-nudge-keyup',
      key: 'ArrowRight',
      targetId: 'image',
    }), '*');
    expect(keyup.defaultPrevented).toBe(false);

    dom.window.close();
  });

  it('does not forward a keyup for a bridge-tracked key as nudge-keyup', () => {
    const dom = new JSDOM(
      `<main><img data-readable-id="image" alt="Preview"></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    const image = dom.window.document.querySelector('[data-readable-id="image"]') as HTMLElement;
    image.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    postMessage.mockClear();

    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, key: 'ArrowRight',
    }));
    postMessage.mockClear();
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keyup', {
      bubbles: true, cancelable: true, key: 'ArrowRight',
    }));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-nudge-commit' }), '*');
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-nudge-keyup' }), '*');

    dom.window.close();
  });

  it('does not forward Escape as a burst-cancel while inline editing', () => {
    const dom = new JSDOM(
      `<main><h1 data-readable-id="title">Title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const title = dom.window.document.querySelector('[data-readable-id="title"]') as HTMLElement;
    title.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(title.getAttribute('data-readable-editing')).toBe('true');

    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    const event = new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape',
    });
    dom.window.document.dispatchEvent(event);

    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-burst-cancel' }), '*');
    expect(event.defaultPrevented).toBe(false);

    dom.window.close();
  });

  it('forwards Ctrl+Z to the host as an undo message when no inline edit session is active', () => {
    const dom = new JSDOM(
      `<main><h1 data-readable-id="title">Title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    const event = new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'z',
      ctrlKey: true,
    });
    dom.window.document.dispatchEvent(event);

    expect(postMessage).toHaveBeenCalledWith({ type: 'readable-edit-undo', redo: false }, '*');
    expect(event.defaultPrevented).toBe(true);

    dom.window.close();
  });

  it('forwards Shift+Ctrl+Z and Ctrl+Y as redo', () => {
    const dom = new JSDOM(
      `<main><h1 data-readable-id="title">Title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'z',
      ctrlKey: true,
      shiftKey: true,
    }));
    expect(postMessage).toHaveBeenCalledWith({ type: 'readable-edit-undo', redo: true }, '*');

    postMessage.mockClear();
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'y',
      ctrlKey: true,
    }));
    expect(postMessage).toHaveBeenCalledWith({ type: 'readable-edit-undo', redo: true }, '*');

    dom.window.close();
  });

  it('does not forward undo while an inline edit session is active, leaving native undo in control', () => {
    const dom = new JSDOM(
      `<main><h1 data-readable-id="title">Title</h1></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const title = dom.window.document.querySelector('[data-readable-id="title"]') as HTMLElement;
    title.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(title.getAttribute('data-readable-editing')).toBe('true');

    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');
    const event = new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'z',
      ctrlKey: true,
    });
    dom.window.document.dispatchEvent(event);

    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-undo' }), '*');
    expect(event.defaultPrevented).toBe(false);

    dom.window.close();
  });

  it('does not forward undo keys while edit mode is disabled', () => {
    const dom = new JSDOM(
      `<main><h1 data-readable-id="title">Title</h1></main>${buildManualEditBridge(false)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const postMessage = vi.spyOn(dom.window.parent, 'postMessage');

    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'z',
      ctrlKey: true,
    }));

    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'readable-edit-undo' }), '*');

    dom.window.close();
  });
});

describe('manual edit bridge selection-state + rich-format bridge', () => {
  it('applies a rich-format command to the element currently being edited', async () => {
    const dom = new JSDOM(
      `<main><p data-readable-source-path="path-0-0">Hello world</p></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const p = dom.window.document.querySelector('p')!;
    const execCalls: string[] = [];
    dom.window.document.execCommand = (cmd: string) => { execCalls.push(cmd); return true; };
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'readable-edit-mode', enabled: true } }));
    // Put the element into a rich edit session by clicking it.
    p.getBoundingClientRect = () => ({ x: 0, y: 0, width: 80, height: 20, top: 0, right: 80, bottom: 20, left: 0, toJSON: () => ({}) } as DOMRect);
    p.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => dom.window.setTimeout(r, 0));
    expect(p.getAttribute('data-readable-editing')).toBe('true');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'readable-edit-rich-format', command: 'bold' } }));
    expect(execCalls).toContain('bold');
    dom.window.close();
  });

  it('ignores a rich-format command when no element is being edited', async () => {
    const dom = new JSDOM(
      `<main><p data-readable-source-path="path-0-0">Hi</p></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const execCalls: string[] = [];
    dom.window.document.execCommand = (cmd: string) => { execCalls.push(cmd); return true; };
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'readable-edit-mode', enabled: true } }));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'readable-edit-rich-format', command: 'bold' } }));
    expect(execCalls).toEqual([]);
    dom.window.close();
  });

  it('posts an editing:false selection state on selectionchange when nothing is being edited', async () => {
    const posts: Array<{ type?: string; editing?: boolean }> = [];
    const dom = new JSDOM(
      `<main><p data-readable-source-path="path-0-0">Hi</p></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    dom.window.parent.postMessage = ((m: unknown) => { posts.push(m as { type?: string; editing?: boolean }); }) as typeof dom.window.parent.postMessage;
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'readable-edit-mode', enabled: true } }));
    dom.window.document.dispatchEvent(new dom.window.Event('selectionchange'));
    const state = posts.find((m) => m.type === 'readable-edit-selection-state');
    expect(state).toBeTruthy();
    expect(state?.editing).toBe(false);
    dom.window.close();
  });
});

describe('manual edit bridge ancestry + rect precision', () => {
  it('includes parentId, ancestorIds, and isConnected on discovery targets', async () => {
    const posts: Array<{ type?: string; targets?: Array<Record<string, unknown>> }> = [];
    const dom = new JSDOM(
      `<main data-readable-source-path="path-main"><section data-readable-source-path="path-section"><p data-readable-source-path="path-p">Hi</p></section></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const pEl = dom.window.document.querySelector('[data-readable-source-path="path-p"]') as HTMLElement;
    pEl.getBoundingClientRect = () => ({ x: 10.2, y: 20.4, width: 100, height: 50, top: 20.4, right: 110.2, bottom: 70.4, left: 10.2, toJSON: () => ({}) } as DOMRect);
    dom.window.parent.postMessage = ((m: unknown) => { posts.push(m as { type?: string; targets?: Array<Record<string, unknown>> }); }) as typeof dom.window.parent.postMessage;
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'readable-edit-mode', enabled: true } }));
    await new Promise((resolve) => { dom.window.setTimeout(resolve, 0); });
    const targetsPost = posts.find((m) => m.type === 'readable-edit-targets');
    expect(targetsPost).toBeTruthy();
    const p = targetsPost!.targets!.find((t) => t.id === 'path-p');
    expect(p).toBeTruthy();
    expect(p!.parentId).toBe('path-section');
    expect(p!.ancestorIds).toEqual(['path-section', 'path-main']);
    expect(p!.isConnected).toBe(true);
    dom.window.close();
  });

  it('preserves sub-pixel rect values instead of rounding them', async () => {
    const posts: Array<{ type?: string; targets?: Array<Record<string, unknown>> }> = [];
    const dom = new JSDOM(
      `<main><p data-readable-source-path="path-p">Hi</p></main>${buildManualEditBridge(true)}`,
      { runScripts: 'dangerously', url: 'http://localhost' },
    );
    const pEl = dom.window.document.querySelector('[data-readable-source-path="path-p"]') as HTMLElement;
    pEl.getBoundingClientRect = () => ({ x: 10.2, y: 20.4, width: 100.7, height: 50.3, top: 20.4, right: 110.9, bottom: 70.7, left: 10.2, toJSON: () => ({}) } as DOMRect);
    dom.window.parent.postMessage = ((m: unknown) => { posts.push(m as { type?: string; targets?: Array<Record<string, unknown>> }); }) as typeof dom.window.parent.postMessage;
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'readable-edit-mode', enabled: true } }));
    await new Promise((resolve) => { dom.window.setTimeout(resolve, 0); });
    const targetsPost = posts.find((m) => m.type === 'readable-edit-targets');
    const p = targetsPost!.targets!.find((t) => t.id === 'path-p');
    const rect = p!.rect as { width: number; height: number };
    expect(rect.width).toBe(100.7);
    expect(rect.height).toBe(50.3);
    dom.window.close();
  });
});
