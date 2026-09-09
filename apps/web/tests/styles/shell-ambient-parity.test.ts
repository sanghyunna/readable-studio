// @vitest-environment jsdom

/**
 * Hub <-> workspace ambient-light parity.
 *
 * The two surfaces read as different design languages because their ambient
 * background was composed from different ingredients: the Hub layered three
 * heavily blurred wash blooms (`.hub__wash` + its pseudo-elements, hand-rolled
 * `radial-gradient(circle, var(--hub-wash*), ...)`) over the shell canvas,
 * while the workspace had no wash at all and instead restarted its own
 * six-gradient canvas on `.split` with sharper, differently placed blooms.
 * Swapping surfaces therefore swapped the light itself.
 *
 * The contract pinned here is a shared vocabulary, not shared geometry:
 *
 *  - ONE canvas ingredient (`--hub-canvas-background`) painted by the shell;
 *    no surface may restart its own canvas copy.
 *  - THREE wash ingredients (`--hub-wash-bloom-accent|warm|cool`) declared once
 *    in the theme recipe, and consumed - all three - by a wash carrier on BOTH
 *    surfaces. Carriers may sit anywhere and at any intensity, but every one is
 *    a blurred, non-interactive, pill-shaped light.
 *  - The same fallback on both: reduced transparency hides every carrier.
 *
 * Everything asserted is a machine-consumed token or declaration.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { projectSplitStyle } from '../../src/components/ProjectView';
import { EXPLICIT_THEME_OPTIONS } from '../../src/state/themes';

const styles = resolve(process.cwd(), 'src/styles');
const read = (file: string): string => readFileSync(resolve(styles, file), 'utf8');

const shellCss = read('shell.css');
const hubCss = read('home/hub.css');
const recipesCss = read('themes/recipes.css');
const tokensCss = read('tokens.css');
const routinesCss = read('viewer/routines.css');

const WASH_BLOOMS = ['--hub-wash-bloom-accent', '--hub-wash-bloom-warm', '--hub-wash-bloom-cool'] as const;
const WASH_SOURCES: Record<(typeof WASH_BLOOMS)[number], string> = {
  '--hub-wash-bloom-accent': '--hub-wash',
  '--hub-wash-bloom-warm': '--hub-wash-warm',
  '--hub-wash-bloom-cool': '--hub-wash-cool',
};

/** The wash carriers each surface owns. Geometry is theirs; ingredients are shared. */
const HOME_SHELL = '.workspace-shell:has(> .workspace-shell__body .entry-main__inner--home)';
const HUB_WASH_CARRIERS = [
  `${HOME_SHELL}::before`,
  `${HOME_SHELL} > .workspace-shell__body::before`,
  `${HOME_SHELL}::after`,
] as const;
const WORKSPACE_WASH_CARRIERS = ['.app::before', '.split::after', '.split::before'] as const;

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Drops every `@media` block so a base-cascade lookup cannot read a conditional override. */
function baseCascade(css: string): string {
  const source = stripComments(css);
  let result = '';
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf('@media', index);
    if (start < 0) {
      result += source.slice(index);
      break;
    }
    result += source.slice(index, start);
    let cursor = source.indexOf('{', start) + 1;
    let depth = 1;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === '{') depth += 1;
      if (source[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    index = cursor;
  }
  return result;
}

/** Bodies of every `@media <query>` block, concatenated. */
function mediaBlocks(css: string, query: string): string {
  const source = stripComments(css);
  const needle = `@media ${query}`;
  const bodies: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(needle, cursor);
    if (start < 0) break;
    const open = source.indexOf('{', start);
    let depth = 1;
    let index = open + 1;
    for (; index < source.length && depth > 0; index += 1) {
      if (source[index] === '{') depth += 1;
      if (source[index] === '}') depth -= 1;
    }
    bodies.push(source.slice(open + 1, index - 1));
    cursor = index;
  }
  return bodies.join('\n');
}

