// @vitest-environment jsdom

import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TooltipLayer } from '../../src/components/TooltipLayer';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('TooltipLayer', () => {
  it('shows a pointer tooltip after exactly 350ms while keyboard focus remains immediate', () => {
    vi.useFakeTimers();
    render(
      <>
        <button type="button" className="readable-tooltip" data-tooltip="Settings">
          Settings
        </button>
        <TooltipLayer />
      </>,
    );

    const button = screen.getByRole('button', { name: 'Settings' });
    fireEvent.pointerOver(button);
    act(() => vi.advanceTimersByTime(349));
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('tooltip').textContent).toBe('Settings');
    expect(button.getAttribute('aria-describedby')).toBe('readable-tooltip-layer');

    fireEvent.pointerOut(button);
    fireEvent.keyDown(document, { key: 'Tab' });
    fireEvent.focusIn(button);
    expect(screen.getByRole('tooltip').textContent).toBe('Settings');
    vi.useRealTimers();
  });

  it('dismisses a hovered icon tooltip when the icon is activated', () => {
    vi.useFakeTimers();
    render(
      <>
        <button
          type="button"
          className="readable-tooltip"
          data-tooltip="Settings"
          title="Settings"
        >
          Settings
        </button>
        <TooltipLayer />
      </>,
    );

    const button = screen.getByRole('button', { name: 'Settings' });
    fireEvent.pointerOver(button);
    act(() => vi.advanceTimersByTime(350));

    expect(screen.getByRole('tooltip').textContent).toBe('Settings');

    fireEvent.pointerDown(button);
    fireEvent.focusIn(button);

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('dismisses a tooltip when the trigger expands under the pointer', async () => {
    vi.useFakeTimers();
    function ExpandingTrigger() {
      const [open, setOpen] = useState(false);
      return (
        <button
          type="button"
          className="readable-tooltip"
          data-tooltip="Design Agent mode"
          title="Design Agent mode"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          Design Agent
        </button>
      );
    }

    render(
      <>
        <ExpandingTrigger />
        <TooltipLayer />
      </>,
    );

    const button = screen.getByRole('button', { name: 'Design Agent' });
    fireEvent.pointerOver(button);
    act(() => vi.advanceTimersByTime(350));
    expect(screen.getByRole('tooltip').textContent).toBe('Design Agent mode');

    fireEvent.click(button);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
