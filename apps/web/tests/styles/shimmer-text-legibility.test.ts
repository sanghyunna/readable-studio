import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const codeCss = readFileSync(
  resolve(import.meta.dirname, '../../src/styles/viewer/code.css'),
  'utf8',
);

function ruleDeclarations(source: string, selector: string): Record<string, string> {
  const result: Record<string, string> = {};
  const root = postcss.parse(source);
  root.walkRules(rule => {
    if (rule.parent !== root || rule.selector !== selector) return;
    rule.walkDecls(decl => { result[decl.prop] = decl.value; });
  });
  return result;
}

function atRuleDeclarations(source: string, atRuleName: string, selector: string): Record<string, string> {
  const result: Record<string, string> = {};
  postcss.parse(source).walkAtRules(atRule => {
    if (atRule.name !== atRuleName) return;
    atRule.walkRules(rule => {
      if (rule.selector !== selector) return;
      rule.walkDecls(decl => { result[decl.prop] = decl.value; });
    });
  });
  return result;
}

function gradientStops(value: string): string[] {
  const start = value.indexOf('linear-gradient(');
  if (start === -1) return [];
  let depth = 1;
  let end = start + 'linear-gradient('.length;
  while (end < value.length && depth > 0) {
    if (value[end] === '(') depth++;
    else if (value[end] === ')') depth--;
    end++;
  }
  const inner = value.slice(start + 'linear-gradient('.length, end - 1);
  // Drop the angle argument, keep stop declarations.
  const stopsPart = inner.replace(/^[^,]+,\s*/, '');
  return stopsPart.split(',').map(s => s.trim());
}

describe('shimmer-text legibility', () => {
  const base = ruleDeclarations(codeCss, '.shimmer-text');
  const reduced = atRuleDeclarations(codeCss, 'media', '.shimmer-text');

  it('keeps the base text colour solid so the label is always readable', () => {
    expect(base.color).toBe('var(--text-muted)');
  });

  it('does not use transparent gradient stops that would hide the text', () => {
    const stops = gradientStops(base.background ?? '');
    expect(stops.length).toBeGreaterThan(0);
    for (const stop of stops) {
      expect(stop).not.toContain('transparent');
    }
  });

  it('sweeps a brighter highlight over the solid muted base', () => {
    const stops = gradientStops(base.background ?? '');
    const joined = stops.join(' ');
    expect(joined).toContain('var(--text-muted)');
    expect(joined).toContain('var(--text)');
  });

  it('freezes as solid muted text when motion is reduced', () => {
    expect(reduced['-webkit-text-fill-color']).toBe('var(--text-muted)');
    expect(reduced.background).toBe('none');
    expect(reduced.animation).toBe('none');
  });
});
