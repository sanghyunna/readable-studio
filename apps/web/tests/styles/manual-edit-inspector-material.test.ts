import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { collectCssHardcodedColorMatches } from '../../../../scripts/style-policy';

const inspectorCss = readFileSync(
  new URL('../../src/components/ManualEditLeftInspector.module.css', import.meta.url),
  'utf8',
);
const textControlsCss = readFileSync(
  new URL('../../src/components/ManualEditTextControls.module.css', import.meta.url),
  'utf8',
);
const shapeControlsCss = readFileSync(
  new URL('../../src/components/ManualEditShapeControls.module.css', import.meta.url),
  'utf8',
);
const shellCss = readFileSync(new URL('../../src/styles/shell.css', import.meta.url), 'utf8');

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  return match?.[1] ?? '';
}

describe('manual-edit inspector material', () => {
  it('keeps exactly one glass tier: the host paints it, the inspector body stays transparent', () => {
    // The host (shell.css) owns the pane's glass. A second translucent fill on
    // the inspector root would stack into the nested-card antipattern the Hub
    // language forbids.
    expect(shellCss).toMatch(/\.split > \.split-chat-slot > \.manual-edit-left-host/);
    const hostGlassBlock = shellCss.slice(
      shellCss.indexOf('.app .split > .split-chat-slot > .manual-edit-left-host'),
    );
    expect(hostGlassBlock).toMatch(/background: var\(--hub-glass-fill\)/);

    const root = ruleBody(inspectorCss, '.root');
    expect(root).toMatch(/background:\s*transparent/);
    expect(root).toMatch(/border:\s*0/);
    expect(root).not.toMatch(/backdrop-filter/);
    expect(ruleBody(inspectorCss, '.footer')).toMatch(/background:\s*transparent/);
  });

  it('drives every control surface from Hub tokens, with no hardcoded colour literals', () => {
    for (const css of [inspectorCss, textControlsCss, shapeControlsCss]) {
      expect(collectCssHardcodedColorMatches(css)).toEqual([]);
    }
    const root = ruleBody(inspectorCss, '.root');
    expect(root).toMatch(/--manual-edit-field-bg:\s*var\(--hub-control-surface\)/);
    expect(root).toMatch(/--manual-edit-field-bg-hover:\s*var\(--hub-control-surface-hover\)/);
    expect(root).toMatch(/--manual-edit-field-border:\s*transparent/);
  });

  it('separates with pearl light rays instead of grey rules', () => {
    // hub-dna §4/§10: a 1px grey border is never the separation device inside
    // glass. Every divider in the inspector body is an inset pearl highlight.
    for (const css of [inspectorCss, textControlsCss, shapeControlsCss]) {
      expect(css).not.toMatch(/border-bottom:\s*1px solid var\(--border\)/);
      expect(css).not.toMatch(/border-top:\s*1px solid var\(--border\)/);
    }
    expect(inspectorCss).toMatch(/box-shadow: inset 0 -1px 0 var\(--hub-pearl-highlight\)/);
    expect(inspectorCss).toMatch(/box-shadow: inset 0 1px 0 var\(--hub-pearl-highlight\)/);
  });

  it('ships opaque and still-motion fallbacks', () => {
    expect(inspectorCss).toMatch(/@media \(prefers-reduced-transparency: reduce\)/);
    expect(inspectorCss).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(textControlsCss).toMatch(/@media \(prefers-reduced-transparency: reduce\)/);
    expect(shapeControlsCss).toMatch(/@media \(prefers-reduced-transparency: reduce\)/);
  });
});