/** Concatenated declarations of every rule whose selector list contains `selector` exactly. */
function declarations(css: string, selector: string): string {
  const bodies: string[] = [];
  const rule = /([^{}]+)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rule.exec(css)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((part) => part.trim());
    if (selectors.includes(selector)) bodies.push(match[2] ?? '');
  }
  return bodies.join('\n');
}

function lastValue(block: string, property: string): string | undefined {
  const matches = [...block.matchAll(new RegExp(`(?:^|[;\\n])\\s*${property}\\s*:\\s*([^;]+);`, 'g'))];
  return matches.at(-1)?.[1]?.trim();
}

function customPropertyValue(source: string, token: string): string | undefined {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`^\\s*${escaped}\\s*:\\s*([^;]+);`, 'm'))?.[1]?.trim();
}

/** Every ambient bloom token a set of carriers consumes through `background`. */
function consumedBlooms(css: string, carriers: readonly string[]): Set<string> {
  const consumed = new Set<string>();
  for (const carrier of carriers) {
    const background = lastValue(declarations(css, carrier), 'background') ?? '';
    for (const bloom of WASH_BLOOMS) {
      if (background.includes(`var(${bloom})`)) consumed.add(bloom);
    }
  }
  return consumed;
}

describe('shell ambient vocabulary (theme recipe)', () => {
  it('declares the three wash blooms once, in the recipe, for every bundled theme', () => {
    const recipeBlock = /^((?:[^{}]*\n)*?[^{}]*)\{([\s\S]*?)\n\}/m.exec(stripComments(recipesCss).trimStart());
    expect(recipeBlock, 'recipes.css must open with the shared material block').not.toBeNull();
    const [, selectorText, body] = recipeBlock as RegExpExecArray;

    // One selector list covers :root plus every explicit theme, so a new theme
    // inherits the blooms by adding a palette only.
    expect(selectorText).toContain(':root');
    for (const { id } of EXPLICIT_THEME_OPTIONS) {
      expect(selectorText, `recipe selector list must include ${id}`).toContain(`[data-theme='${id}']`);
    }

    for (const bloom of WASH_BLOOMS) {
      const value = customPropertyValue(body ?? '', bloom);
      expect(value, `${bloom} must be declared in the recipe block`).toBeDefined();
      // A bloom is its wash colour shaped into a soft circular falloff - the
      // colour comes from the theme-aware wash token, never a literal.
      expect(value).toMatch(/^radial-gradient\(circle,/);
      expect(value).toContain(`var(${WASH_SOURCES[bloom] as string})`);
      expect(value).toContain('transparent');
    }
  });

  it('never re-declares a bloom under a surface-scoped selector, so no theme can fork the two surfaces', () => {
    // A declaration of a bloom token anywhere but the recipe would let one
    // surface (for example the `[data-theme="dark"] .hub` override block) light
    // itself differently from the other.
    const declaredOutsideRecipe = [
      ['shell.css', shellCss],
      ['home/hub.css', hubCss],
      ['tokens.css', tokensCss],
      ['home/entry-layout.css', read('home/entry-layout.css')],
      ['home/home-hero.css', read('home/home-hero.css')],
    ]
      .filter(([, css]) => /^\s*--hub-wash-bloom-[a-z]+\s*:/m.test(stripComments(css as string)))
      .map(([file]) => file);
    expect(declaredOutsideRecipe).toEqual([]);

    // The wash colour tokens the blooms are mixed from resolve on the theme
    // root: a surface-scoped literal copy is dead (custom properties substitute
    // where they are declared) and only invites someone to tune a value that
    // no longer paints anything.
    const scopedDark = stripComments(tokensCss).match(
      /\[data-theme="dark"\]\s+\.hub[^{]*\{([\s\S]*?)\n\}/,
    )?.[1] ?? '';
    const scopedSystemDark = stripComments(tokensCss).match(
      /html:not\(\[data-theme\]\)\s+\.hub[^{]*\{([\s\S]*?)\n\}/,
    )?.[1] ?? '';
    expect(scopedDark).not.toBe('');
    expect(scopedSystemDark).not.toBe('');
    for (const scoped of [scopedDark, scopedSystemDark]) {
      for (const source of Object.values(WASH_SOURCES)) {
        expect(customPropertyValue(scoped, source), `${source} must not be re-declared per surface`).toBeUndefined();
      }
    }
  });
});

describe('Hub <-> workspace ambient layer parity', () => {
  it('consumes every wash bloom on BOTH surfaces - a light cannot exist on one and vanish on the other', () => {
    const hub = consumedBlooms(baseCascade(hubCss), HUB_WASH_CARRIERS);
    const workspace = consumedBlooms(baseCascade(shellCss), WORKSPACE_WASH_CARRIERS);

    expect([...hub].sort()).toEqual([...WASH_BLOOMS].sort());
    expect([...workspace].sort()).toEqual([...WASH_BLOOMS].sort());
  });

  it.each([
    ['Hub', hubCss, HUB_WASH_CARRIERS],
    ['workspace', shellCss, WORKSPACE_WASH_CARRIERS],
  ] as const)('gives every %s wash carrier the same light treatment: fixed, blurred, faded, inert, pill-shaped', (_surface, css, carriers) => {
    const base = baseCascade(css);
    for (const carrier of carriers) {
      const block = declarations(base, carrier);
      expect(block, `${carrier} must be declared`).not.toBe('');
      expect(lastValue(block, 'position'), `${carrier} position`).toBe('fixed');
      expect(lastValue(block, 'filter'), `${carrier} filter`).toMatch(/^blur\(\d+px\)$/);
      expect(Number(lastValue(block, 'opacity')), `${carrier} opacity`).toBeGreaterThan(0);
      expect(Number(lastValue(block, 'opacity')), `${carrier} opacity`).toBeLessThan(1);
      expect(lastValue(block, 'pointer-events'), `${carrier} pointer-events`).toBe('none');
      expect(lastValue(block, 'border-radius'), `${carrier} border-radius`).toBe('var(--radius-pill)');
      // Nothing in the base cascade may switch a carrier off; only the
      // reduced-transparency fallback below is allowed to.
      expect(lastValue(block, 'display'), `${carrier} must not be hidden at rest`).not.toBe('none');
    }
    // The pseudo-element carriers need content to exist at all.
    for (const carrier of carriers.filter((selector) => selector.includes('::'))) {
      expect(lastValue(declarations(base, carrier), 'content'), `${carrier} content`).toMatch(/^(''|"")$/);
    }
  });

  it('paints one canvas: the shell owns --hub-canvas-background and no surface restarts its own copy', () => {
    const shell = declarations(baseCascade(shellCss), '.workspace-shell');
    expect(lastValue(shell, 'background')).toBe('var(--hub-canvas-background)');

    // The workspace used to re-roll a private six-gradient canvas here, which
    // is what made its light read as a different composition from the Hub's.
    const split = declarations(baseCascade(shellCss), '.split');
    expect(lastValue(split, 'background')).toBe('transparent');
    expect(split).not.toContain('radial-gradient');
    for (const token of ['--hub-canvas-base', '--hub-canvas-blue', '--hub-canvas-pink', '--hub-canvas-cyan', '--hub-canvas-green']) {
      expect(split).not.toContain(`var(${token})`);
    }
    // The Hub's own roots are already transparent to the shell canvas.
    expect(lastValue(declarations(baseCascade(hubCss), '.hub'), 'background')).toBe('transparent');
    expect(lastValue(declarations(baseCascade(hubCss), '.hub__stage'), 'background')).toBe('transparent');
  });

  it('keeps the workspace root transparent through the real cascade, including the later compiled-routine repaint', () => {
    // `viewer/routines.css` is imported after shell.css and repaints `.app`
    // with an opaque `--bg-panel` at equal specificity. Behind a transparent
    // `.split` that slab would hide the shell canvas, so shell.css has to win
    // the cascade for real - which jsdom resolves - not only in isolation.
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    for (const css of [shellCss, routinesCss]) {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    }
    document.body.innerHTML = `
      <div class="workspace-shell workspace-shell--desktop">
        <div class="workspace-shell__body">
          <div class="entry-shell entry-shell--no-header entry-shell--workspace">
            <div class="entry"><div class="entry-main entry-main--workspace">
              <div class="app" data-testid="project-root"><div class="split"></div></div>
            </div></div>
          </div>
        </div>
      </div>`;
    const app = document.querySelector('.app') as HTMLElement;
    const split = document.querySelector('.split') as HTMLElement;

    expect(getComputedStyle(app).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(split).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    // The negative-z wash carriers need a stacking context on the root they
    // ride on; otherwise they drop beneath the shell canvas and disappear.
    expect(getComputedStyle(app).isolation).toBe('isolate');
  });

  it('resolves the warm carrier inset from the live split width through its own or ancestor scope', () => {
    const base = baseCascade(shellCss);
    const warmCarrier = WORKSPACE_WASH_CARRIERS.find((carrier) =>
      lastValue(declarations(base, carrier), 'background') === 'var(--hub-wash-bloom-warm)',
    );
    expect(warmCarrier).toBeDefined();
    const warm = declarations(base, warmCarrier!);
    const inset = lastValue(warm, 'inset');
    expect(inset).toContain('var(--project-chat-panel-width');

    // ProjectView renders .app > .split and places projectSplitStyle on the
    // split. Use its real initial value, then the same DOM-only property write
    // as pointer resize (which deliberately does not commit React state).
    const app = document.createElement('div');
    app.className = 'app';
    const split = document.createElement('div');
    split.className = 'split';
    app.appendChild(split);
    document.body.appendChild(app);
    const style = document.createElement('style');
    style.textContent = base;
    document.head.appendChild(style);
    const widthToken = '--project-chat-panel-width';
    split.style.setProperty(widthToken, projectSplitStyle(false, 620, 'minmax(400px, 1fr)')![widthToken]);

    // jsdom does not compute pseudo-element styles/custom-property inheritance.
    // Model that rule explicitly: a pseudo inherits from its originating
    // element, then ancestors only; a descendant/sibling is never in scope.
    const inheritedWidth = (element: Element | null): string | undefined => {
      for (let owner = element; owner; owner = owner.parentElement) {
        const value = getComputedStyle(owner).getPropertyValue(widthToken).trim();
        if (value) return value;
      }
      return undefined;
    };
    const origin = app.matches(warmCarrier!.split('::')[0]!)
      ? app
      : app.querySelector(warmCarrier!.split('::')[0]!);
    expect(origin).not.toBeNull();
    const resolvedInset = () => inset!.replace(
      /var\(--project-chat-panel-width(?:,\s*([^)]*))?\)/g,
      (_match, fallback: string | undefined) =>
        lastValue(warm, widthToken) ?? inheritedWidth(origin) ?? fallback ?? '',
    );

    try {
      // Negative control: the old .app::after cannot see a child's width.
      expect(inheritedWidth(app)).toBeUndefined();
      expect(resolvedInset()).toBe('10vh auto auto calc(620px + 24px)');
      for (const width of [345, 720, 460]) {
        split.style.setProperty(widthToken, `${width}px`);
        expect(resolvedInset()).toBe(`10vh auto auto calc(${width}px + 24px)`);
      }
    } finally {
      app.remove();
      style.remove();
    }
  });

  it('applies the same reduced-transparency fallback on both surfaces: every wash carrier is hidden', () => {
    const hubReduced = mediaBlocks(hubCss, '(prefers-reduced-transparency: reduce)');
    const shellReduced = mediaBlocks(shellCss, '(prefers-reduced-transparency: reduce)');

    for (const carrier of HUB_WASH_CARRIERS) {
      expect(lastValue(declarations(hubReduced, carrier), 'display'), carrier).toBe('none');
    }
    for (const carrier of WORKSPACE_WASH_CARRIERS) {
      expect(lastValue(declarations(shellReduced, carrier), 'display'), carrier).toBe('none');
    }
    // ...and the canvas flattens to the same token on the shell and the split.
    expect(lastValue(declarations(hubReduced, '.workspace-shell'), 'background')).toBe('var(--hub-canvas)');
    expect(lastValue(declarations(shellReduced, '.app .split.split'), 'background')).toBe('var(--hub-canvas)');
  });
});
