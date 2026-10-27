// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ContextUsageSnapshot } from '@readable-studio/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextUsageMeter } from '../../src/components/ContextUsageMeter';
import { TooltipLayer } from '../../src/components/TooltipLayer';
import { I18nProvider } from '../../src/i18n';

const measured: ContextUsageSnapshot = {
  state: 'measured', usedTokens: 200_000, limitTokens: 500_000,
  source: 'codex', limitSource: 'runtime', model: 'gpt-5.4', sessionId: 's1', updatedAt: 1,
};

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('ContextUsageMeter', () => {
  it('renders measured occupancy and uses the shared hover and keyboard tooltip', () => {
    vi.useFakeTimers();
    render(<><ContextUsageMeter snapshot={measured} /><TooltipLayer /></>);
    const meter = screen.getByRole('meter');
    expect(meter.getAttribute('aria-valuenow')).toBe('200000');
    expect(meter.getAttribute('aria-valuetext')).toContain('200k/500k');
    expect(screen.getByText('40%')).toBeTruthy();
    fireEvent.pointerOver(meter);
    act(() => vi.advanceTimersByTime(350));
    expect(screen.getByRole('tooltip').textContent).toBe('200k/500k');
    fireEvent.pointerOut(meter);
    fireEvent.keyDown(document, { key: 'Tab' });
    fireEvent.focusIn(meter);
    expect(screen.getByRole('tooltip').textContent).toBe('200k/500k');
    expect(meter.tabIndex).toBe(0);
  });

  it('preserves zero and over-limit measurements while clamping only the painted fill', () => {
    const view = render(<ContextUsageMeter snapshot={{ ...measured, usedTokens: 0 }} />);
    expect(screen.getByText('0%')).toBeTruthy();
    expect(screen.getByRole('meter').dataset.tooltip).toBe('0k/500k');
    view.rerender(<ContextUsageMeter snapshot={{ ...measured, usedTokens: 600_000 }} />);
    expect(screen.getByText('120%')).toBeTruthy();
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('600000');
    expect(screen.getByRole('meter').dataset.tooltip).toBe('600k/500k');
    expect(screen.getByTestId('context-usage-fill').style.width).toBe('100%');
  });

  it('updates an already-open tooltip when live occupancy changes', async () => {
    vi.useFakeTimers();
    const view = render(<><ContextUsageMeter snapshot={measured} /><TooltipLayer /></>);
    fireEvent.pointerOver(screen.getByRole('meter'));
    act(() => vi.advanceTimersByTime(350));
    expect(screen.getByRole('tooltip').textContent).toBe('200k/500k');
    view.rerender(<><ContextUsageMeter snapshot={{ ...measured, usedTokens: 284_000 }} /><TooltipLayer /></>);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('tooltip').textContent).toBe('284k/500k');
  });

  it.each([null, { ...measured, state: 'unknown' as const, usedTokens: null }, { ...measured, limitTokens: null }, { ...measured, usedTokens: Number.NaN }, { ...measured, limitSource: 'advertised' as const }])('does not turn unavailable data into zero: %j', (snapshot) => {
    render(<ContextUsageMeter snapshot={snapshot} />);
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByTestId('context-usage-meter').dataset.tooltip).toContain('not been reported');
    expect(screen.getByTestId('context-usage-meter').hasAttribute('aria-valuenow')).toBe(false);
  });

  it('identifies estimates in each product locale and keeps k units for large values', () => {
    const view = render(<ContextUsageMeter snapshot={{ ...measured, state: 'estimated', usedTokens: 284_000 }} />);
    expect(screen.getByText('56.8%')).toBeTruthy();
    expect(screen.getByRole('meter').dataset.tooltip).toBe('Estimated · 284k/500k');
    view.rerender(<I18nProvider initial="ko"><ContextUsageMeter snapshot={{ ...measured, state: 'estimated', usedTokens: 1_284_000, limitTokens: 2_000_000 }} /></I18nProvider>);
    expect(screen.getByRole('meter').dataset.tooltip).toBe('추정 · 1284k/2000k');
  });
});
