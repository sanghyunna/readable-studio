// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuestionsPanel } from '../../src/components/QuestionsPanel';

const css = readFileSync(resolve(__dirname, '../../src/components/QuestionsPanel.css'), 'utf8');
let stylesheet: HTMLStyleElement;
beforeEach(() => {
  stylesheet = document.createElement('style');
  stylesheet.textContent = css;
  document.head.append(stylesheet);
});
afterEach(() => {
  cleanup();
  stylesheet.remove();
});

function mount(status: 'pending' | 'failed' | 'ready', queued = false) {
  render(<QuestionsPanel
    form={{ id: 'footer', title: 'Intake', questions: [{ id: 'notes', label: 'Notes', type: 'text' }] }}
    interactive generating={false} runHydrationStatus={status} submissionQueued={queued}
    onSubmit={vi.fn()} onRetryRunHydration={vi.fn()}
  />);
  return screen.getByRole('status', { hidden: true }).parentElement!;
}

function expectSeparateStatusRow(footer: HTMLElement) {
  const status = screen.getByRole('status');
  expect(getComputedStyle(footer).flexWrap).toBe('wrap');
  expect(getComputedStyle(footer).flexShrink).toBe('0');
  expect(getComputedStyle(status).flexBasis).toBe('100%');
  expect(getComputedStyle(status).flexShrink).toBe('0');
}

describe('Questions footer layout ownership', () => {
  // These are computed-style contracts, not simulated browser geometry:
  // jsdom does not implement layout or elementFromPoint.
  it.each(['pending', 'failed', 'queued'] as const)('reserves a complete row for %s status', state => {
    const footer = mount(state === 'queued' ? 'ready' : state, state === 'queued');
    expectSeparateStatusRow(footer);
    for (const button of footer.querySelectorAll('button')) {
      expect(getComputedStyle(button).maxWidth).toBe('100%');
      expect(getComputedStyle(button).whiteSpace).toBe('normal');
    }
    expect(screen.getByRole('textbox')).toHaveProperty('disabled', false);
  });

  it('does not reserve an empty status row after hydration', () => {
    mount('ready');
    expect(getComputedStyle(screen.getByRole('status', { hidden: true })).display).toBe('none');
  });

  it('rejects the non-wrapping row that squeezes status between the actions', () => {
    const footer = mount('pending');
    footer.style.flexWrap = 'nowrap';
    expect(() => expectSeparateStatusRow(footer)).toThrow();
  });
});
