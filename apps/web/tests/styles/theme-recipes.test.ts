import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPLICIT_THEME_OPTIONS } from '../../src/state/themes';

const webRoot = path.resolve(import.meta.dirname, '../..');
const themesRoot = path.join(webRoot, 'src/styles/themes');
const recipePath = path.join(themesRoot, 'recipes.css');

const HUB_MATERIAL_TOKENS = [
  '--hub-canvas',
  '--hub-accent',
  '--hub-accent-ink',
  '--hub-accent-fill',
  '--hub-accent-line',
  '--hub-accent-tint',
  '--hub-accent-fg',
  '--hub-pearl-top',
  '--hub-pearl-mid',
  '--hub-pearl-bottom',
  '--hub-pearl-border',
  '--hub-pearl-highlight',
  '--hub-pearl-elevation',
  '--hub-wash',
  '--hub-wash-warm',
  '--hub-wash-cool',
  '--hub-canvas-base',
  '--hub-canvas-blue',
  '--hub-canvas-pink',
  '--hub-canvas-cyan',
  '--hub-canvas-green',
  '--hub-canvas-background',
  '--hub-glass-fill',
  '--hub-glass-fill-strong',
  '--hub-glass-blur',
  '--hub-glass-shadow',
  '--hub-glass-shadow-lg',
  '--hub-composer-fill',
  '--hub-composer-body',
  '--hub-composer-top',
  '--hub-composer-bottom',
  '--hub-control-surface',
  '--hub-control-surface-hover',
  '--hub-control-blur',
  '--hub-control-border',
  '--hub-control-highlight',
  '--hub-control-shadow',
  '--hub-control-shadow-hover',
  '--hub-send-disabled',
  '--hub-ready-shadow',
  '--hub-ready-highlight',
] as const;

function customPropertyNames(source: string): readonly string[] {
  return [...source.matchAll(/^\s*(--[-a-z0-9]+)\s*:/gim)].map((match) => match[1] ?? '');
}

function customPropertyValue(source: string, token: string): string {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`^\\s*${escaped}\\s*:\\s*([^;]+);`, 'mi'))?.[1]?.trim() ?? '';
}

describe('Screen Mode theme recipes', () => {
  it('defines the complete literal-color-free Hub material contract from semantic sources', async () => {
    // Given
    const recipe = await readFile(recipePath, 'utf8');

    // When
    const recipeTokens = new Set(customPropertyNames(recipe));

    // Then
    expect(recipeTokens).toEqual(new Set(HUB_MATERIAL_TOKENS));
    expect(recipe).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i);
    for (const token of HUB_MATERIAL_TOKENS) {
      const value = customPropertyValue(recipe, token);
      if (
        value === 'transparent' ||
        token === '--hub-glass-blur' ||
        token === '--hub-control-blur'
      ) {
        continue;
      }
      if (token === '--hub-canvas-background') {
        for (const source of [
          '--hub-canvas-blue',
          '--hub-canvas-pink',
          '--hub-canvas-cyan',
          '--hub-canvas-green',
          '--hub-canvas-base',
        ]) {
          expect(value, `${token} -> ${source}`).toContain(`var(${source})`);
        }
        continue;
      }
      expect(value, token).toMatch(/var\(--(?:bg|bg-app|bg-panel|bg-elevated|bg-fill(?:-secondary|-tertiary)?|border|border-strong|border-soft|text|text-strong|text-muted|text-soft|text-faint|accent|accent-strong|accent-soft|accent-tint|accent-hover|accent-contrast|blue|blue-bg|blue-border|purple|purple-bg|purple-border|green|green-bg|green-border|shadow-color|shadow-(?:sm|md|lg))\)/);
    }
  });

  // Regression: in light `--bg-panel` (#fdfcfa) and `--bg` (#faf9f7) are 3/255
  // apart, so a panel-dominant glass fill composites onto the opaque stage
  // value - the pane measured 2/255 from the stage and read as flat white. The
  // tier separates by how much ambient canvas it lets through, so the fill must
  // stay minority-weighted and the blooms must be mixed hard enough to be that
  // ambient source.
  it('keeps the glass tier canvas-dominant so it separates from an opaque stage', async () => {
    // Given
    const recipe = await readFile(recipePath, 'utf8');

    // When
    const fill = customPropertyValue(recipe, '--hub-glass-fill');
    const fillPercent = Number(/(\d+)%/.exec(fill)?.[1]);

    // Then
    expect(fill).toContain('var(--bg-panel)');
    expect(fillPercent).toBeLessThanOrEqual(55);

    for (const token of ['--hub-canvas-blue', '--hub-canvas-pink', '--hub-canvas-cyan', '--hub-canvas-green'] as const) {
      const percent = Number(/(\d+)%/.exec(customPropertyValue(recipe, token))?.[1]);
      expect(percent, token).toBeGreaterThanOrEqual(22);
    }
  });

  it('propagates one recipe to every explicit registry theme with a distinct source signature', async () => {
    // Given
    const recipe = await readFile(recipePath, 'utf8');
    const tokens = await readFile(path.join(webRoot, 'src/styles/tokens.css'), 'utf8');

    // When
    const signatures = await Promise.all(EXPLICIT_THEME_OPTIONS.map(async ({ id }) => {
      const source = id === 'light' || id === 'dark'
        ? tokens
        : await readFile(path.join(themesRoot, `${id}.css`), 'utf8');
      const selector = `[data-theme='${id}']`;
      const body = source.match(new RegExp(`\\[data-theme=['"]${id}['"]\\]\\s*\\{([\\s\\S]*?)\\n\\}`, 'm'))?.[1] ?? source.match(/:root\s*\{([\s\S]*?)\n\}/m)?.[1] ?? '';
      return [id, [customPropertyValue(body, '--bg-app'), customPropertyValue(body, '--accent'), customPropertyValue(body, '--text-strong')].join('|'), selector] as const;
    }));

    // Then
    expect(new Set(signatures.map(([, signature]) => signature)).size).toBe(signatures.length);
    for (const [, signature, selector] of signatures) {
      expect(signature).not.toContain('||');
      expect(recipe).toContain(selector);
    }
  });

  it('loads recipes after source themes and covers both system color schemes', async () => {
    // Given
    const [index, recipe] = await Promise.all([
      readFile(path.join(themesRoot, 'index.css'), 'utf8'),
      readFile(recipePath, 'utf8'),
    ]);

    // When
    const recipeImport = index.indexOf("@import './recipes.css';");
    const lastSourceImport = index.lastIndexOf('@import');

    // Then
    expect(recipeImport).toBe(lastSourceImport);
    expect(recipe).toMatch(/@media\s*\(prefers-color-scheme:\s*light\)/);
    expect(recipe).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
    expect(recipe.match(/html:not\(\[data-theme\]\)/g)).toHaveLength(2);
  });
});
