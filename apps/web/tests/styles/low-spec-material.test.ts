/**
 * Low-spec host material contract (G003, Lane A).
 *
 * `html[data-performance-profile="low"]` must yield zero effective
 * backdrop-filter on every host surface, opaque token-derived fills for the
 * glass tier, and no route blooms - without touching full mode or the
 * independent `prefers-reduced-transparency` fallbacks. The kill rule is one
 * universal `!important` declaration pair, so this test pins the inventory it
 * has to cover: a new base glass surface or a fifth inline `backdropFilter`
 * site fails until its author bumps the pin and confirms readability (M5).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import postcss, { type Container } from 'postcss';
import { describe, expect, it } from 'vitest';

const webRoot = process.cwd();
const srcRoot = resolve(webRoot, 'src');
const LOW = 'html[data-performance-profile="low"]';

function read(relativePath: string): string {
  return readFileSync(resolve(webRoot, relativePath), 'utf8');
}

function sourceFiles(predicate: (relativePath: string) => boolean): string[] {
  return readdirSync(srcRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(webRoot, join(entry.parentPath, entry.name)).replace(/\\/g, '/'))
    .filter(predicate)
    .sort();
}

/** Base (non-`@media`) unprefixed backdrop declarations with an active value. */
function activeBaseBackdropGroups(relativePath: string): string[] {
  const root = postcss.parse(read(relativePath));
  const hits: string[] = [];
  root.walkDecls('backdrop-filter', (decl) => {
    if (decl.value.trim() === 'none') return;
    let parent: Container | undefined = decl.parent;
    while (parent) {
      if (parent.type === 'atrule') return;
      parent = parent.parent as Container | undefined;
    }
    hits.push(`${relativePath}:${decl.source?.start?.line ?? 0}`);
  });
  return hits;
}

const material = read('src/styles/low-spec/material.css');
const materialRoot = postcss.parse(material);

describe('low-spec material: universal backdrop kill (M1)', () => {
  it('authors one prefix-first, !important kill rule under the low attribute for elements and pseudo-elements', () => {
    const rule = materialRoot.nodes.find(
      (node) => node.type === 'rule' && node.selectors.includes(`${LOW} *`),
    );
    expect(rule?.type).toBe('rule');
    if (rule?.type !== 'rule') return;

    expect(rule.selectors).toEqual([`${LOW} *`, `${LOW} *::before`, `${LOW} *::after`]);
    const decls = rule.nodes.filter((node) => node.type === 'decl');
    expect(decls.map((decl) => `${decl.prop}: ${decl.value}${decl.important ? ' !important' : ''}`)).toEqual([
      '-webkit-backdrop-filter: none !important',
      'backdrop-filter: none !important',
    ]);
  });

  // HubPerformanceToggle and its CSS module were removed together in 083ffba.
  // The remaining inventory is 44 global groups plus SettingsDialog.module.
  // Bump this pin only after checking a new surface's low-mode fill is
  // opaque and readable (M5).
  it('covers the measured base inventory: 45 active CSS groups (44 global + 1 CSS module)', () => {
    const globalGroups = sourceFiles(
      (path) => path.startsWith('src/styles/') && path.endsWith('.css') && !path.startsWith('src/styles/low-spec/'),
    ).flatMap(activeBaseBackdropGroups);
    const moduleGroups = sourceFiles(
      (path) => path.startsWith('src/components/') && path.endsWith('.module.css'),
    ).flatMap(activeBaseBackdropGroups);

    expect(moduleGroups).toEqual([
      'src/components/SettingsDialog.module.css:226',
    ]);
    expect(globalGroups).toHaveLength(44);
    expect(globalGroups.length + moduleGroups.length).toBe(45);
  });

  it('pins the inline JSX backdropFilter sites to the four known ones', () => {
    const inline = sourceFiles((path) => path.endsWith('.tsx')).flatMap((path) => {
      const count = read(path).match(/\bbackdropFilter\s*:/g)?.length ?? 0;
      return count > 0 ? [[path, count] as const] : [];
    });
    expect(inline).toEqual([
      ['src/components/MemoryToast.tsx', 1],
      ['src/components/PreviewDrawOverlay.tsx', 3],
    ]);
  });

  it('leaves the low-spec sheet itself with no active backdrop declaration', () => {
    expect(activeBaseBackdropGroups('src/styles/low-spec/material.css')).toEqual([]);
    expect(activeBaseBackdropGroups('src/styles/low-spec/motion.css')).toEqual([]);
  });
});

describe('low-spec material: import wiring', () => {
  it('is the last import of src/index.css so it follows every owner sheet', () => {
    const imports = read('src/index.css')
      .split(/\r?\n/)
      .filter((line) => line.startsWith('@import'));
    expect(imports.at(-1)).toBe("@import './styles/low-spec/index.css';");
  });

  it('imports material.css then motion.css and nothing else', () => {
    const lines = read('src/styles/low-spec/index.css').split(/\r?\n/).filter((line) => line.trim() !== '');
    expect(lines).toEqual(["@import './material.css';", "@import './motion.css';"]);
  });
});

