import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  new URL('../../src/components/SettingsDialog.module.css', import.meta.url),
  'utf8',
);

const rule = (selector: string) => {
  const match = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
};

describe('SettingsDialog code-agent toggle grid styles', () => {
  it('uses an overflow-safe RAM grid with the specified card geometry', () => {
    expect(rule('.codeAgentsList')).toContain('display: grid');
    expect(rule('.codeAgentsList')).toMatch(/repeat\(auto-fit,\s*minmax\(min\(192px,\s*100%\),\s*1fr\)\)/);
    expect(rule('.codeAgentsList')).toContain('gap: 12px');
    expect(rule('.codeAgentsList')).not.toMatch(/overflow(?:-x|-inline)?\s*:\s*(auto|scroll)/);
    expect(rule('.codeAgentCard')).toContain('min-block-size: 104px');
    expect(rule('.codeAgentCard')).toContain('grid-template-columns: 32px minmax(0, 1fr)');
  });

  it('distinguishes raised and inset states by semantic depth and position', () => {
    expect(rule('.codeAgentCard')).toContain('var(--bg-elevated)');
    expect(rule('.codeAgentCard')).toContain('var(--shadow-xs)');
    expect(rule('.codeAgentCard')).toContain('translateY(-1px)');
    expect(rule(".codeAgentCard[data-state='on']")).toContain('inset');
    expect(rule(".codeAgentCard[data-state='on']")).toContain('translateY(1px)');
  });

  it('covers long copy and adaptive preferences without forbidden treatments', () => {
    expect(css).toContain('overflow-wrap: anywhere');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).not.toMatch(/gradient\s*\(/i);
    expect(css).not.toMatch(/background(?:-color)?\s*:\s*(?:#000(?:000)?|black|rgba?\(\s*0\s*,\s*0\s*,\s*0)/i);
    expect(css).not.toMatch(/border(?:-width)?\s*:\s*[2-9]px/i);
  });
});
