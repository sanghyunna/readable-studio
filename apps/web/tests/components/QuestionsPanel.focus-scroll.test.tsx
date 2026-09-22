// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QuestionsPanel } from '../../src/components/QuestionsPanel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('prevents ancestor scrolling when the pending question card takes focus', () => {
  // Given a real card with no active text editor.
  const focus = vi.spyOn(HTMLElement.prototype, 'focus');
  // When it mounts pending.
  render(<QuestionsPanel form={{ id: 'focus', title: 'Choose', questions: [
    { id: 'choice', type: 'radio', label: 'Choice', options: [{ value: 'a', label: 'A' }] },
  ] }} interactive generating={false} onSubmit={() => undefined} />);
  // Then focus is retained without scrolling any ancestor.
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
});
