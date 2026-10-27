// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { buildManualEditBridge } from '../../src/edit-mode/bridge';
import { MANUAL_EDIT_RICH_TEXT_FORMAT_CSS } from '../../src/edit-mode/rich-text-formatting';
import { applyManualEditPatch } from '../../src/edit-mode/source-patches';
import { JSDOM } from './bridge-dom';

const source = (css = '') => `<!doctype html><html><head>${css ? `<style>${css}</style>` : ''}</head><body>
  <main style="width:800px;height:600px"><h1 data-readable-id="heading">Unrelated heading</h1>
  <p data-readable-id="copy" style="width:200px;max-width:200px;height:80px">Own-capped paragraph</p></main>
  </body></html>`;

function formatted(html: string): string {
  const result = applyManualEditPatch(html, { kind: 'set-inner-html', id: 'heading',
    html: '<b data-readable-text-format="" style="font-weight:700!important">Unrelated heading</b>' });
  expect(result.ok).toBe(true);
  const style = new DOMParser().parseFromString(result.source, 'text/html').querySelector('style[data-readable-text-format-style="1"]');
  expect(style?.textContent).toBe(MANUAL_EDIT_RICH_TEXT_FORMAT_CSS);
  return result.source;
}

function capProvenance(html: string) {
  const dom = new JSDOM(html.replace('</body>', `${buildManualEditBridge(true)}</body>`), { runScripts: 'dangerously', url: 'http://localhost' });
  const parent = dom.window.document.querySelector<HTMLElement>('main')!;
  const paragraph = dom.window.document.querySelector<HTMLElement>('[data-readable-id="copy"]')!;
  parent.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 800, 600);
  paragraph.getBoundingClientRect = () => new dom.window.DOMRect(0, 200, 200, 80);
  Object.defineProperties(parent, { offsetWidth: { value: 800 }, clientWidth: { value: 800 }, offsetHeight: { value: 600 }, clientHeight: { value: 600 } });
  Object.defineProperties(paragraph, { offsetWidth: { value: 200 }, clientWidth: { value: 200 }, offsetHeight: { value: 80 }, clientHeight: { value: 80 } });
  const post = vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(() => {});
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: {
    type: 'readable-edit-preview-style', id: 'copy', styles: {}, version: 1,
    resize: { axes: ['width'], requested: { width: 240, height: 80 }, includeDetails: true },
  } }));
  const reply = JSON.parse(JSON.stringify(post.mock.calls.at(-1)?.[0]));
  const cause = reply.resize.causes.find((item: { code: string }) => item.code === 'own-max-width');
  expect(cause).toBeDefined();
  expect(cause.declaration).toMatchObject({ property: 'max-width', value: '200px' });
  return cause.declaration;
}

describe('formatting and unrelated capped-width provenance', () => {
  it('establishes complete own-cap provenance before formatting', () => {
    expect(capProvenance(source()).complete).toBe(true);
  });

  it('keeps own-cap provenance complete after canonical formatting of an unrelated sibling', () => {
    expect(capProvenance(formatted(source())).complete).toBe(true);
  });

  it('keeps arbitrary author sizing layers incomplete after formatting', () => {
    expect(capProvenance(formatted(source('@layer authorSizing{[data-readable-id="copy"]{max-width:200px!important}}'))).complete).toBe(false);
  });
});
