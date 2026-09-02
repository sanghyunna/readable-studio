// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Switch, ToggleButton, ToggleCard } from '../src';

afterEach(() => {
  cleanup();
});

describe('Switch', () => {
  it('exposes switch semantics and requests one controlled change when activated', () => {
    // Given
    const onCheckedChange = vi.fn();
    render(
      <Switch checked={false} onCheckedChange={onCheckedChange} stateText="Off">
        Sync drafts
      </Switch>,
    );

    // When
    const control = screen.getByRole('switch', { name: /Sync drafts\s*Off/ });
    fireEvent.click(control);

    // Then
    expect(control.getAttribute('type')).toBe('button');
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(control.getAttribute('data-state')).toBe('off');
    expect(control.querySelector('input')).toBeNull();
    expect(screen.getByText('Off')).toBeTruthy();
    expect(onCheckedChange).toHaveBeenCalledTimes(1);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('ignores activation and exposes busy disabled semantics when pending', () => {
    // Given
    const onCheckedChange = vi.fn();
    render(
      <Switch checked pending onCheckedChange={onCheckedChange} aria-label="Sync drafts" />,
    );

    // When
    const control = screen.getByRole('switch', { name: 'Sync drafts' });
    fireEvent.click(control);

    // Then
    expect(control.getAttribute('aria-busy')).toBe('true');
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(control.getAttribute('data-state')).toBe('on');
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('uses native disabled and focus behavior', () => {
    // Given
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} disabled onCheckedChange={onCheckedChange} aria-label="Sync" />);

    // When
    const control = screen.getByRole('switch', { name: 'Sync' });
    control.focus();
    fireEvent.click(control);

    // Then
    expect(control.hasAttribute('disabled')).toBe(true);
    expect(document.activeElement).not.toBe(control);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});

describe('ToggleButton', () => {
  it('supports icon and text content with pressed semantics', () => {
    // Given
    const onPressedChange = vi.fn();
    render(
      <ToggleButton pressed={false} onPressedChange={onPressedChange}>
        <span aria-hidden="true">A</span>
        Align left
      </ToggleButton>,
    );

    // When
    const control = screen.getByRole('button', { name: 'Align left' });
    fireEvent.click(control);

    // Then
    expect(control.getAttribute('type')).toBe('button');
    expect(control.getAttribute('aria-pressed')).toBe('false');
    expect(control.getAttribute('data-state')).toBe('off');
    expect(onPressedChange).toHaveBeenCalledTimes(1);
    expect(onPressedChange).toHaveBeenCalledWith(true);
  });

  it('ignores activation while pending', () => {
    // Given
    const onPressedChange = vi.fn();
    render(
      <ToggleButton pressed pending onPressedChange={onPressedChange}>
        Align left
      </ToggleButton>,
    );

    // When
    const control = screen.getByRole('button', { name: 'Align left' });
    fireEvent.click(control);

    // Then
    expect(control.getAttribute('aria-busy')).toBe('true');
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(control.getAttribute('data-state')).toBe('on');
    expect(onPressedChange).not.toHaveBeenCalled();
  });
});

describe('ToggleCard', () => {
  it('makes the full native button surface the selected control without nested inputs', () => {
    // Given
    const onPressedChange = vi.fn();
    render(
      <ToggleCard pressed onPressedChange={onPressedChange}>
        <strong>Editorial</strong>
        <span>Quiet reading layout</span>
      </ToggleCard>,
    );

    // When
    const control = screen.getByRole('button', { name: /Editorial\s*Quiet reading layout/ });
    control.focus();
    fireEvent.click(control);

    // Then
    expect(control.getAttribute('type')).toBe('button');
    expect(control.getAttribute('aria-pressed')).toBe('true');
    expect(control.getAttribute('data-state')).toBe('on');
    expect(document.activeElement).toBe(control);
    expect(control.querySelector('input')).toBeNull();
    expect(onPressedChange).toHaveBeenCalledTimes(1);
    expect(onPressedChange).toHaveBeenCalledWith(false);
  });

  it('uses native disabled behavior', () => {
    // Given
    const onPressedChange = vi.fn();
    render(
      <ToggleCard pressed={false} disabled onPressedChange={onPressedChange}>
        Editorial
      </ToggleCard>,
    );

    // When
    const control = screen.getByRole('button', { name: 'Editorial' });
    fireEvent.click(control);

    // Then
    expect(control.hasAttribute('disabled')).toBe(true);
    expect(onPressedChange).not.toHaveBeenCalled();
  });
});
