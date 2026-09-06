// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const chatCss = readFileSync(resolve(process.cwd(), 'src/styles/chat.css'), 'utf8');

describe('Composer mention pill spacing', () => {
  it('computes an 8px logical gap from adjacent inline content', () => {
    const rule = /\.composer-inline-mention\s*\{([^}]+)\}/.exec(chatCss)?.[1];
    expect(rule).toBeDefined();

    const style = document.createElement('style');
    style.textContent = `.composer-inline-mention { ${rule ?? ''} }`;
    const pill = document.createElement('span');
    pill.className = 'composer-inline-mention';
    document.head.append(style);
    document.body.append(pill);

    const computed = getComputedStyle(pill);
    const margins = {
      top: computed.marginTop,
      right: computed.marginRight,
      bottom: computed.marginBottom,
      left: computed.marginLeft,
    };
    pill.remove();
    style.remove();

    expect(margins).toEqual({
      top: '0px',
      right: '8px',
      bottom: '0px',
      left: '8px',
    });
  });
});
