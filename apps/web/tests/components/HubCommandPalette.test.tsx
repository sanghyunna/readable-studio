// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HubCommandPalette, type HubPaletteEntry } from '../../src/components/hub/HubCommandPalette';

afterEach(cleanup);

const entries = (actions: Array<() => void>): HubPaletteEntry[] => [
  { id: 'project-p1', group: 'Projects', title: 'Quarterly report', kind: 'project', activate: actions[0]! },
  { id: 'session-s1', group: 'Sessions', title: 'Chart cleanup', meta: 'Quarterly report', kind: 'session', activate: actions[1]! },
  { id: 'destination-plugins', group: 'Navigate', title: 'Plugins', kind: 'destination', activate: actions[2]! },
];

describe('HubCommandPalette', () => {
  it('filters every entry kind and activates the keyboard selection', () => {
    const actions = [vi.fn<() => void>(), vi.fn<() => void>(), vi.fn<() => void>()];
    const onClose = vi.fn();
    render(<HubCommandPalette entries={entries(actions)} onClose={onClose} />);
    const input = screen.getByTestId('hub-palette-input');
    fireEvent.change(input, { target: { value: 'Plugins' } });
    expect(screen.getByTestId('hub-palette-item-destination-plugins')).toBeTruthy();
    expect(screen.queryByTestId('hub-palette-item-project-p1')).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(actions[2]).toHaveBeenCalledOnce();
  });

  it('moves with arrows and closes with Escape', () => {
    const actions = [vi.fn<() => void>(), vi.fn<() => void>(), vi.fn<() => void>()];
    const onClose = vi.fn();
    render(<HubCommandPalette entries={entries(actions)} onClose={onClose} />);
    const input = screen.getByTestId('hub-palette-input');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByTestId('hub-palette-item-session-s1').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
