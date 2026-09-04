import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const moduleCss = readFileSync(
  new URL('../../src/components/CollapsibleErrorText.module.css', import.meta.url),
  'utf8',
);
const chatCss = readFileSync(new URL('../../src/styles/chat.css', import.meta.url), 'utf8');

function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(moduleCss);
  if (!match) throw new Error(`Missing CSS block for ${selector}`);
  return match[1] ?? '';
}

describe('collapsible error text styles', () => {
  it('animates only composited accordion properties with the product easing token', () => {
    const collapsed = block('.body');
    const expanded = block(".body[data-expanded='true']");

    expect(collapsed).toContain('grid-template-rows: 0fr');
    expect(expanded).toContain('grid-template-rows: 1fr');
    // Enter 200ms / exit 140ms on the shared ease-out token.
    expect(collapsed).toContain('140ms var(--ease-out)');
    expect(expanded).toContain('200ms var(--ease-out)');
    expect(moduleCss).not.toMatch(/ease-in\b(?!-out)/);
  });

  it('snaps instead of animating under prefers-reduced-motion', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(moduleCss);
    expect(reduced).not.toBeNull();
    expect(reduced![1]).toContain('transition: none');
    expect(reduced![1]).toContain('.body');
  });

  it('keeps the expanded text selectable and gives the toggle a visible focus ring', () => {
    expect(block('.full')).toContain('user-select: text');
    expect(block('.toggle:focus-visible')).toContain('outline: 2px solid var(--accent)');
  });

  it('uses design tokens only — no color literals', () => {
    const colorLiteral = /(#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\()/i;
    expect(colorLiteral.test(moduleCss)).toBe(false);
  });

  it('top-aligns the run-failure card actions only while the error is expanded', () => {
    const match = /\.msg\.error:has\(\.chat-error-text button\[aria-expanded='true'\]\)\s*\{([^}]*)\}/
      .exec(chatCss);
    expect(match).not.toBeNull();
    expect(match![1]).toContain('align-items: flex-start');
    // The base card keeps its centered single-line layout for short errors.
    expect(/\.msg\.error\s*\{[^}]*align-items: center/.test(chatCss)).toBe(true);
  });
});
