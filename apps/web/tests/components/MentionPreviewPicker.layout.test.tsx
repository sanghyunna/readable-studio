// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MentionPreviewPicker, type MentionPreviewItem } from '../../src/components/MentionPreviewPicker';

afterEach(cleanup);

it('keeps confirmation outside scrollable results and long preview content', () => {
  const item: MentionPreviewItem = {
    key: 'plugin:deck', id: 'deck', kind: 'plugin', title: 'Deck Builder',
    description: 'Detailed plugin instructions. '.repeat(100),
    kindLabel: 'Plugin', icon: 'sparkles', preview: <div>Full plugin preview</div>,
  };
  const onConfirm = vi.fn();
  render(<MentionPreviewPicker items={[item]} tabs={[{ id: 'all', label: 'All' }]} tab="all"
    onTabChange={vi.fn()} activeIndex={0} onActiveIndexChange={vi.fn()} onConfirm={onConfirm}
    onClose={vi.fn()} query="deck" scopeLabel="Use in project" listboxId="layout-options" />);

  const confirm = screen.getByTestId('mention-preview-use');
  // jsdom cannot measure clipping. This pins the scroll ownership; browser QA
  // checks the button's real viewport bounds at the constrained Home height.
  expect(screen.getByTestId('mention-preview-detail').contains(confirm)).toBe(false);
  expect(screen.getByRole('listbox').contains(confirm)).toBe(false);
  fireEvent.click(confirm);
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith(item);
});
