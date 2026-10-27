// @vitest-environment node
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

import { buildSrcdoc } from '../../src/runtime/srcdoc';

const documents: JSDOM[] = [];
afterEach(() => { for (const dom of documents.splice(0)) dom.window.close(); });

const authorRuntime = `(function(){
  var index = 0;
  function paint(){
    document.querySelectorAll('.slide').forEach(function(slide, i){slide.classList.toggle('active', i === index);});
  }
  function onKey(event){
    if (event.key === 'ArrowRight') index = Math.min(3, index + 1);
    else if (event.key === 'ArrowLeft') index = Math.max(0, index - 1);
    else return;
    window.requestAnimationFrame(paint);
  }
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('keydown', onKey, true);
  window.__authorIndex = function(){return index;};
})();`;

describe('deck navigation uses one event per user action', () => {
  it.each(['inline', 'external'] as const)('preserves a deferred author index without preventDefault (%s runtime)', async (kind) => {
    const authorScript = kind === 'inline'
      ? `<script>${authorRuntime}</script>`
      : `<script src="data:text/javascript,${encodeURIComponent(authorRuntime)}"></script>`;
    const slides = Array.from({ length: 4 }, (_, i) => `<section class="slide${i === 0 ? ' active' : ''}">${i}</section>`).join('');
    const source = `<!doctype html><html><head><style>.slide{display:none}.slide.active{display:block}</style></head><body>${slides}${authorScript}</body></html>`;
    const dom = new JSDOM(buildSrcdoc(source, { deck: true, initialSlideIndex: 2 }), {
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole: new VirtualConsole(),
      url: 'https://example.test/deck.html',
    });
    documents.push(dom);
    const { window } = dom;
    await new Promise<void>(resolve => {
      if (window.document.readyState === 'complete') resolve();
      else window.addEventListener('load', () => resolve(), { once: true });
    });
    await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
    expect(window.eval('window.__authorIndex()')).toBe(2);
    expect(Array.from(window.document.querySelectorAll('.slide')).findIndex(slide => slide.classList.contains('active'))).toBe(2);
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
    expect(window.eval('window.__authorIndex()')).toBe(3);
    expect(Array.from(window.document.querySelectorAll('.slide')).findIndex(slide => slide.classList.contains('active'))).toBe(3);
  });

  it('does not add deck listener wrapping to ordinary non-deck previews', () => {
    expect(buildSrcdoc('<main>Document</main>')).not.toContain('data-readable-standalone-deck-nav-dedupe');
  });
});
