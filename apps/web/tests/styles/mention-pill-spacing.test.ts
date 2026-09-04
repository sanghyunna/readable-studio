import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatCss = readFileSync(
  new URL('../../src/styles/chat.css', import.meta.url),
  'utf8',
);

describe('Composer mention pill spacing', () => {
  it('keeps a 4px logical gap from adjacent inline content', () => {
    const rule = /\.composer-inline-mention\s*\{([^}]+)\}/.exec(chatCss)?.[1];

    expect(rule).toBeDefined();
    expect(rule).toMatch(/margin-block:\s*0\s*;/);
    expect(rule).toMatch(/margin-inline:\s*4px\s*;/);
  });
});
