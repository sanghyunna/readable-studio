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

// Project declarations, never selectors: every imported rule can still win a
// measured property. Keep shorthands/resets and the transitive var() dependency
// graph, including ALL competing definitions of each token. Unrelated paint,
// font-face and animation declarations otherwise dominate jsdom's parse time.
function geometryStyles(root: postcss.Root): string {
  const geometry = /^(?:(?:min-|max-)?(?:width|height|inline-size|block-size)|flex(?:-.+)?|padding(?:-.+)?|margin(?:-.+)?|(?:row-|column-)?gap|box-sizing|justify-content|place-content|display|all|direction|writing-mode)$/;
  const tokens = new Set<string>();
  const definitions = new Map<string, string[]>();
  const reference = (value: string) => {
    for (const match of value.matchAll(/var\(\s*(--[\w-]+)/g)) tokens.add(match[1]!);
  };
  root.walkDecls((declaration) => {
    if (declaration.prop.startsWith('--')) {
      const values = definitions.get(declaration.prop) ?? [];
      values.push(declaration.value);
      definitions.set(declaration.prop, values);
    } else if (geometry.test(declaration.prop)) reference(declaration.value);
  });
  // Set iteration visits newly discovered dependencies too, and terminates even
  // for cyclic tokens. No mutable cache survives this collection-only function.
  for (const token of tokens) {
    for (const value of definitions.get(token) ?? []) reference(value);
  }
  root.walkDecls((declaration) => {
    if (!geometry.test(declaration.prop) && !tokens.has(declaration.prop)) declaration.remove();
  });
  root.walkComments((comment) => { comment.remove(); });
  root.walkRules((rule) => { if (!rule.nodes.length) rule.remove(); });
  return root.toString();
}

function fixture() {
  // jsdom has no container-query engine. Gate this one inline-size branch on
  // an ancestor attribute with ZERO added specificity. This lets all four
  // snapshots share one parsed stylesheet during collection, while jsdom still
  // resolves every geometry competitor (including order and shorthands).
  const root = postcss.parse(css);
  root.walkAtRules('container', (rule) => {
    if (rule.params === '(max-width: 430px)') {
      rule.walkRules((child) => {
        child.selectors = child.selectors.map((selector) => `:where([data-test-compact]) ${selector}`);
      });
      rule.replaceWith(rule.nodes!);
    } else rule.remove();
  });
  const dom = new JSDOM(`<!doctype html><html><body>
    <div class="app"><div class="split"><div class="split-chat-slot"><div class="pane">
    <div class="chat-composer-slot"><div class="chat-composer-fixed-layer"><div class="composer">
    <div class="composer-shell"><div class="composer-row">
      <button class="icon-btn">+</button><span class="composer-spacer"></span>
      <div class="composer-execution-switcher">
        <div class="inline-switcher inline-switcher--agent"><button class="inline-switcher__chip inline-switcher__chip--agent"></button></div>
        ${['model', 'reasoning'].map((variant) => `<div class="inline-switcher inline-switcher--${variant}">
          <button class="inline-switcher__chip inline-switcher__chip--${variant}" aria-expanded="false">
            <span class="inline-switcher__chip-text"><span class="inline-switcher__chip-model">A very long model or effort label</span></span>
            <svg class="inline-switcher__chip-chevron" width="12"></svg>
          </button></div>`).join('')}
      </div><button class="composer-send"><svg width="13"></svg><span>Send</span></button>
    </div></div></div></div></div></div></div></div></div>
    </body></html>`);
  const style = dom.window.document.createElement('style');
  style.textContent = geometryStyles(root);
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
  const select = (width: number, open?: 'model' | 'reasoning') => {
    // Attribute mutations invalidate jsdom's computed-style cache. No state or
    // CSSOM object escapes collection; tests receive only frozen plain data.
    dom.window.document.documentElement.toggleAttribute('data-test-compact', width <= 430);
    for (const variant of ['model', 'reasoning']) {
      dom.window.document.querySelector(`.inline-switcher__chip--${variant}`)!
        .setAttribute('aria-expanded', String(open === variant));
    }
  };
  return { computed, length, select, close: () => dom.window.close() };
}

type Fixture = ReturnType<typeof fixture>;

function closedGeometry({ computed, length, select }: Fixture, width: number) {
  select(width);
  const controls = Object.freeze(['model', 'reasoning'].map((variant) => {
    const selector = `.inline-switcher--${variant} .inline-switcher__chip-text`;
    const label = computed(selector);
    const mount = computed(`.inline-switcher--${variant}`);
    return Object.freeze({
      labelMaxWidth: length(label.maxWidth, selector),
      labelFlexShrink: label.flexShrink,
      flexShrink: mount.flexShrink,
      minWidth: mount.minWidth,
    });
  }));
  const send = computed('.composer-send');
  const cluster = computed('.composer-execution-switcher');
  const row = width <= 430 ? computed('.composer-row') : undefined;
  return Object.freeze({
    controls,
    send: Object.freeze({
      flexShrink: send.flexShrink,
      minWidth: send.minWidth,
      height: send.height,
      boxSizing: send.boxSizing,
      width: send.width,
      paddingLeft: send.paddingLeft,
      paddingRight: send.paddingRight,
    }),
    cluster: Object.freeze({
      flexShrink: cluster.flexShrink,
      minWidth: cluster.minWidth,
      justifyContent: cluster.justifyContent,
    }),
    sendLabelDisplay: computed('.composer-send span').display,
    row: row && Object.freeze({ marginLeft: row.marginLeft, marginRight: row.marginRight, gap: row.gap }),
    iconWidth: row ? computed('.icon-btn').width : undefined,
  });
}

function openGeometry({ computed, length, select }: Fixture, variant: 'model' | 'reasoning') {
  select(320, variant);
  return Object.freeze({
    width: length(computed(`.inline-switcher__chip--${variant}`).width),
    flexShrink: computed(`.inline-switcher--${variant}`).flexShrink,
    otherFlexShrink: computed(`.inline-switcher--${variant === 'model' ? 'reasoning' : 'model'}`).flexShrink,
  });
}

// Width only selects the container branch in this layout-free fixture:
// 320/430 share one cascade, as do 431/600. Eagerly read every asserted property,
// not merely getComputedStyle(): CSSStyleDeclaration has lazy property getters.
// Dispose of the DOM before registering any test, regardless of filtering/order.
const { closed, opened } = (() => {
  const source = fixture();
  try {
    return Object.freeze({
      closed: Object.freeze({ compact: closedGeometry(source, 320), regular: closedGeometry(source, 431) }),
      opened: Object.freeze({ model: openGeometry(source, 'model'), reasoning: openGeometry(source, 'reasoning') }),
    });
  } finally { source.close(); }
})();

describe('in-flow composer: complete concatenated stylesheet cascade', () => {
  it.each([320, 430, 431, 600])('resolves label caps and reserves Send at container width %ipx', (width) => {
    const { controls, send, cluster, sendLabelDisplay, row, iconWidth } = width <= 430 ? closed.compact : closed.regular;
    for (const control of controls) {
      expect.soft(control.labelMaxWidth).toBe(width <= 430 ? '72px' : '132px');
      expect.soft(control.labelFlexShrink).toBe('1');
      expect.soft(control.flexShrink).toBe('1');
      expect(control.minWidth).toBe('0px');
    }
    expect(send.flexShrink).toBe('0');
    expect.soft(send.minWidth).toBe('0px');
    expect(send.height).toBe('28px');
    expect(send.boxSizing).toBe('border-box');
    expect(cluster.flexShrink).toBe('1');
    expect(cluster.minWidth).toBe('0px');
    expect(cluster.justifyContent).toBe('flex-end');
    if (width <= 430) {
      expect(send.width).toBe('32px');
      expect.soft(send.paddingLeft).toBe('0px');
      expect.soft(send.paddingRight).toBe('0px');
      expect(sendLabelDisplay).toBe('none');
      const rowWidth = width - parseFloat(row!.marginLeft) - parseFloat(row!.marginRight);
      const sendWidth = Math.max(parseFloat(send.width), parseFloat(send.minWidth));
      // The flex row reserves Send before assigning the shrinkable cluster's
      // remaining space. No rendered rectangles are fabricated in jsdom.
      const fixedWidth = parseFloat(iconWidth!) + sendWidth + 3 * parseFloat(row!.gap);
      expect(rowWidth - fixedWidth).toBeGreaterThan(0);
      expect(sendWidth).toBe(32);
    } else {
      expect(send.paddingLeft).toBe('12px');
      expect(sendLabelDisplay).not.toBe('none');
    }
  });

  it.each(['model', 'reasoning'] as const)('preserves the %s open width while the other control yields', (variant) => {
    const geometry = opened[variant];
    expect(geometry.width).toBe(variant === 'model' ? '192px' : '144px');
    expect(geometry.flexShrink).toBe('0');
    expect(geometry.otherFlexShrink).toBe('1');
  });
});
