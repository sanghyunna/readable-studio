// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { loadBindings, transform } from 'next/dist/build/swc';
import { beforeAll, expect, it, vi } from 'vitest';
import { JSDOM } from './bridge-dom';
import { MANUAL_EDIT_RICH_TEXT_FORMAT_CSS } from '../../src/edit-mode/rich-text-formatting';

beforeAll(async () => { await loadBindings(); });

async function minifiedFunction(file: string, name: string): Promise<string> {
  const compiled = await transform(readFileSync(new URL(`../../src/edit-mode/${file}`, import.meta.url), 'utf8'), {
    filename: file,
    jsc: { parser: { syntax: 'typescript' }, target: 'es2022', minify: { compress: true, mangle: true } },
    module: { type: 'commonjs' },
    minify: true,
  });
  const exports: Record<string, unknown> = {};
  runInNewContext(compiled.code, { exports });
  const fn = exports[name];
  if (typeof fn !== 'function') throw new Error(`Missing compiled export ${name}`);
  return fn.toString();
}

it('replays canonical source after real Next SWC minification and isolated iframe serialization', async () => {
  const serialized = await minifiedFunction('preview-source-sync.ts', 'applyManualEditPreviewSource');
  const before = '<html><body><p data-readable-id="title">Original</p><p data-readable-id="other">Keep</p></body></html>';
  const after = before.replace('Original', 'Updated');
  const dom = new JSDOM(before, { runScripts: 'dangerously', url: 'http://localhost' });
  await dom.loaded;
  const other = dom.window.document.querySelector('[data-readable-id="other"]');
  const result: unknown = dom.window.eval(`(${serialized})(document, ${JSON.stringify(before)}, ${JSON.stringify(after)}, 'title', 'title', 'p', 'p')`);
  expect(result).toBe(true);
  expect(dom.window.document.querySelector('[data-readable-id="title"]')?.textContent).toBe('Updated');
  expect(dom.window.document.querySelector('[data-readable-id="other"]')).toBe(other);
});

it('runs the full rich-format branch after real Next SWC minification and isolated iframe serialization', async () => {
  const serialized = await minifiedFunction('rich-text-formatting.ts', 'createManualEditRichTextFormatter');
  // JSDOM cannot parse cascade layers; native browser QA checks their effect.
  const dom = new JSDOM('<html><head><style type="text/plain" data-readable-text-format-style="1"></style></head><body><p contenteditable="true"><strong style="font-size: 12px">Word</strong></p></body></html>', {
    runScripts: 'dangerously', url: 'http://localhost',
  });
  await dom.loaded;
  const doc = dom.window.document;
  const root = doc.querySelector('p')!;
  const range = doc.createRange();
  range.selectNodeContents(root);
  dom.window.getSelection()!.addRange(range);
  Object.defineProperty(doc, 'queryCommandState', { configurable: true, value: () => false });
  const insert = vi.fn((command: string, _showUi: boolean, html: string) => {
    expect(command).toBe('insertHTML');
    root.innerHTML = html;
    return true;
  });
  Object.defineProperty(doc, 'execCommand', { configurable: true, value: insert });
  const formatter = dom.window.eval(`(${serialized})(document, document.querySelector('p'), ${JSON.stringify(MANUAL_EDIT_RICH_TEXT_FORMAT_CSS)})`) as {
    format(command: string): boolean;
    dispose(): void;
  };
  expect(formatter.format('bold')).toBe(true);
  expect(insert).toHaveBeenCalledOnce();
  expect(root.querySelector('strong')?.style.fontSize).toBe('12px');
  expect(root.querySelector('span')?.hasAttribute('data-readable-text-format')).toBe(true);
  expect(root.querySelector('span')?.style.getPropertyValue('font-weight')).toBe('700');
  expect(root.querySelector('span')?.style.getPropertyPriority('font-weight')).toBe('important');
  expect(doc.querySelector('style[data-readable-text-format-style="1"]')?.textContent).toBe(MANUAL_EDIT_RICH_TEXT_FORMAT_CSS);
  expect(dom.window.getSelection()?.toString()).toBe('Word');
  formatter.dispose();
  expect(formatter.format('bold')).toBe(false);
});
