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

type Motion = 'reduce' | 'no-preference';
type Engagement = 'rest' | 'hover' | 'focus';

function fixture(motion: Motion, engagement: Engagement = 'rest', width = 320) {
  const root = postcss.parse(css);
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
    <div class="app"><div class="split"><div class="split-chat-slot" style="width: ${width}px"><div class="pane">
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
          ${['long', 'fitting'].map((label) => `<button class="inline-switcher__model-option" data-label="${label}" ${engagement === 'hover' ? 'data-test-hover' : ''}>
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
  return { computed, element, resolveVars, close: () => dom.window.close() };
}

describe('model reveal: imported cascade and motion branches', () => {
  it.each([
    ['reduce', 'rest'], ['reduce', 'hover'], ['reduce', 'focus'],
    ['no-preference', 'rest'], ['no-preference', 'hover'], ['no-preference', 'focus'],
  ] as const)('%s / %s reveals exactly the measured overflow, never fitting labels', (motion, engagement) => {
    const { computed, element, resolveVars, close } = fixture(motion, engagement);
    try {
      for (const surface of ['home-hero', 'composer']) {
        for (const label of ['long', 'fitting']) {
          const option = `[data-surface="${surface}"] [data-label="${label}"]`;
          const clip = `${option} .inline-switcher__model-option-label`;
          const text = `${clip} .inline-switcher__model-option-label-text`;
          if (engagement === 'focus') element(option).focus();
          const revealed = label === 'long' && engagement !== 'rest';
          expect(resolveVars(computed(text).transform || 'none', text))
            .toBe(revealed ? 'translateX(calc(-1 * 105px))' : 'none');
          expect(computed(clip).textOverflow).toBe(revealed ? 'clip' : 'ellipsis');
          if (motion === 'reduce') expect(computed(text).transition).toBe('none');
          else expect(computed(text).transition).toContain('transform');
        }
        expect(computed(`[data-surface="${surface}"] .inline-switcher__model-list`).overflowX).toBe('clip');
        expect(resolveVars(computed(`[data-surface="${surface}"]`).width, `[data-surface="${surface}"]`)).toBe('192px');
      }
    } finally { close(); }
  }, 15_000);
});

describe('project title: actual nested title/meta layout', () => {
  it.each([320, 430, 600])('stacks both lines within the unchanged header at %ipx', (width) => {
    const { computed, close } = fixture('reduce', 'rest', width);
    try {
      const header = computed('.chat-project-header');
      const wrapper = computed('.chat-project-header-title');
      const stack = computed('.chat-project-title-line');
      const title = computed('.chat-project-title-line .title');
      const meta = computed('.chat-project-title-line .meta');
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
      for (const icon of ['.chat-project-back', '.chat-session-trigger']) {
        expect(computed(icon).width).toBe('28px');
        expect(computed(icon).height).toBe('28px');
      }
    } finally { close(); }
  });
});
