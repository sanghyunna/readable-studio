// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesignSystemSummary } from '@readable-studio/contracts';

import { DesignSystemsSection } from '../../src/components/DesignSystemsSection';
import {
  fetchDesignSystems,
  importLocalDesignSystem,
  updateDesignSystemDraft,
} from '../../src/providers/registry';
import type { AppConfig } from '../../src/types';

const editable: DesignSystemSummary = {
  id: 'user:acme',
  title: 'Acme Design System',
  category: 'Custom',
  summary: 'Internal product system.',
  surface: 'web',
  source: 'user',
  status: 'draft',
  isEditable: true,
  updatedAt: '2026-05-13T03:19:00.000Z',
};

const builtIn: DesignSystemSummary = {
  id: 'linear',
  title: 'Linear',
  category: 'Productivity & SaaS',
  summary: 'Quiet issue-tracker system.',
  surface: 'web',
  source: 'built-in',
  status: 'published',
  isEditable: false,
};

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    fetchDesignSystems: vi.fn(async () => [editable, builtIn]),
    importLocalDesignSystem: vi.fn(async () => ({ designSystem: editable })),
    updateDesignSystemDraft: vi.fn(async () => ({ ...editable, title: 'Acme v2', body: '' })),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const cfg = { disabledDesignSystems: [] } as unknown as AppConfig;

describe('DesignSystemsSection selection controls', () => {
  it('submits import craft selections from semantic toggle buttons', async () => {
    render(<DesignSystemsSection cfg={cfg} setCfg={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add design system' }));
    const color = screen.getByRole('button', { name: 'Color' });
    const accessibility = screen.getByRole('button', { name: 'Accessibility' });

    expect(color.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(color);
    fireEvent.click(accessibility);
    expect(color.getAttribute('aria-pressed')).toBe('true');

    fireEvent.change(screen.getByPlaceholderText('/path/to/project'), {
      target: { value: '/work/acme' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import from project' }));

    await waitFor(() => {
      expect(vi.mocked(importLocalDesignSystem)).toHaveBeenCalledWith({
        baseDir: '/work/acme',
        importMode: 'hybrid',
        craftApplies: ['color', 'accessibility-baseline'],
      });
    });
  });

  it('persists home-gallery visibility from a semantic switch', async () => {
    const setCfg = vi.fn();
    render(<DesignSystemsSection cfg={cfg} setCfg={setCfg} />);

    const switches = await screen.findAllByRole('switch', { name: 'Show in home gallery' });
    const firstSwitch = switches.at(0);
    if (!firstSwitch) throw new TypeError('Expected a design-system gallery switch');
    expect(firstSwitch.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(firstSwitch);

    const update = setCfg.mock.calls[0]?.[0];
    if (typeof update !== 'function') throw new TypeError('Expected a config updater');
    expect(update(cfg)).toEqual({ ...cfg, disabledDesignSystems: ['user:acme'] });
  });

  it('exposes gallery visibility through checked switches with accessible names', async () => {
    render(<DesignSystemsSection cfg={cfg} setCfg={() => {}} />);

    const switches = await screen.findAllByRole('switch', { name: 'Show in home gallery' });
    expect(switches.length).toBeGreaterThan(0);
    for (const control of switches) {
      expect(control.getAttribute('aria-checked')).toBe('true');
    }
  });
});

describe('DesignSystemsSection rename (issue #2811)', () => {
  it('renames an editable design system from Settings', async () => {
    render(<DesignSystemsSection cfg={cfg} setCfg={() => {}} />);

    const renameButton = await screen.findByRole('button', {
      name: /Rename Acme Design System/i,
    });
    fireEvent.click(renameButton);

    const input = screen.getByDisplayValue('Acme Design System');
    fireEvent.change(input, { target: { value: 'Acme v2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      expect(vi.mocked(updateDesignSystemDraft)).toHaveBeenCalledWith('user:acme', {
        title: 'Acme v2',
      });
    });
  });

  it('notifies the parent after renaming a design system without changing its id', async () => {
    const onDesignSystemsChanged = vi.fn();
    render(
      <DesignSystemsSection
        cfg={cfg}
        setCfg={() => {}}
        onDesignSystemsChanged={onDesignSystemsChanged}
      />,
    );

    const renameButton = await screen.findByRole('button', {
      name: /Rename Acme Design System/i,
    });
    fireEvent.click(renameButton);

    const input = screen.getByDisplayValue('Acme Design System');
    fireEvent.change(input, { target: { value: 'Acme v2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      expect(onDesignSystemsChanged).toHaveBeenCalledWith('user:acme');
    });
  });

  it('keeps the rename modal open with the typed title when the update fails', async () => {
    vi.mocked(updateDesignSystemDraft).mockResolvedValueOnce(null);
    render(<DesignSystemsSection cfg={cfg} setCfg={() => {}} />);

    const renameButton = await screen.findByRole('button', {
      name: /Rename Acme Design System/i,
    });
    fireEvent.click(renameButton);

    const input = screen.getByDisplayValue('Acme Design System');
    fireEvent.change(input, { target: { value: 'Acme v2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    // A failed update must not close the modal; the typed title stays for retry.
    await screen.findByText(/Rename failed/i);
    expect(screen.getByDisplayValue('Acme v2')).toBeTruthy();
  });

  it('ignores a stale rename completion when a newer rename session is open', async () => {
    const editableB: DesignSystemSummary = { ...editable, id: 'user:beta', title: 'Beta System' };
    vi.mocked(fetchDesignSystems).mockResolvedValueOnce([editable, editableB, builtIn]);
    let resolveFirst!: (value: null) => void;
    vi.mocked(updateDesignSystemDraft).mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          resolveFirst = resolve;
        }),
    );

    render(<DesignSystemsSection cfg={cfg} setCfg={() => {}} />);

    // Session 1: rename Acme and submit; the PATCH stays pending.
    fireEvent.click(await screen.findByRole('button', { name: /Rename Acme Design System/i }));
    fireEvent.change(screen.getByDisplayValue('Acme Design System'), { target: { value: 'Acme v2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    // Cancel Acme and open a rename for Beta before the first PATCH resolves.
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Rename Beta System/i }));
    expect(screen.getByDisplayValue('Beta System')).toBeTruthy();

    // The stale Acme request now fails; it must not touch Beta's modal.
    resolveFirst(null);
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByDisplayValue('Beta System')).toBeTruthy();
    expect(screen.queryByText(/Rename failed/i)).toBeNull();
  });

  it('offers no Rename for built-in (read-only) design systems', async () => {
    render(<DesignSystemsSection cfg={cfg} setCfg={() => {}} />);
    await screen.findByText('Linear');
    expect(screen.queryByRole('button', { name: /Rename Linear/i })).toBeNull();
  });
});
