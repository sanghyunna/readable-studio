// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MentionPreviewPicker, type MentionPreviewItem } from '../../src/components/MentionPreviewPicker';
import { I18nProvider } from '../../src/i18n';

const ITEMS: MentionPreviewItem[] = [
  { key: 'alpha', id: 'alpha', kind: 'skill', title: 'Alpha', description: 'First skill', kindLabel: 'Skill', icon: 'file' },
  { key: 'beta', id: 'beta', kind: 'skill', title: 'Beta', description: 'Second skill', kindLabel: 'Skill', icon: 'file' },
];

function Picker({ onConfirm, busy = false, disabled = false, initialIndex = 0 }: {
  onConfirm(item: MentionPreviewItem): void;
  busy?: boolean;
  disabled?: boolean;
  initialIndex?: number;
}) {
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  return <I18nProvider initial="en"><MentionPreviewPicker
    items={ITEMS.map((item) => ({ ...item, disabled: disabled && item.id === 'beta' }))}
    tabs={[{ id: 'all', label: 'All' }]} tab="all" onTabChange={() => undefined}
    activeIndex={activeIndex} onActiveIndexChange={setActiveIndex}
    onConfirm={onConfirm} onClose={() => undefined} query="" scopeLabel="This request"
    listboxId="keyboard-mention-list" busy={busy}
  /></I18nProvider>;
}

afterEach(cleanup);

describe('MentionPreviewPicker keyboard confirmation', () => {
  it('confirms the preview reached by ArrowDown when DOM focus stays on the earlier option', () => {
    const onConfirm = vi.fn();
    render(<Picker onConfirm={onConfirm} />);
    const first = screen.getByRole('option', { name: /^Alpha\s*Skill$/ });
    act(() => { first.focus(); });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(screen.getByTestId('mention-preview-detail').getAttribute('data-resource-id')).toBe('beta');
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });

    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'beta' }));
  });

  it.each(['busy', 'disabled', 'composing'] as const)('does not confirm a preview while %s', (state) => {
    const onConfirm = vi.fn();
    render(<Picker onConfirm={onConfirm} busy={state === 'busy'} disabled={state === 'disabled'} />);
    const first = screen.getByRole('option', { name: /^Alpha\s*Skill$/ });
    act(() => { first.focus(); });
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(screen.getByTestId('mention-preview-detail').getAttribute('data-resource-id')).toBe('beta');
    fireEvent.keyDown(document.activeElement!, { key: 'Enter', isComposing: state === 'composing' });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it.each([['ArrowDown', 'alpha'], ['ArrowUp', 'beta']] as const)('shows a hint with no active row and %s enters at %s', (key, expected) => {
    const onConfirm = vi.fn();
    render(<Picker onConfirm={onConfirm} initialIndex={-1} />);
    expect(screen.queryByRole('option', { selected: true })).toBeNull();
    expect(screen.queryByTestId('mention-preview-use')).toBeNull();
    expect(screen.getByTestId('mention-preview-detail').textContent).toBe('Choose a resource to see its details.');
    fireEvent.keyDown(screen.getByTestId('mention-popover'), { key });
    expect(screen.getByTestId('mention-preview-detail').getAttribute('data-resource-id')).toBe(expected);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('keeps pointer row selection as a preview until the Use action', () => {
    const onConfirm = vi.fn();
    render(<Picker onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('option', { name: /^Beta\s*Skill$/ }));
    expect(screen.getByTestId('mention-preview-detail').getAttribute('data-resource-id')).toBe('beta');
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('mention-preview-use'));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'beta' }));
  });
});
