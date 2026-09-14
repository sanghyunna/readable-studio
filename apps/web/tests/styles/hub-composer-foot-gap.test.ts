/**
 * Hub composer: the gap between the input area and the attachment-upload
 * control (the "+" trigger in the foot row) was judged too tight in the
 * shipped build. The owner set the new gap to exactly 150% of the measured
 * value.
 *
 * The measured gap is the vertical space between the last typed text line and
 * the foot row's top edge. From the real cascade it is exactly one
 * declaration: the editable's bottom inset. Every other contributor is zero
 * (`.home-hero__prompt-surface` padding-bottom, the card's grid `gap`, the
 * foot's margin-top) or frozen by the send button's position (the foot's own
 * padding-top, border and height), which this change must not move.
 *
 * The assertions therefore read the REAL concatenated stylesheet cascade in
 * jsdom - not a grep of one file - so a later override in any sheet that
 * re-tightens the gap fails here, and they pin the frozen contributors so the
 * 150% cannot be bought by shifting the send button or the card's outer
 * height contract.
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

// Keep the declarations that can move the measured boxes: geometry, borders,
// elevation and every custom property (the gap is token-driven). Paint,
// font-face and keyframes otherwise dominate jsdom's parse time.
function gapStyles(root: postcss.Root): string {
  const relevant = /^(?:--[\w-]+|(?:min-|max-)?(?:width|height|inline-size|block-size)|flex(?:-.+)?|padding(?:-.+)?|margin(?:-.+)?|(?:row-|column-)?gap|border(?:-.+)?|box-shadow|box-sizing|align-items|justify-content|place-content|display|grid-template-rows|all|direction|writing-mode)$/;
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

/**
 * jsdom resolves the cascade but not var(), and cssstyle drops a padding
 * shorthand containing var() entirely. The two inset tokens are resolved from
 * their REAL winning declaration on the composer card (the cascade above),
 * then substituted textually so the shorthand parses and expands.
 */
function substituteTokens(source: string, values: Record<string, string>): string {
  return source.replace(/var\((--[\w-]+)\)/g, (match, token: string) => values[token] ?? match);
}

/** The root declarations of the tokens this fixture needs literally. */
function rootTokenValues(root: postcss.Root, names: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  root.walkRules((rule) => {
    if (rule.selector !== ':root') return;
    rule.walkDecls(/^--/, (declaration) => {
      if (names.includes(declaration.prop) && !(declaration.prop in values)) {
        values[declaration.prop] = declaration.value;
      }
    });
  });
  return values;
}

function fixture() {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div class="home-view home-view--hub">
      <div class="home-hero__input-card" data-testid="hub-composer">
        <div class="home-hero__prompt-surface">
          <div class="home-hero__prompt-editor home-hero__lexical">
            <div class="composer-input-editor">
              <div class="composer-editable" contenteditable="true"></div>
            </div>
          </div>
        </div>
        <div class="home-hero__input-foot">
          <div class="home-hero__foot-left">
            <div class="plus-menu"><button class="icon-btn plus-menu__trigger"></button></div>
          </div>
          <div class="home-hero__foot-right">
            <button class="home-hero__submit"></button>
          </div>
        </div>
      </div>
    </div>
  </body></html>`);
  const document = dom.window.document;
  const computed = (selector: string) => dom.window.getComputedStyle(document.querySelector(selector)!);

  // First pass: resolve the inset tokens through the real cascade.
  const probe = document.createElement('style');
  probe.textContent = gapStyles(postcss.parse(css));
  document.head.append(probe);
  const card = computed('.home-hero__input-card');
  const tokens = {
    '--hub-composer-content-inset-top': card.getPropertyValue('--hub-composer-content-inset-top').trim(),
    '--hub-composer-content-inset-bottom': card.getPropertyValue('--hub-composer-content-inset-bottom').trim(),
  };
  probe.remove();

  // Second pass: the same cascade with the resolved insets substituted, so
  // cssstyle can expand the editable's padding shorthand. `--border-soft`
  // joins them: cssstyle drops a border shorthand containing var(), and the
  // foot's hairline width is part of the frozen contract below.
  const style = document.createElement('style');
  const parsed = postcss.parse(css);
  const substitutions = {
    ...tokens,
    ...rootTokenValues(parsed, ['--border-soft']),
  };
  style.textContent = substituteTokens(gapStyles(parsed), substitutions);
  document.head.append(style);

  return { computed, tokens, close: () => dom.window.close() };
}

/** The gap the owner measured: last text line -> foot row top edge. */
function measuredGap({ computed }: ReturnType<typeof fixture>) {
  const editable = computed('.home-view--hub .home-hero__lexical .composer-editable');
  const surface = computed('.home-view--hub .home-hero__prompt-surface');
  const card = computed('.home-view--hub .home-hero__input-card');
  const foot = computed('.home-view--hub .home-hero__input-foot');
  const px = (value: string) => {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) throw new Error(`Not a length: ${value}`);
    return parsed;
  };
  return {
    editablePaddingBottom: px(editable.paddingBottom),
    surfacePaddingBottom: px(surface.paddingBottom),
    cardRowGap: px(card.getPropertyValue('row-gap') === 'normal' ? '0' : card.getPropertyValue('row-gap')),
    footMarginTop: px(foot.marginTop),
    footBorderTop: px(foot.borderTopWidth),
    footPaddingTop: px(foot.paddingTop),
    footMinHeight: px(foot.minHeight),
    cardMinHeight: px(card.minHeight),
    submitHeight: px(computed('.home-view--hub .home-hero__submit').height),
    triggerHeight: px(computed('.home-view--hub .plus-menu__trigger').height),
  };
}

const { geometry, tokens, close } = (() => {
  const source = fixture();
  try {
    return { geometry: measuredGap(source), tokens: source.tokens, close: source.close };
  } catch (error) {
    source.close();
    throw error;
  }
})();
afterAll(() => close());

describe('Hub composer input-to-attachment gap', () => {
  it('sets the gap to exactly 150% of the measured 10px: 15px', () => {
    // The gap is the sum of the spacing declarations between the last typed
    // line and the foot row's top edge. All contributors except the editable's
    // bottom inset must be zero, so the inset IS the gap.
    expect(geometry.surfacePaddingBottom).toBe(0);
    expect(geometry.cardRowGap).toBe(0);
    expect(geometry.footMarginTop).toBe(0);

    const before = 10;
    const after = geometry.editablePaddingBottom;
    expect(after).toBe(before * 1.5);
    expect(tokens['--hub-composer-content-inset-bottom']).toBe('15px');
    process.stdout.write(`${JSON.stringify({ surface: 'hub composer', gap: 'last text line -> foot row top edge', before, after, ratio: after / before })}\n`);
  });

  it('drives the gap from a token on the composer card, not a magic number', () => {
    expect(tokens['--hub-composer-content-inset-top']).toBe('16px');
    expect(tokens['--hub-composer-content-inset-bottom']).toBe('15px');
  });

  it('does not move the send button or the composer outer height contract', () => {
    // The foot's own geometry is frozen: padding-top, hairline, min-height and
    // the send button's box are exactly what they were before the gap change.
    expect(geometry.footPaddingTop).toBe(3);
    expect(geometry.footBorderTop).toBe(1);
    expect(geometry.footMinHeight).toBe(40);
    expect(geometry.submitHeight).toBe(34);
    expect(geometry.triggerHeight).toBe(30);
    expect(geometry.cardMinHeight).toBe(155);
  });
});
