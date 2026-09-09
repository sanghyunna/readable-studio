import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

// Follow the real layout imports: Home loads after index.css, even when the
// switcher is portaled from the workspace. Do not flatten media conditions.
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

// Project declarations, not selectors: keep every cascade competitor for the
// measured properties, including shorthands/resets and transitive var() values.
// Unrelated paint, icon content and font sources dominate cold jsdom parsing.
const measuredCss = (() => {
  const root = postcss.parse(css);
  const measured = /^(?:(?:min-|max-)?(?:width|height|inline-size|block-size)|flex(?:-.+)?|align-items|place-items|display|padding(?:-.+)?|(?:row-|column-)?gap|font(?:-.+)?|line-height|overflow(?:-.+)?|text-overflow|white-space(?:-.+)?|transform(?:-.+)?|transition(?:-.+)?|position|box-sizing|all|direction|writing-mode)$/;
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
    } else if (measured.test(declaration.prop)) reference(declaration.value);
  });
  // Set iteration visits new dependencies and terminates even for cycles.
  for (const token of tokens) {
    for (const value of definitions.get(token) ?? []) reference(value);
  }
  root.walkDecls((declaration) => {
    if (!measured.test(declaration.prop) && !tokens.has(declaration.prop)) declaration.remove();
  });
  root.walkComments((comment) => { comment.remove(); });
  root.walkRules((rule) => { if (!rule.nodes.length) rule.remove(); });
  return root;
})();

type Motion = 'reduce' | 'no-preference';
type Engagement = 'rest' | 'hover' | 'focus';

function fixture(motion: Motion) {
  const root = measuredCss.clone();
  // jsdom has no media-query or hover engine. Select the requested motion
  // branch and substitute only hover state; its CSSOM resolves the cascade.
  // Other media/container branches are inactive for this base-light fixture.
  root.walkAtRules('media', (rule) => {
    if (rule.params === `(prefers-reduced-motion: ${motion})`) rule.replaceWith(rule.nodes!);
    else rule.remove();
  });
  root.walkAtRules('container', (rule) => { rule.remove(); });
  root.walkRules((rule) => {
    rule.selector = rule.selector.replace(/:hover\b/g, '[data-test-hover]');
  });
  const dom = new JSDOM(`<!doctype html><html><body>
    <div class="app"><div class="split"><div class="split-chat-slot" style="width: 320px"><div class="pane">
      <div class="chat-project-header">
        <button class="chat-project-back"></button>
        <span class="chat-project-header-title"><div class="chat-project-title-line">
          <span class="title editable">An intentionally long project title that must ellipsize</span>
          <span class="meta">artifacts-builder</span>
        </div></span>
        <div class="chat-session-switcher"><button class="chat-session-trigger icon-only"></button></div>
      </div>
    </div></div></div></div>
    ${['home-hero', 'composer'].map((surface) => `
      <div class="inline-switcher__popover inline-switcher__popover--layer inline-switcher__popover--${surface} inline-switcher__popover--model" data-surface="${surface}">
        <div class="inline-switcher__model-list">
          ${['long', 'fitting'].map((label) => `<button class="inline-switcher__model-option" data-label="${label}">
            <span class="inline-switcher__model-option-label" ${label === 'long' ? 'data-overflowing="true"' : ''} style="--inline-switcher-option-reveal: 105px">
              <span class="inline-switcher__model-option-label-text">${label}</span>
            </span>
          </button>`).join('')}
        </div>
      </div>`).join('')}
    </body></html>`);
  const style = dom.window.document.createElement('style');
  style.textContent = root.toString();
  dom.window.document.head.append(style);
  const element = (selector: string) => {
    const el = dom.window.document.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`Missing fixture element: ${selector}`);
    return el;
  };
  const computed = (selector: string) => dom.window.getComputedStyle(element(selector));
  // jsdom does not substitute inherited custom properties in transforms.
  // Resolve the winning value through the actual ancestor chain, then check
  // the exact CSS expression instead of treating any transform as a reveal.
  const resolveVars = (value: string, selector: string): string => value.replace(
    /var\((--[\w-]+)(?:,\s*([^)]*))?\)/g,
    (_, token: string, fallback: string | undefined) => {
      let el: Element | null = element(selector);
      while (el) {
        const inherited = dom.window.getComputedStyle(el).getPropertyValue(token).trim();
        if (inherited) return inherited;
        el = el.parentElement;
      }
      if (fallback !== undefined) return fallback;
      throw new Error(`Unresolved token: ${token}`);
    },
  );
  const engage = (engagement: Engagement) => {
    for (const option of dom.window.document.querySelectorAll<HTMLElement>('.inline-switcher__model-option')) {
      option.blur();
      option.toggleAttribute('data-test-hover', engagement === 'hover');
    }
  };
  return { computed, element, resolveVars, engage, close: () => dom.window.close() };
}

type Fixture = ReturnType<typeof fixture>;

function modelSnapshot({ computed, element, resolveVars, engage }: Fixture, engagement: Engagement) {
  engage(engagement);
  return Object.freeze(['home-hero', 'composer'].map((surface) => Object.freeze({
    labels: Object.freeze(['long', 'fitting'].map((label) => {
      const option = `[data-surface="${surface}"] [data-label="${label}"]`;
      const clip = `${option} .inline-switcher__model-option-label`;
      const text = `${clip} .inline-switcher__model-option-label-text`;
      if (engagement === 'focus') element(option).focus();
      return Object.freeze({
        label,
        transform: resolveVars(computed(text).transform || 'none', text),
        textOverflow: computed(clip).textOverflow,
        transition: computed(text).transition,
      });
    })),
    overflowX: computed(`[data-surface="${surface}"] .inline-switcher__model-list`).overflowX,
    width: resolveVars(computed(`[data-surface="${surface}"]`).width, `[data-surface="${surface}"]`),
  })));
}

