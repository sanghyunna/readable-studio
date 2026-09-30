// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileOpsSummary } from '../../src/components/FileOpsSummary';
import type { FileOpEntry } from '../../src/runtime/file-ops';

function entry(partial: Partial<FileOpEntry> & { path: string }): FileOpEntry {
  return {
    fullPath: `/repo/${partial.path}`,
    ops: ['write'],
    opCounts: { read: 0, write: 1, edit: 0 },
    total: 1,
    status: 'done',
    ...partial,
  };
}

describe('FileOpsSummary', () => {
  afterEach(() => cleanup());

  it('renders nothing when there are no entries', () => {
    const { container } = render(
      <FileOpsSummary entries={[]} streaming={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('does not claim read-only, pending, or failed operations produced files', () => {
    const { container } = render(
      <FileOpsSummary
        entries={[
          entry({ path: 'report.html', ops: ['read'], opCounts: { read: 2, write: 0, edit: 0 }, total: 2 }),
          entry({ path: 'pending.html', status: 'running' }),
          entry({ path: 'failed.html', status: 'error' }),
        ]}
        streaming={false}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('starts collapsed while streaming and surfaces only completed mutation totals', () => {
    render(
      <FileOpsSummary
        entries={[
          entry({ path: 'a.ts', ops: ['read'], opCounts: { read: 2, write: 0, edit: 0 }, total: 2 }),
          entry({ path: 'b.ts', ops: ['write'], opCounts: { read: 0, write: 1, edit: 0 } }),
          entry({ path: 'c.ts', ops: ['edit'], opCounts: { read: 0, write: 0, edit: 3 }, total: 3 }),
        ]}
        streaming
      />,
    );

    expect(screen.getByText(/Write 1/)).toBeTruthy();
    expect(screen.getByText(/Edit 3/)).toBeTruthy();
    expect(screen.queryByText(/Read 2/)).toBeNull();
    fireEvent.click(screen.getByTestId('file-ops-toggle'));
    expect(screen.queryByTestId('file-ops-row-a.ts')).toBeNull();
    fireEvent.click(screen.getByTestId('file-ops-toggle'));
    // While streaming we collapse the file list so the running pill stays compact.
    expect(screen.queryByTestId('file-ops-row-a.ts')).toBeNull();
    const toggle = screen.getByTestId('file-ops-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens by default once the run is no longer streaming and lists every touched file', () => {
    render(
      <FileOpsSummary
        entries={[
          entry({ path: 'a.ts', ops: ['read', 'edit'], opCounts: { read: 1, write: 0, edit: 1 }, total: 2 }),
          entry({ path: 'b.ts', ops: ['write'], opCounts: { read: 0, write: 1, edit: 0 } }),
        ]}
        streaming={false}
      />,
    );

    expect(screen.getByTestId('file-ops-row-a.ts')).toBeTruthy();
    expect(screen.getByTestId('file-ops-row-b.ts')).toBeTruthy();
    expect(screen.getByTestId('file-ops-toggle').getAttribute('aria-expanded')).toBe('true');
  });

  it('reopens once streaming flips to false unless the user collapsed it manually', () => {
    const { rerender } = render(
      <FileOpsSummary
        entries={[entry({ path: 'a.ts' })]}
        streaming
      />,
    );
    expect(screen.getByTestId('file-ops-toggle').getAttribute('aria-expanded')).toBe('false');

    rerender(
      <FileOpsSummary
        entries={[entry({ path: 'a.ts' })]}
        streaming={false}
      />,
    );
    expect(screen.getByTestId('file-ops-toggle').getAttribute('aria-expanded')).toBe('true');
  });

  it('shows the open button only for files that are present in the project file set', () => {
    const onRequestOpenFile = vi.fn();
    render(
      <FileOpsSummary
        entries={[
          entry({ path: 'a.ts' }),
          entry({ path: 'missing.ts' }),
        ]}
        streaming={false}
        projectFileNames={new Set(['a.ts'])}
        onRequestOpenFile={onRequestOpenFile}
      />,
    );

    expect(screen.getByTestId('file-ops-row-open-a.ts')).toBeTruthy();
    expect(screen.queryByTestId('file-ops-row-open-missing.ts')).toBeNull();

    fireEvent.click(screen.getByTestId('file-ops-row-open-a.ts'));
    expect(onRequestOpenFile).toHaveBeenCalledWith('a.ts');
  });

  it('keeps completed files while excluding pending and failed mutations', () => {
    render(
      <FileOpsSummary
        entries={[
          entry({ path: 'saved.ts' }),
          entry({ path: 'pending.ts', status: 'running' }),
          entry({ path: 'broken.ts', status: 'error' }),
        ]}
        streaming
      />,
    );
    fireEvent.click(screen.getByTestId('file-ops-toggle'));

    expect(screen.getByTestId('file-ops-row-saved.ts')).toBeTruthy();
    expect(screen.queryByTestId('file-ops-row-pending.ts')).toBeNull();
    expect(screen.queryByTestId('file-ops-row-broken.ts')).toBeNull();
  });
});
