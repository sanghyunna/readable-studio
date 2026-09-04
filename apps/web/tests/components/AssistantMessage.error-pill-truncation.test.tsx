// @vitest-environment jsdom

/**
 * The per-message error status pill shares the run-failure card's truncation
 * seam: a long detail collapses behind a disclosure toggle, a short one stays
 * plain text. The pill's existing suppression rules and severity styling are
 * untouched.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AssistantMessage } from '../../src/components/AssistantMessage';
import { ERROR_PREVIEW_CHAR_BUDGET } from '../../src/components/CollapsibleErrorText';
import type { ChatMessage } from '../../src/types';

beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => store.clear(),
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => store.delete(k),
      setItem: (k: string, v: string) => store.set(k, v),
    },
  });
});

afterEach(cleanup);

const LONG_DETAIL = `API Error: 429 ${'q'.repeat(ERROR_PREVIEW_CHAR_BUDGET)} TAIL_MARKER`;

function failedMessage(detail: string): ChatMessage {
  return {
    id: 'msg-failed',
    role: 'assistant',
    content: '',
    runStatus: 'failed',
    startedAt: 1700000000,
    endedAt: 1700000005,
    events: [{ kind: 'status', label: 'error', detail }] as ChatMessage['events'],
    producedFiles: [],
  } as ChatMessage;
}

function pill(): HTMLElement {
  const el = document.querySelector('.status-pill.is-error');
  if (!el) throw new Error('missing error status pill');
  return el as HTMLElement;
}

describe('AssistantMessage error pill truncation', () => {
  it('collapses a long error detail behind a toggle and expands it in place', () => {
    render(
      <AssistantMessage
        message={failedMessage(LONG_DETAIL)}
        streaming={false}
        projectId="p1"
        errorCardOwnerId={null}
      />,
    );

    const toggle = pill().querySelector('button[aria-expanded]') as HTMLElement;
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('API Error: 429');
    expect(toggle.textContent).not.toContain('TAIL_MARKER');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const body = document.getElementById(toggle.getAttribute('aria-controls')!);
    expect(body?.textContent).toContain('TAIL_MARKER');
  });

  it('keeps a short error detail as plain text with no toggle', () => {
    render(
      <AssistantMessage
        message={failedMessage('boom-401')}
        streaming={false}
        projectId="p1"
        errorCardOwnerId={null}
      />,
    );

    expect(pill().querySelector('button[aria-expanded]')).toBeNull();
    expect(screen.getByText('boom-401')).toBeTruthy();
  });
});