describe('low-spec material: full mode and reduced-transparency stay untouched', () => {
  it('scopes every rule to the low attribute and never keys on full or an absent attribute', () => {
    const selectors = materialRoot.nodes.flatMap((node) => (node.type === 'rule' ? node.selectors : []));
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector.startsWith(LOW)).toBe(true);
    expect(material).not.toMatch(/data-performance-profile="full"/);
    expect(material).not.toMatch(/:not\(\[data-performance-profile/);
  });

  it('carries no @media block, so OS preference blocks stay independent', () => {
    expect(materialRoot.nodes.some((node) => node.type === 'atrule')).toBe(false);
  });
});

describe('low-spec material: opaque, token-only surfaces', () => {
  const tokenBlock = materialRoot.nodes.find(
    (node) => node.type === 'rule' && node.selectors.includes(`${LOW}[data-theme-scheme]`),
  );

  it('re-values the glass tokens on the doubled root selector so dark-scheme rgba literals lose', () => {
    expect(tokenBlock?.type).toBe('rule');
    if (tokenBlock?.type !== 'rule') return;
    expect(tokenBlock.selectors).toEqual([LOW, `${LOW}[data-theme-scheme]`]);
    const values = Object.fromEntries(
      tokenBlock.nodes.flatMap((node) => (node.type === 'decl' ? [[node.prop, node.value]] : [])),
    );
    expect(values['--hub-glass-blur']).toBe('none');
    expect(values['--hub-control-blur']).toBe('none');
    expect(values['--app-window-chrome-glass']).toBe('none');
    expect(values['--hub-glass-fill']).toBe('var(--bg-panel)');
    expect(values['--hub-glass-fill-strong']).toBe('var(--bg-elevated)');
    expect(values['--hub-composer-fill']).toBe('var(--bg-elevated)');
    expect(values['--hub-control-surface']).toBe('var(--bg-elevated)');
    expect(values['--hub-canvas-background']).toBe('var(--hub-canvas-base)');
    expect(values['--hub-control-engraved-shadow']).toBe('inset 0 0 0 1px var(--border)');
  });

  it('uses semantic tokens only: no hex, rgb(a), hsl(a) or color-mix alpha literals', () => {
    expect(material).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(material).not.toMatch(/\b(?:rgba?|hsla?)\(/i);
    expect(material).not.toMatch(/\btransparent\b/);
  });

  it('hides the six route blooms and the Hub wash', () => {
    const hide = materialRoot.nodes.find(
      (node) => node.type === 'rule' && node.selectors.includes(`${LOW} .hub__wash`),
    );
    expect(hide?.type).toBe('rule');
    if (hide?.type !== 'rule') return;
    expect(hide.selectors).toEqual([
      `${LOW} .app::before`,
      `${LOW} .split::before`,
      `${LOW} .split::after`,
      `${LOW} .workspace-shell:has(> .workspace-shell__body .entry-main__inner--home)::before`,
      `${LOW} .workspace-shell:has(> .workspace-shell__body .entry-main__inner--home)::after`,
      `${LOW} .workspace-shell:has(> .workspace-shell__body .entry-main__inner--home) > .workspace-shell__body::before`,
      `${LOW} .hub__wash`,
    ]);
    const decl = hide.nodes.find((node) => node.type === 'decl');
    expect(decl?.type === 'decl' && `${decl.prop}: ${decl.value}${decl.important ? ' !important' : ''}`).toBe(
      'display: none !important',
    );
  });

  it('flattens the loading shell to the base fill and drops the logo drop-shadow', () => {
    expect(material).toMatch(new RegExp(`${LOW.replace(/[[\]"]/g, '\\$&')} \\.readable-loading-shell \\{\\s*background: var\\(--black\\) !important;`));
    expect(material).toMatch(/\.readable-loading-shell img \{\s*filter: none !important;/);
  });

  it('makes the hardcoded-translucent text carriers opaque with the matching ink', () => {
    const opaque = materialRoot.nodes.find(
      (node) => node.type === 'rule' && node.selectors.includes(`${LOW} .settings-close`),
    );
    expect(opaque?.type).toBe('rule');
    if (opaque?.type !== 'rule') return;
    for (const surface of [
      '.plugins-home__html--fallback .plugins-home__html-chrome',
      '.plugins-home__overlay-featured',
      '.plugins-home__overlay-tag',
      '.plugins-home__action--secondary',
      '.project-ds-picker-preview-expand',
      '.ds-source-staging-status',
      '.settings-close',
      '.settings-autosave',
    ]) {
      expect(opaque.selectors).toContain(`${LOW} ${surface}`);
    }
    const decls = opaque.nodes.flatMap((node) =>
      node.type === 'decl' ? [`${node.prop}: ${node.value}${node.important ? ' !important' : ''}`] : [],
    );
    expect(decls).toEqual(['background: var(--bg-elevated) !important', 'color: var(--text) !important']);
  });
});

describe('low-spec material: shadow flattening keeps affordances (M7)', () => {
  it('never selects focus, validation or selection state, and never forces box-shadow with !important', () => {
    materialRoot.walkRules((rule) => {
      for (const selector of rule.selectors) {
        const outsideNot = selector.replace(/:not\([^)]*\)/g, '');
        expect(outsideNot).not.toMatch(/:focus|\[aria-invalid|\.is-selected|aria-selected/);
      }
    });
    materialRoot.walkDecls('box-shadow', (decl) => {
      expect(decl.important).toBeFalsy();
      expect(decl.parent?.type === 'rule' && decl.parent.selectors.every((s) => /:not\(:hover, :focus-visible, \.is-selected\)$/.test(s))).toBe(true);
    });
    materialRoot.walkDecls('outline', () => {
      throw new Error('low-spec material must not touch outline');
    });
  });
});
