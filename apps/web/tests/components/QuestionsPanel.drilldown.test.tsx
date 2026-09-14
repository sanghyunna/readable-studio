// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionsPanel } from '../../src/components/QuestionsPanel';
import type { ProjectBrief } from '../../src/components/brief-state';

const brief: ProjectBrief = { updatedAt: 1, assumptions: [
  { id: 'audience', label: 'Audience', value: 'buyers', provenance: 'inferred', question: { id: 'audience', label: 'Who is this for?', type: 'text' } },
  { id: 'scale', label: 'Scale', value: '8 slides', provenance: 'default' },
  { id: 'brand', label: 'Brand', value: 'pick_direction', provenance: 'stated', question: { id: 'brand', label: 'Brand', type: 'radio', options: [{ label: 'I have a brand spec', value: 'brand_spec' }] } },
  { id: 'platform', label: 'Platform', value: ['Responsive web'], provenance: 'default', question: { id: 'platform', label: 'Platform', type: 'checkbox', options: ['Responsive web', 'Desktop web'].map(value => ({ label: value, value })) } },
] };
const form = { id: 'source', title: 'Source', questions: [{ id: 'url', label: 'URL', type: 'text' as const, required: true }] };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function mount(onCorrect = vi.fn(async () => true)) {
  return render(<QuestionsPanel brief={brief} form={form} interactive generating={false} onCorrect={onCorrect} onSubmit={vi.fn()} />);
}
function row(name: RegExp) { return screen.getByRole('button', { name }); }
function openAudience() { const trigger = row(/Audience: buyers/); fireEvent.click(trigger); return trigger; }

describe('Questions anchored corrections', () => {
  it('keeps the same summary and required form mounted, in decision order', () => {
    const view = mount();
    const summary = screen.getByRole('group', { name: 'Project assumptions' });
    const input = screen.getByRole('textbox', { name: 'URL' });
    fireEvent.change(input, { target: { value: 'https://example.com' } });
    openAudience();
    expect(screen.getByRole('group', { name: 'Project assumptions' })).toBe(summary);
    expect(screen.getByRole('textbox', { name: 'URL' })).toBe(input);
    expect(input).toHaveProperty('value', 'https://example.com');
    expect(screen.getByTestId('questions-panel').dataset.step).toBe('summary');
    expect(screen.queryAllByTestId('questions-panel')).toHaveLength(1);
    expect(view.container.querySelector('[data-step="correct"]')).toBeNull();
    expect([...summary.querySelectorAll('section')].map(node => node.dataset.provenance)).toEqual(['stated', 'inferred', 'default']);
    expect(input.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(view.container.contains(screen.getByRole('textbox', { name: 'Who is this for?' }))).toBe(false);
  });

  it('Escape restores focus; outside dismissal and switching fields retain typed drafts; Cancel discards', () => {
    mount();
    const trigger = openAudience();
    fireEvent.change(screen.getByRole('textbox', { name: 'Who is this for?' }), { target: { value: 'security leaders' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole('textbox', { name: 'Who is this for?' })).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole('textbox', { name: 'Who is this for?' })).toHaveProperty('value', 'security leaders');
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('textbox', { name: 'Who is this for?' })).toBeNull();
    fireEvent.click(trigger);
    fireEvent.click(row(/Scale: 8 slides/));
    expect(screen.queryByRole('textbox', { name: 'Who is this for?' })).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole('textbox', { name: 'Who is this for?' })).toHaveProperty('value', 'security leaders');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect(screen.getByRole('textbox', { name: 'Who is this for?' })).toHaveProperty('value', 'buyers');
  });

  it('saves once, waits for persistence, and restores the field focus', async () => {
    let resolve!: (value: boolean) => void;
    const persisted = new Promise<boolean>(done => { resolve = done; });
    const onCorrect = vi.fn(() => persisted);
    mount(onCorrect);
    const trigger = openAudience();
    fireEvent.change(screen.getByRole('textbox', { name: 'Who is this for?' }), { target: { value: 'security leaders' } });
    const save = screen.getByRole('button', { name: 'Apply correction' });
    fireEvent.click(save); fireEvent.click(save);
    expect(onCorrect).toHaveBeenCalledTimes(1);
    expect(onCorrect).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ id: 'audience', value: 'security leaders', provenance: 'stated' }));
    expect(screen.getByRole('textbox', { name: 'Who is this for?' })).toBeTruthy();
    await act(async () => { resolve(true); await persisted; });
    expect(screen.queryByRole('textbox', { name: 'Who is this for?' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('restores focus after a saved field moves into the confirmed group', async () => {
    function PersistedPanel() {
      const [current, setCurrent] = useState(brief);
      return <QuestionsPanel brief={current} form={null} interactive={false} generating={false}
        onSubmit={vi.fn()} onCorrect={async next => { setCurrent(next); return true; }} />;
    }
    render(<PersistedPanel />);
    openAudience();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Apply correction' })); });
    expect(document.activeElement).toBe(row(/Audience: buyers.*Stated by you/));
  });

  it('retains failed writes for retry without closing the editor', async () => {
    mount(vi.fn(async () => false));
    openAudience();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Apply correction' })); });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Who is this for?' })).toHaveProperty('value', 'buyers');
  });

  it('opens enumerated options directly in the shared listbox and persists stable values', async () => {
    const onCorrect = vi.fn(async () => true);
    mount(onCorrect);
    fireEvent.click(row(/Brand:/));
    expect(screen.getByRole('listbox').closest('.inline-switcher__popover--model')).toBeTruthy();
    expect(document.querySelector('select')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: /I have a brand spec/ })); });
    expect(onCorrect).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ value: 'brand_spec' }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('keeps multi-value option selection in one listbox until Save', async () => {
    const onCorrect = vi.fn(async () => true);
    mount(onCorrect);
    fireEvent.click(row(/Platform:/));
    expect(screen.getByRole('listbox').getAttribute('aria-multiselectable')).toBe('true');
    fireEvent.click(screen.getByRole('option', { name: /Desktop web/ }));
    expect(onCorrect).not.toHaveBeenCalled();
    expect(screen.getByRole('option', { name: /Desktop web/ }).getAttribute('aria-selected')).toBe('true');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Apply correction' })); });
    expect(onCorrect).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ value: ['Responsive web', 'Desktop web'] }));
  });
});
