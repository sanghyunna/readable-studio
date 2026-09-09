// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionsPanel } from '../../src/components/QuestionsPanel';
import { I18nProvider } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';
import { ko } from '../../src/i18n/locales/ko';
afterEach(cleanup);
describe('Questions panel placement and locale', () => {
  it.each(['en', 'ko'] as const)('keeps both steps inside the tab body in %s', locale => {
    const dict = locale === 'ko' ? ko : en;
    const view = render(<I18nProvider initial={locale}><QuestionsPanel form={null} interactive={false} generating={false}
      onSubmit={vi.fn()} onCorrect={async () => true} brief={{ updatedAt: 1, assumptions: [
        { id: 'audience', label: 'audience', value: 'buyers', provenance: 'default' },
      ] }} /></I18nProvider>);
    const panel = screen.getByRole('dialog');
    expect(view.container.contains(panel)).toBe(true);
    expect(panel.style.visibility).not.toBe('hidden');
    expect(screen.getByTestId('questions-influence').textContent).toBe(dict['questions.influence'].replace('{count}', '1').replace('{stated}', '0'));
    fireEvent.click(screen.getByRole('listitem'));
    expect(screen.getByRole('textbox', { name: dict['questions.question.audience'] })).toBeTruthy();
    expect(screen.getByRole('dialog')).toBe(panel);
    fireEvent.click(screen.getByRole('button', { name: dict['questions.backToSummary'] }));
    expect(screen.getByRole('listitem')).toBeTruthy();
  });
  it('does not use a positioned overlay or viewport-sized popover inside the tab', () => {
    const css = readFileSync(resolve(__dirname, '../../src/components/QuestionsPanel.css'), 'utf8');
    expect(css).not.toMatch(/position:\s*(fixed|absolute)|z-index:|visibility:\s*hidden|pointer-events:\s*none/);
  });
});
