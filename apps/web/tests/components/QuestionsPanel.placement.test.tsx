// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionsPanel } from '../../src/components/QuestionsPanel';
import { placePopover } from '../../src/components/popoverPlacement';
import { I18nProvider } from '../../src/i18n';
import { getEn } from '../../src/i18n/locales/en';
import { getKo } from '../../src/i18n/locales/ko';
const en = getEn();
const ko = getKo();
afterEach(cleanup);
describe('Questions anchored placement and locale', () => {
  it.each(['en', 'ko'] as const)('preserves the summary while the localized editor is portaled in %s', locale => {
    const dict = locale === 'ko' ? ko : en;
    const view = render(<I18nProvider initial={locale}><QuestionsPanel form={null} interactive={false} generating={false}
      onSubmit={vi.fn()} onCorrect={async () => true} brief={{ updatedAt: 1, assumptions: [
        { id: 'audience', label: 'audience', value: 'buyers', provenance: 'default' },
      ] }} /></I18nProvider>);
    const panel = screen.getByTestId('questions-panel');
    fireEvent.click(screen.getByRole('button', { name: /buyers/ }));
    const input = screen.getByRole('textbox', { name: 'audience' });
    expect(view.container.contains(input)).toBe(false);
    expect(screen.getByTestId('questions-panel')).toBe(panel);
    expect(screen.getByTestId('questions-influence').dataset.count).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: dict['common.cancel'] }));
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it.each([375, 768, 1280])('clamps the actual placement function at %ipx without a screen-covering layer', width => {
    const panelWidth = Math.min(400, width - 24);
    const pos = placePopover({ left: width - 160, top: 450, width: 140, height: 48 }, { width: panelWidth, height: 220 }, { width, height: 700 });
    expect(pos.left).toBeGreaterThanOrEqual(12);
    expect(pos.left + panelWidth).toBeLessThanOrEqual(width - 12);
    expect(pos.top).toBeGreaterThanOrEqual(12);
    expect(pos.top + 220).toBeLessThanOrEqual(688);
  });
  it('keeps a single row stack, a bounded measure, wrapping values and no tab-blocking scrim', () => {
    const css = readFileSync(resolve(__dirname, '../../src/components/QuestionsPanel.css'), 'utf8');
    expect(css).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(css).toContain('max-inline-size: 70ch');
    expect(css).toContain('@container (max-width: 540px)');
    expect(css).toContain('overflow-wrap: anywhere');
    expect(css).not.toMatch(/repeat\(2|inset:\s*0|pointer-events:\s*none/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
  });
});
