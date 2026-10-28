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

  it.each([null, { ...measured, state: 'unknown' as const, usedTokens: null }, { ...measured, usedTokens: Number.NaN }])('does not turn unavailable data into zero: %j', (snapshot) => {
    render(<ContextUsageMeter snapshot={snapshot} />);
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByTestId('context-usage-meter').dataset.tooltip).toContain('not been reported');
    expect(screen.getByTestId('context-usage-meter').hasAttribute('aria-valuenow')).toBe(false);
  });

  it('shows an advertised capacity like any other displayable limit', () => {
    render(<ContextUsageMeter snapshot={{ ...measured, state: 'estimated', usedTokens: 5_000, limitTokens: 128_000, limitSource: 'advertised' }} />);
    expect(screen.getByText('3.9%')).toBeTruthy();
    expect(screen.getByRole('meter').dataset.tooltip).toBe('Estimated · 5k/128k');
  });

  it('shows reported usage without inventing a percentage when the limit is unknown', () => {
    const view = render(<ContextUsageMeter snapshot={{ ...measured, state: 'estimated', usedTokens: 12_300, limitTokens: null, limitSource: 'default' }} />);
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.getByText('12.3k')).toBeTruthy();
    expect(screen.getByTestId('context-usage-fill').hidden).toBe(true);
    expect(screen.getByTestId('context-usage-meter').dataset.tooltip).toBe('Estimated · 12.3k used · limit unknown');
    view.rerender(<I18nProvider initial="ko"><ContextUsageMeter snapshot={{ ...measured, limitTokens: null }} /></I18nProvider>);
    expect(screen.getByTestId('context-usage-meter').dataset.tooltip).toBe('200k 사용 · 한도 알 수 없음');
    // A planning-default capacity is never displayed, even if one slipped through.
    view.rerender(<ContextUsageMeter snapshot={{ ...measured, limitSource: 'default' }} />);
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.getByTestId('context-usage-meter').dataset.tooltip).toBe('200k used · limit unknown');
    // The composer label rounds like the percentage; the tooltip keeps the exact k figure.
    view.rerender(<ContextUsageMeter snapshot={{ ...measured, usedTokens: 87_654, limitTokens: null }} />);
    expect(screen.getByText('87.7k')).toBeTruthy();
    expect(screen.getByTestId('context-usage-meter').dataset.tooltip).toBe('87.654k used · limit unknown');
  });

  it.each([
    ['run-started', 'Waiting for updated context usage for this session.'],
    ['not-reported', 'Context usage or capacity has not been reported for this agent and model.'],
  ] as const)('explains a %s snapshot', (reason, copy) => {
    render(<ContextUsageMeter snapshot={{ ...measured, state: 'unknown', usedTokens: null, limitTokens: null, source: 'none', limitSource: 'unknown', reason }} />);
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByTestId('context-usage-meter').dataset.tooltip).toBe(copy);
  });

  it('identifies estimates in each product locale and keeps k units for large values', () => {
    const view = render(<ContextUsageMeter snapshot={{ ...measured, state: 'estimated', usedTokens: 284_000 }} />);
    expect(screen.getByText('56.8%')).toBeTruthy();
    expect(screen.getByRole('meter').dataset.tooltip).toBe('Estimated · 284k/500k');
    view.rerender(<I18nProvider initial="ko"><ContextUsageMeter snapshot={{ ...measured, state: 'estimated', usedTokens: 1_284_000, limitTokens: 2_000_000 }} /></I18nProvider>);
    expect(screen.getByRole('meter').dataset.tooltip).toBe('추정 · 1284k/2000k');
  });
});
