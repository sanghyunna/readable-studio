import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../src/styles/workspace/drawer.css', import.meta.url), 'utf8');
function declarations(selector: string) {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]+)\}/g)];
  return rules.filter((rule) => rule[1]!.split(',').map((part) => part.trim()).includes(selector))
    .map((rule) => rule[2]).join('\n');
}

describe('workspace close-control layout', () => {
  it('reserves a nonshrinking 24px close target and leaves room for the original label width', () => {
    const control = declarations('.ws-tab .ws-tab-close');
    expect(control).toMatch(/flex:\s*0 0 24px/);
    expect(control).toMatch(/width:\s*24px/);
    expect(control).toMatch(/height:\s*24px/);
    expect(control).not.toMatch(/display:\s*none|visibility:\s*hidden/);
    expect(declarations('.ws-tab')).toMatch(/max-width:\s*170px/);
    expect(declarations('.ws-tab-label')).toMatch(/max-width:\s*96px/);
    expect(declarations('.ws-tab-label')).toMatch(/text-overflow:\s*ellipsis/);
    expect(declarations('.ws-tab-text')).toMatch(/min-width:\s*0/);
  });

  it('uses token focus styling and disables tab/control motion for reduced motion', () => {
    expect(declarations('.ws-tab .ws-tab-close:focus-visible')).toMatch(/outline:\s*2px solid var\(--accent\)/);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.ws-tab,\s*\.ws-tab \.ws-tab-close\s*\{\s*transition:\s*none;/);
    expect(declarations('.ws-tab .ws-tab-close')).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});
