import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

// Follow the actual layout's imports, including the home bundle loaded AFTER
// index.css. Reading import edges is not a filesystem discovery sweep.
function expand(url: URL): string {
  const root = postcss.parse(readFileSync(url, 'utf8'), { from: fileURLToPath(url) });
  root.walkAtRules('import', (rule) => {
    const specifier = rule.params.replace(/^['"]|['"]$/g, '');
    const imported = specifier === '@readable-studio/components/styles.css'
      ? new URL('../../../../packages/components/src/styles.css', import.meta.url)
      : specifier.startsWith('.')
        ? new URL(specifier, url)
        : pathToFileURL(createRequire(url).resolve(specifier));
    rule.replaceWith(postcss.parse(expand(imported)));
  });
  return root.toString();
}
const layout = new URL('../../app/layout.tsx', import.meta.url);
const css = [...readFileSync(layout, 'utf8').matchAll(/import ['"]([^'"]+\.css)['"]/g)]
  .map((match) => expand(new URL(match[1]!, layout))).join('\n');

function fixture(width: number, open?: 'model' | 'reasoning') {
  // jsdom has no layout/container-query engine. Evaluate this one inline-size
  // condition explicitly; let its CSS engine resolve the ENTIRE author cascade
  // (specificity, order and shorthands), not hand-picked selectors.
  const root = postcss.parse(css);
  root.walkAtRules('container', (rule) => {
    if (rule.params === '(max-width: 430px)' && width <= 430) rule.replaceWith(rule.nodes!);
    else rule.remove();
  });
  const dom = new JSDOM(`<!doctype html><html><body>
    <div class="app"><div class="split"><div class="split-chat-slot"><div class="pane">
    <div class="chat-composer-slot"><div class="chat-composer-fixed-layer"><div class="composer">
    <div class="composer-shell"><div class="composer-row">
      <button class="icon-btn">+</button><span class="composer-spacer"></span>
      <div class="composer-execution-switcher">
        <div class="inline-switcher inline-switcher--agent"><button class="inline-switcher__chip inline-switcher__chip--agent"></button></div>
        ${['model', 'reasoning'].map((variant) => `<div class="inline-switcher inline-switcher--${variant}">
          <button class="inline-switcher__chip inline-switcher__chip--${variant}" aria-expanded="${open === variant}">
            <span class="inline-switcher__chip-text"><span class="inline-switcher__chip-model">A very long model or effort label</span></span>
            <svg class="inline-switcher__chip-chevron" width="12"></svg>
          </button></div>`).join('')}
      </div><button class="composer-send"><svg width="13"></svg><span>Send</span></button>
    </div></div></div></div></div></div></div></div></div>
    </body></html>`);
  const style = dom.window.document.createElement('style');
  style.textContent = root.toString();
  dom.window.document.head.append(style);
  const computed = (selector: string) => dom.window.getComputedStyle(dom.window.document.querySelector(selector)!);
  // jsdom preserves var() and does not inherit custom properties. Resolve
  // size tokens from the nearest ancestor's winning declaration, including
  // the compact cluster override, rather than reading a token snippet.
  const length = (value: string, selector = 'html') => value.replace(/var\((--[\w-]+)\)/g,
    (_, token: string) => {
      let element = dom.window.document.querySelector(selector);
      while (element) {
        const inherited = dom.window.getComputedStyle(element).getPropertyValue(token).trim();
        if (inherited) return inherited;
        element = element.parentElement;
      }
      throw new Error(`Unresolved size token ${token}`);
    });
  return { computed, length, close: () => dom.window.close() };
}

describe('in-flow composer: complete concatenated stylesheet cascade', () => {
  it.each([320, 430, 431, 600])('resolves label caps and reserves Send at container width %ipx', (width) => {
    const { computed, length, close } = fixture(width);
    try {
      for (const variant of ['model', 'reasoning']) {
        const selector = `.inline-switcher--${variant} .inline-switcher__chip-text`;
        const label = computed(selector);
        expect.soft(length(label.maxWidth, selector)).toBe(width <= 430 ? '72px' : '132px');
        expect.soft(label.flexShrink).toBe('1');
        const mount = computed(`.inline-switcher--${variant}`);
        expect.soft(mount.flexShrink).toBe('1');
        expect(mount.minWidth).toBe('0px');
      }
      const send = computed('.composer-send');
      expect(send.flexShrink).toBe('0');
      expect.soft(send.minWidth).toBe('0px');
      expect(send.height).toBe('28px');
      expect(send.boxSizing).toBe('border-box');
      const cluster = computed('.composer-execution-switcher');
      expect(cluster.flexShrink).toBe('1');
      expect(cluster.minWidth).toBe('0px');
      expect(cluster.justifyContent).toBe('flex-end');
      if (width <= 430) {
        expect(send.width).toBe('32px');
        expect.soft(send.paddingLeft).toBe('0px');
        expect.soft(send.paddingRight).toBe('0px');
        expect(computed('.composer-send span').display).toBe('none');
        const row = computed('.composer-row');
        const rowWidth = width - parseFloat(row.marginLeft) - parseFloat(row.marginRight);
        const sendWidth = Math.max(parseFloat(send.width), parseFloat(send.minWidth));
        // The flex row reserves Send before assigning the shrinkable cluster's
        // remaining space. No rendered rectangles are fabricated in jsdom.
        const fixedWidth = parseFloat(computed('.icon-btn').width) + sendWidth
          + 3 * parseFloat(row.gap);
        expect(rowWidth - fixedWidth).toBeGreaterThan(0);
        expect(sendWidth).toBe(32);
      } else {
        expect(send.paddingLeft).toBe('12px');
        expect(computed('.composer-send span').display).not.toBe('none');
      }
    } finally { close(); }
  });

  it.each(['model', 'reasoning'] as const)('preserves the %s open width while the other control yields', (variant) => {
    const { computed, length, close } = fixture(320, variant);
    try {
      expect(length(computed(`.inline-switcher__chip--${variant}`).width)).toBe(variant === 'model' ? '192px' : '144px');
      expect(computed(`.inline-switcher--${variant}`).flexShrink).toBe('0');
      expect(computed(`.inline-switcher--${variant === 'model' ? 'reasoning' : 'model'}`).flexShrink).toBe('1');
    } finally { close(); }
  });
});
