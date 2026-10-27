// @vitest-environment jsdom

import { expect, it } from 'vitest';
import { applyManualEditPreviewSource } from '../../src/edit-mode/preview-source-sync';

it('does not mutate unrelated preview metadata when committing one text edit', () => {
  const before = '<html><body><main><h1 data-readable-id="title">Original</h1><h2>Keep heading</h2><p>Keep paragraph</p></main></body></html>';
  const after = before.replace('Original', 'Updated');
  const document = new DOMParser().parseFromString(before, 'text/html');
  const main = document.querySelector('main')!;
  const title = document.querySelector('h1')!;
  const heading = document.querySelector('h2')!;
  const paragraph = document.querySelector('p')!;
  main.setAttribute('data-readable-id', 'path-0');
  heading.setAttribute('data-readable-id', 'path-0-1');
  [main, title, heading, paragraph].forEach((node, index) => {
    node.setAttribute('data-readable-source-path', index === 0 ? 'path-0' : `path-0-${index - 1}`);
  });
  const observer = new MutationObserver(() => {});
  observer.observe(document.body, { attributes: true, childList: true, characterData: true, subtree: true });
  try {
    expect(applyManualEditPreviewSource(document, before, after, 'title', 'title', 'main,h1,h2,p', 'main,h1,h2')).toBe(true);
    expect(title.textContent).toBe('Updated');
    const untouched = new Set<Node>([main, heading, paragraph]);
    expect(observer.takeRecords().filter((record) => untouched.has(record.target))).toEqual([]);
  } finally {
    observer.disconnect();
  }
});
