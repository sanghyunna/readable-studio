/**
 * The rail's bottom-left profile row (`.hub__user-row`) is presentational
 * identity only - it is a plain <div> with no click handler (see
 * HubRailFooter.tsx) - so it must show NO hover reaction at all: no background
 * change, no border, no elevation, no cursor change, no transform. The
 * affordance was removed from the stylesheet rather than muted.
 *
 * The neighbouring rail rows that ARE clickable (`.hub__dest-more`, the
 * library trigger, and `.hub__dest`, the settings gear) keep their hover
 * exactly as-is.
 *
 * jsdom cannot match :hover, so the real concatenated cascade is rewritten
 * with :hover swapped for a probe class - same declarations - and the computed
 * style is compared with and without the probe. A grep for the selector would
 * pass while a hover rule still painted.
 *
 * The probe swap changes specificity (a class beats :hover's pseudo-class in
 * nwsapi's count), so the sibling assertions do NOT trust the probe's winning
 * declaration: they read the authored :hover rules from the real cascade with
 * postcss instead, which preserves the true selector semantics.
 *
 * No environment pragma on purpose: under the jsdom environment
 * import.meta.url is not a file: URL, so this file creates its own JSDOM
 * instance instead.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import postcss from 'postcss';
import { afterAll, describe, expect, it } from 'vitest';

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

// Keep the declarations a hover reaction could touch; drop the rest so jsdom's
// parse stays fast. Custom properties stay: hover states are token-driven.
function hoverStyles(root: postcss.Root): string {
  const relevant = /^(?:--[\w-]+|background(?:-.+)?|border(?:-.+)?|box-shadow|outline(?:-.+)?|cursor|transform(?:-.+)?|transition(?:-.+)?|opacity|color|-webkit-backdrop-filter|backdrop-filter|filter|display|(?:min-|max-)?(?:width|height)|padding(?:-.+)?|margin(?:-.+)?|gap|align-items|justify-content|box-sizing|font(?:-.+)?|text-align)$/;
  root.walkDecls((declaration) => {
    if (!relevant.test(declaration.prop)) declaration.remove();
  });
  root.walkAtRules((rule) => {
    if (rule.name === 'font-face' || rule.name === 'keyframes') rule.remove();
  });
  root.walkComments((comment) => { comment.remove(); });
  root.walkRules((rule) => { if (!rule.nodes?.length) rule.remove(); });
  return root.toString();
}

const PROBE = 'probe-hover';

/** Swap :hover for a probe class so jsdom can apply the hover cascade. */
function probeHover(root: postcss.Root): void {
  root.walkRules((rule) => {
    if (rule.selector.includes(':hover')) {
      rule.selectors = rule.selectors.map((selector) => selector.replaceAll(':hover', `.${PROBE}`));
    }
  });
}

const HOVER_PROPS = [
  'background',
  'background-color',
  'background-image',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-color',
  'box-shadow',
  'outline-width',
  'cursor',
  'transform',
  'opacity',
  'color',
  'backdrop-filter',
  'filter',
] as const;

function snapshot(style: CSSStyleDeclaration) {
  return Object.fromEntries(HOVER_PROPS.map((prop) => [prop, style.getPropertyValue(prop)]));
}

function fixture() {
  const root = postcss.parse(css);
  probeHover(root);
  const dom = new JSDOM(`<!doctype html><html><body>
    <nav class="hub__nav" data-project-rail="hub" data-project-rail-state="expanded">
      <div class="hub__foot">
        <div class="hub__dest-row">
          <div class="hub__menu-anchor">
            <button type="button" class="hub__dest-more"></button>
          </div>
          <button type="button" class="hub__dest"></button>
        </div>
        <div class="hub__user-row">
          <span class="hub__user-avatar"></span>
          <span class="hub__user-meta"></span>
        </div>
      </div>
    </nav>
  </body></html>`);
  const document = dom.window.document;
  const style = document.createElement('style');
  style.textContent = hoverStyles(root);
  document.head.append(style);
  const computed = (selector: string) => dom.window.getComputedStyle(document.querySelector(selector)!);
  const probe = (selector: string, on: boolean) => {
    document.querySelector(selector)!.classList.toggle(PROBE, on);
  };
  return { computed, probe, close: () => dom.window.close() };
}

const { computed, probe, close } = fixture();
afterAll(() => close());

describe('rail profile row has no hover affordance', () => {
  it('computes identically with and without the hover probe on every reaction channel', () => {
    const rest = snapshot(computed('.hub__user-row'));
    probe('.hub__user-row', true);
    const hovered = snapshot(computed('.hub__user-row'));
    probe('.hub__user-row', false);

    expect(hovered).toEqual(rest);
    // The affordance is removed, not muted: the row keeps its explicit
    // non-interactive cursor and no hover-state rule targets it anywhere in
    // the cascade (pinned by the next test), so nothing can animate in.
    expect(rest['cursor']).toBe('default');
  });

  it('declares no hover, focus or active rule for the profile row anywhere in the cascade', () => {
    const root = postcss.parse(css);
    const offenders: string[] = [];
    root.walkRules((rule) => {
      if (!rule.selector.includes('.hub__user-row')) return;
      if (/:(?:hover|focus|focus-visible|focus-within|active)\b/.test(rule.selector)) {
        offenders.push(rule.selector);
      }
    });
    expect(offenders).toEqual([]);
  });

  it.each(['.hub__dest-more', '.hub__dest'] as const)(
    'keeps the clickable sibling %s hover exactly as-is',
    (selector) => {
      // The sibling still reacts: its authored :hover rules in the real
      // cascade paint the shared hover token and the glass-lift pearl
      // highlight. Postcss, not the probe: the probe's class swap inflates
      // specificity, so only the authored selectors carry the true contract.
      const root = postcss.parse(css);
      const authored: { selector: string; background: string; boxShadow: string }[] = [];
      root.walkRules((rule) => {
        if (!rule.selector.split(',').some((part) => part.trim().startsWith(`${selector}:hover`))) return;
        authored.push({
          selector: rule.selector,
          background: rule.nodes?.find(
            (node): node is postcss.Declaration =>
              node.type === 'decl' && (node.prop === 'background' || node.prop === 'background-color'),
          )?.value ?? '',
          boxShadow: rule.nodes?.find(
            (node): node is postcss.Declaration => node.type === 'decl' && node.prop === 'box-shadow',
          )?.value ?? '',
        });
      });
      expect(authored.length).toBeGreaterThan(0);
      expect(authored.some((rule) => rule.background === 'var(--bg-hover)')).toBe(true);
      expect(authored.some((rule) => rule.boxShadow.includes('var(--hub-pearl-highlight)'))).toBe(true);

      // And the probe confirms the computed style still reacts at all.
      const rest = snapshot(computed(selector));
      probe(selector, true);
      const hovered = snapshot(computed(selector));
      probe(selector, false);
      expect(hovered).not.toEqual(rest);
      expect(rest['cursor']).toBe('pointer');
    },
  );
});
