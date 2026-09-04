// @vitest-environment jsdom

/**
 * Long provider errors must collapse to a leading preview with a real,
 * keyboard-operable toggle; short errors must stay plain text with no toggle.
 * Presentation only — nothing here suppresses, retries, or rewrites an error.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CollapsibleErrorText,
  ERROR_PREVIEW_CHAR_BUDGET,
  errorPreviewText,
  overflowsErrorPreview,
} from '../../src/components/CollapsibleErrorText';

vi.mock('../../src/i18n', () => ({
  useT: () => (key: string) => key,
}));

afterEach(cleanup);

const LONG_ERROR = `API Error: 400 ${'x'.repeat(ERROR_PREVIEW_CHAR_BUDGET)} TAIL_MARKER`;
const SHORT_ERROR = 'API Error: 401 Unauthorized';

describe('overflowsErrorPreview', () => {
  it('is false for text inside the character and line budget', () => {
    expect(overflowsErrorPreview(SHORT_ERROR)).toBe(false);
    expect(overflowsErrorPreview('line one\nline two')).toBe(false);
  });

  it('is true past the character budget or the line budget', () => {
    expect(overflowsErrorPreview(LONG_ERROR)).toBe(true);
    expect(overflowsErrorPreview('one\ntwo\nthree')).toBe(true);
  });

  it('clips the preview to the leading portion with an ellipsis', () => {
    const preview = errorPreviewText(LONG_ERROR);
    expect(preview.startsWith('API Error: 400')).toBe(true);
    expect(preview.endsWith('…')).toBe(true);
    expect(preview).not.toContain('TAIL_MARKER');
    expect(preview.length).toBeLessThanOrEqual(ERROR_PREVIEW_CHAR_BUDGET + 1);
  });
});

describe('CollapsibleErrorText', () => {
  it('renders a long error collapsed behind an aria-expanded toggle', () => {
    render(<CollapsibleErrorText text={LONG_ERROR} />);

    const toggle = screen.getByRole('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('API Error: 400');
    expect(toggle.textContent).not.toContain('TAIL_MARKER');
    expect(toggle.textContent).toContain('chat.errorTextExpand');
  });

  it('expands to the full text on click and collapses again', () => {
    render(<CollapsibleErrorText text={LONG_ERROR} />);
    const toggle = screen.getByRole('button');

    const body = document.getElementById(toggle.getAttribute('aria-controls')!);
    expect(body).not.toBeNull();
    // Full text stays mounted and selectable; only the disclosure state flips.
    expect(body!.textContent).toContain('TAIL_MARKER');
    expect(body!.getAttribute('data-expanded')).toBe('false');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(body!.getAttribute('data-expanded')).toBe('true');
    expect(toggle.textContent).toContain('chat.errorTextCollapse');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(body!.getAttribute('data-expanded')).toBe('false');
  });

  it('gives a short error no toggle and no truncation', () => {
    render(<CollapsibleErrorText text={SHORT_ERROR} />);

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(SHORT_ERROR)).toBeTruthy();
  });

  it('keeps URLs in the expanded body clickable', () => {
    render(
      <CollapsibleErrorText
        text={`${'y'.repeat(ERROR_PREVIEW_CHAR_BUDGET)} see https://example.com/docs.`}
      />,
    );

    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://example.com/docs');
  });
});