function titleSnapshot({ computed, element, engage }: Fixture, width: number) {
  engage('rest');
  element('.split-chat-slot').style.width = `${width}px`;
  // Read property getters now: retaining a CSSStyleDeclaration would defer lazy
  // computation into the test body and keep the mutable DOM alive.
  const header = computed('.chat-project-header');
  const wrapper = computed('.chat-project-header-title');
  const stack = computed('.chat-project-title-line');
  const text = (selector: string) => {
    const style = computed(selector);
    return Object.freeze({
      lineHeight: style.lineHeight, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom,
      textOverflow: style.textOverflow, overflow: style.overflow, whiteSpace: style.whiteSpace,
    });
  };
  return Object.freeze({
    width,
    header: Object.freeze({
      minHeight: header.minHeight, paddingTop: header.paddingTop, paddingBottom: header.paddingBottom,
      height: header.height, position: header.position, alignItems: header.alignItems,
    }),
    wrapper: Object.freeze({ overflow: wrapper.overflow, minWidth: wrapper.minWidth }),
    stack: Object.freeze({
      display: stack.display, flexDirection: stack.flexDirection, alignItems: stack.alignItems,
      minWidth: stack.minWidth, flexShrink: stack.flexShrink, rowGap: stack.rowGap,
    }),
    title: text('.chat-project-title-line .title'),
    meta: text('.chat-project-title-line .meta'),
    icons: Object.freeze(['.chat-project-back', '.chat-session-trigger'].map((selector) => {
      const style = computed(selector);
      return Object.freeze({ width: style.width, height: style.height });
    })),
  });
}

function collect(motion: Motion) {
  const source = fixture(motion);
  try {
    return Object.freeze({
      models: Object.freeze({
        rest: modelSnapshot(source, 'rest'),
        hover: modelSnapshot(source, 'hover'),
        focus: modelSnapshot(source, 'focus'),
      }),
      titles: Object.freeze(motion === 'reduce' ? [320, 430, 600].map((width) => titleSnapshot(source, width)) : []),
    });
  } finally { source.close(); }
}

// Two stylesheet parses, independent of case count/order/filtering. All DOM
// mutations and eager snapshots happen during collection, outside test timers;
// only frozen strings/numbers survive after each motion fixture is disposed.
const snapshots = Object.freeze({ reduce: collect('reduce'), 'no-preference': collect('no-preference') });

describe('model reveal: imported cascade and motion branches', () => {
  it.each([
    ['reduce', 'rest'], ['reduce', 'hover'], ['reduce', 'focus'],
    ['no-preference', 'rest'], ['no-preference', 'hover'], ['no-preference', 'focus'],
  ] as const)('%s / %s reveals exactly the measured overflow, never fitting labels', (motion, engagement) => {
    for (const surface of snapshots[motion].models[engagement]) {
      for (const label of surface.labels) {
        const revealed = label.label === 'long' && engagement !== 'rest';
        expect(label.transform).toBe(revealed ? 'translateX(calc(-1 * 105px))' : 'none');
        expect(label.textOverflow).toBe(revealed ? 'clip' : 'ellipsis');
        if (motion === 'reduce') expect(label.transition).toBe('none');
        else expect(label.transition).toContain('transform');
      }
      expect(surface.overflowX).toBe('clip');
      expect(surface.width).toBe('192px');
    }
  }, 15_000);
});

describe('project title: actual nested title/meta layout', () => {
  it.each(snapshots.reduce.titles.map((snapshot) => [snapshot.width, snapshot] as const))(
    'stacks both lines within the unchanged header at %ipx', (_width, { header, wrapper, stack, title, meta, icons }) => {
      expect.soft(stack.display).toBe('flex');
      expect.soft(stack.flexDirection).toBe('column');
      expect.soft(stack.alignItems).toBe('stretch');
      expect.soft(stack.minWidth).toBe('0px');
      expect.soft(stack.flexShrink).toBe('1');
      const required = parseFloat(title.lineHeight) + parseFloat(title.paddingTop)
        + parseFloat(title.paddingBottom) + parseFloat(meta.lineHeight)
        + (parseFloat(stack.rowGap) || 0);
      expect(header.minHeight).toBe('52px');
      expect(parseFloat(header.minHeight) - parseFloat(header.paddingTop) - parseFloat(header.paddingBottom))
        .toBeGreaterThanOrEqual(required);
      expect(header.height).toBe('auto');
      expect(header.position).toBe('sticky');
      expect(header.alignItems).toBe('center');
      expect(wrapper.overflow).toBe('hidden');
      expect(wrapper.minWidth).toBe('0px');
      for (const text of [title, meta]) {
        expect(text.textOverflow).toBe('ellipsis');
        expect(text.overflow).toBe('hidden');
        expect(text.whiteSpace).toBe('nowrap');
      }
      for (const icon of icons) {
        expect(icon.width).toBe('28px');
        expect(icon.height).toBe('28px');
      }
    },
  );
});
