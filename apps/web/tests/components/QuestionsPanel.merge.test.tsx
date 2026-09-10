// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionsPanel } from '../../src/components/QuestionsPanel';
import type { ProjectBrief } from '../../src/components/brief-state';

const brief: ProjectBrief = { updatedAt: 1, assumptions: [
  { id: 'audience', label: 'Audience', value: 'buyers', provenance: 'inferred' },
  { id: 'scale', label: 'Scale', value: '8 slides', provenance: 'stated' },
] };
const form = { id: 'source', title: 'Source', questions: [{ id: 'url', label: 'URL', type: 'text' as const }] };
afterEach(() => { cleanup(); window.sessionStorage.clear(); });

describe('Questions merged surface', () => {
  it('keeps assumptions, influence and the primary form mounted during correction', () => {
    render(<QuestionsPanel brief={brief} onCorrect={vi.fn()} form={form} interactive generating={false} onSubmit={vi.fn()} />);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.queryByTestId('brief-card')).toBeNull();
    expect(screen.getByTestId('questions-influence').dataset).toMatchObject({ count: '2', confirmed: '1' });
    fireEvent.change(screen.getByRole('textbox', { name: 'URL' }), { target: { value: 'https://example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Audience: buyers/ }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('group', { name: 'Project assumptions' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'URL' })).toHaveProperty('value', 'https://example.com');
    expect(document.querySelector('.question-form-head')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('textbox', { name: 'URL' })).toHaveProperty('value', 'https://example.com');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('blocks correction submission during hydration, offers retry, and prevents rapid duplicate writes', async () => {
    let resolve!: (result: boolean) => void;
    const persisted = new Promise<boolean>(done => { resolve = done; });
    const onCorrect = vi.fn((_next: ProjectBrief, _corrected: ProjectBrief['assumptions'][number]) => persisted);
    const retry = vi.fn();
    const panel = (status: 'pending' | 'failed' | 'ready') => <QuestionsPanel brief={brief} onCorrect={onCorrect}
      form={null} interactive={false} generating={false} onSubmit={vi.fn()}
      runHydrationStatus={status} onRetryRunHydration={retry} />;
    const view = render(panel('pending'));
    fireEvent.click(screen.getByRole('button', { name: /Audience: buyers/ }));
    expect(screen.getByRole('button', { name: 'Apply correction' })).toHaveProperty('disabled', true);
    view.rerender(panel('failed'));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retry).toHaveBeenCalledTimes(1);
    view.rerender(panel('ready'));
    const apply = screen.getByRole('button', { name: 'Apply correction' });
    fireEvent.click(apply); fireEvent.click(apply);
    expect(onCorrect).toHaveBeenCalledTimes(1);
    expect(onCorrect.mock.calls[0]?.[1]).toMatchObject({ id: 'audience', value: 'buyers', provenance: 'stated' });
    await act(async () => { resolve(true); await persisted; });
    expect(screen.getByTestId('questions-panel').dataset.step).toBe('summary');
  });
});
