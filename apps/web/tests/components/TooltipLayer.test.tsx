// @vitest-environment jsdom

import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProjectRail } from '../../src/components/ProjectRail';
import { TooltipLayer } from '../../src/components/TooltipLayer';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('TooltipLayer', () => {
  it('marks every shared rail toggle as eligible while preserving expanded semantics', () => {
    for (const [surface, expanded] of [
      ['hub', false],
      ['hub', true],
      ['workspace', false],
      ['workspace', true],
    ] as const) {
      const toggleTestId = `${surface}-${expanded ? 'expanded' : 'collapsed'}-toggle`;
      const onToggle = vi.fn();
      const view = render(
        <>
          <div id="app-window-chrome-rail-toggle" />
          <ProjectRail
            surface={surface}
            expanded={expanded}
            ariaLabel={`${surface} rail`}
            className="rail"
            headClassName="rail-head"
            toggleClassName="rail-toggle"
            toggleLabel={expanded ? 'Collapse rail' : 'Expand rail'}
            toggleTestId={toggleTestId}
            testId={`${surface}-rail`}
            onToggle={onToggle}
            header={<span>Brand</span>}
          >
            <span>Content</span>
          </ProjectRail>
        </>,
      );

      const toggle = screen.getByTestId(toggleTestId);
      expect(toggle.parentElement?.id).toBe('app-window-chrome-rail-toggle');
      expect(toggle.getAttribute('aria-expanded')).toBe(String(expanded));
      expect(toggle.hasAttribute('data-tooltip-allow-expanded')).toBe(true);
      fireEvent.click(toggle);
      expect(onToggle).toHaveBeenCalledTimes(1);
      view.unmount();
    }
  });

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

  it('keeps tooltips available for an expanded trigger that explicitly opts in', () => {
    vi.useFakeTimers();
    render(
      <>
        <button
          type="button"
          className="readable-tooltip"
          data-tooltip="Collapse rail"
          data-tooltip-allow-expanded=""
          aria-expanded="true"
        >
          Collapse rail
        </button>
        <TooltipLayer />
      </>,
    );

    const button = screen.getByRole('button', { name: 'Collapse rail' });
    fireEvent.pointerOver(button);
    act(() => vi.advanceTimersByTime(350));
    expect(screen.getByRole('tooltip').textContent).toBe('Collapse rail');

    fireEvent.pointerOut(button);
    fireEvent.keyDown(document, { key: 'Tab' });
    fireEvent.focusIn(button);
    expect(screen.getByRole('tooltip').textContent).toBe('Collapse rail');
  });

  it('dismisses a tooltip when a default popover trigger expands under the pointer', async () => {
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
