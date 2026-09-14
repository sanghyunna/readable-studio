// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssumptionLedger } from '../../src/components/AssumptionLedger';
import type { BriefAssumption, ProjectBrief } from '../../src/components/brief-state';

const brief: ProjectBrief = { updatedAt: 1, assumptions: [
  { id: 'audience', label: 'Audience', value: 'buyers', provenance: 'inferred' },
  { id: 'scale', label: 'Scale', value: '8 slides', provenance: 'stated' },
  { id: 'tone', label: 'Tone', value: 'formal', provenance: 'default' },
] };

afterEach(() => cleanup());

describe('AssumptionLedger (persisted assumptions without a question form)', () => {
  it('renders the ledger from persisted assumptions with no form message present', () => {
    // No QuestionsPanel / form anywhere in the tree: the ledger stands alone.
    render(<AssumptionLedger brief={brief} onCorrect={vi.fn()} />);
    expect(screen.queryByTestId('questions-panel')).toBeNull();
    const trigger = screen.getByTestId('assumption-ledger-trigger');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('assumption-ledger-menu')).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('dialog');
    expect(menu.getAttribute('aria-labelledby')).toBe(menu.querySelector('h2')?.id);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('button', { name: /Audience: buyers/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Scale: 8 slides/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Tone: formal/ })).toBeTruthy();
    // Background context, never the card's pending treatment.
    expect(document.querySelector('[data-pending]')).toBeNull();
  });

  it('reports the confirmed count from the data', () => {
    render(<AssumptionLedger brief={brief} onCorrect={vi.fn()} />);
    fireEvent.click(screen.getByTestId('assumption-ledger-trigger'));
    expect(screen.getByTestId('assumption-ledger-influence').dataset).toMatchObject({ count: '3', confirmed: '1' });

    cleanup();
    const allStated: ProjectBrief = { updatedAt: 2, assumptions: brief.assumptions.map(item => ({ ...item, provenance: 'stated' as const })) };
    render(<AssumptionLedger brief={allStated} onCorrect={vi.fn()} />);
    fireEvent.click(screen.getByTestId('assumption-ledger-trigger'));
    expect(screen.getByTestId('assumption-ledger-influence').dataset).toMatchObject({ count: '3', confirmed: '3' });
  });

  it('routes a correction through the shared onCorrect path with the corrected brief and entry', async () => {
    const onCorrect = vi.fn(async (_next: ProjectBrief, _corrected: BriefAssumption) => true);
    render(<AssumptionLedger brief={brief} onCorrect={onCorrect} />);
    fireEvent.click(screen.getByTestId('assumption-ledger-trigger'));
    fireEvent.click(screen.getByRole('button', { name: /Audience: buyers/ }));
    const input = screen.getByRole('textbox', { name: 'Audience' });
    fireEvent.change(input, { target: { value: 'enterprise buyers' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Apply correction' })); });

    expect(onCorrect).toHaveBeenCalledTimes(1);
    const [next, corrected] = onCorrect.mock.calls[0]!;
    expect(corrected).toMatchObject({ id: 'audience', label: 'Audience', value: 'enterprise buyers', provenance: 'stated' });
    expect(next.assumptions.map(item => [item.id, item.value, item.provenance])).toEqual([
      ['audience', 'enterprise buyers', 'stated'],
      ['scale', '8 slides', 'stated'],
      ['tone', 'formal', 'default'],
    ]);
    // Editor closes on success; the ledger stays open for further corrections.
    expect(screen.queryByRole('textbox', { name: 'Audience' })).toBeNull();
    expect(screen.getByTestId('assumption-ledger-menu')).toBeTruthy();
  });

  it('surfaces a failed persistence without closing the editor', async () => {
    const onCorrect = vi.fn(async () => false);
    render(<AssumptionLedger brief={brief} onCorrect={onCorrect} />);
    fireEvent.click(screen.getByTestId('assumption-ledger-trigger'));
    fireEvent.click(screen.getByRole('button', { name: /Audience: buyers/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Audience' }), { target: { value: 'x' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Apply correction' })); });
    expect(onCorrect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Audience' })).toBeTruthy();
  });

  it('is absent when there are no assumptions', () => {
    const { rerender } = render(<AssumptionLedger brief={null} onCorrect={vi.fn()} />);
    expect(screen.queryByTestId('assumption-ledger')).toBeNull();
    rerender(<AssumptionLedger brief={{ updatedAt: 1, assumptions: [] }} onCorrect={vi.fn()} />);
    expect(screen.queryByTestId('assumption-ledger')).toBeNull();
    rerender(<AssumptionLedger brief={undefined} onCorrect={vi.fn()} />);
    expect(screen.queryByTestId('assumption-ledger')).toBeNull();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    render(<AssumptionLedger brief={brief} onCorrect={vi.fn()} />);
    const trigger = screen.getByTestId('assumption-ledger-trigger');
    fireEvent.click(trigger);
    expect(screen.getByTestId('assumption-ledger-menu')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('assumption-ledger-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
