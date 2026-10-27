// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { buildSrcdoc } from '../../src/runtime/srcdoc';

const disabledType = 'application/x-readable-disabled-script';

describe('host direct-edit bridge ownership', () => {
  it.each([
    'readable-direct-edit.js',
    './assets/readable-direct-edit.js?v=1#bridge',
    '/assets/readable-direct-edit.js',
    'https://assets.example.test/readable-direct-edit.js?v=1',
  ])('makes the known artifact bridge inert without removing its source position: %s', (src) => {
    const source = `<html><body><script src="${src}"></script><p id="copy">Body</p></body></html>`;
    const preview = new DOMParser().parseFromString(buildSrcdoc(source, { editBridge: true }), 'text/html');
    const legacy = preview.querySelector('script[src]');
    expect(legacy?.getAttribute('src')).toBe(src);
    expect(legacy?.getAttribute('type')).toBe(disabledType);
    expect(legacy?.hasAttribute('data-readable-disabled-edit-bridge')).toBe(true);
    expect(preview.body.children[0]).toBe(legacy);
    expect(preview.querySelector('#copy')?.getAttribute('data-readable-source-path')).toBe('path-1');
    expect(preview.querySelectorAll('script[data-readable-edit-bridge]')).toHaveLength(1);
  });

  it('preserves standalone artifact scripts when host direct editing is not requested', () => {
    const source = '<html><body><script type="module" src="readable-direct-edit.js"></script></body></html>';
    const preview = new DOMParser().parseFromString(buildSrcdoc(source), 'text/html');
    const legacy = preview.querySelector('script[src]');
    expect(legacy?.getAttribute('type')).toBe('module');
    expect(legacy?.hasAttribute('data-readable-disabled-edit-bridge')).toBe(false);
  });

  it('preserves unrelated scripts and filenames that only mention the bridge in a query', () => {
    const source = '<html><body><script type="module" src="app.js?asset=/readable-direct-edit.js"></script><script src="readable-direct-edit.js.backup"></script></body></html>';
    const preview = new DOMParser().parseFromString(buildSrcdoc(source, { editBridge: true }), 'text/html');
    const scripts = preview.querySelectorAll('script[src]');
    expect(scripts[0]?.getAttribute('type')).toBe('module');
    expect(scripts[1]?.hasAttribute('type')).toBe(false);
    expect(preview.querySelector('[data-readable-disabled-edit-bridge]')).toBeNull();
  });
});
