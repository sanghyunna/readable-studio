// @vitest-environment jsdom

// Two capabilities the removed New Project modal used to own, now living where
// their subject lives: deleting a saved template sits next to the Library's
// template list, and re-pointing a project at a folder sits in that project's
// Design Files toolbar.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';

import { DesignSystemsTab } from '../../src/components/DesignSystemsTab';
import { DesignFilesPanel } from '../../src/components/DesignFilesPanel';
import type { ProjectTemplate } from '../../src/types';

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    fetchDesignSystemShowcase: vi.fn(async () => null),
    updateDesignSystemDraft: vi.fn(async () => null),
    deleteDesignSystemDraft: vi.fn(async () => true),
  };
});

const originalIntersectionObserver = globalThis.IntersectionObserver;
class IdleIntersectionObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  globalThis.IntersectionObserver = IdleIntersectionObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.IntersectionObserver = originalIntersectionObserver;
});

const templates: ProjectTemplate[] = [
  { id: 'saved', name: 'Saved starter', description: '', files: [{ name: 'a.html', content: '' }], createdAt: 1 },
];

function openMyTemplates() {
  fireEvent.click(screen.getByRole('tab', { name: 'Template' }));
}

describe('Library: delete a saved template', () => {
  it('confirms, deletes through the App handler and closes on success', async () => {
    const onDeleteTemplate = vi.fn(async () => true);
    render(
      <DesignSystemsTab systems={[]} selectedId={null} onSelect={vi.fn()} onPreview={vi.fn()} templates={templates} onDeleteTemplate={onDeleteTemplate} />,
    );
    openMyTemplates();
    const row = screen.getByTestId('library-template-saved');
    expect(row.textContent).toContain('Saved starter');
    fireEvent.click(within(row).getByTestId('library-template-delete-saved'));
    const dialog = screen.getByRole('alertdialog');
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Delete template' })); });
    expect(onDeleteTemplate).toHaveBeenCalledExactlyOnceWith('saved');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('keeps the dialog open with an inline error when the daemon refuses', async () => {
    const onDeleteTemplate = vi.fn(async () => false);
    render(
      <DesignSystemsTab systems={[]} selectedId={null} onSelect={vi.fn()} onPreview={vi.fn()} templates={templates} onDeleteTemplate={onDeleteTemplate} />,
    );
    openMyTemplates();
    fireEvent.click(screen.getByTestId('library-template-delete-saved'));
    const dialog = screen.getByRole('alertdialog');
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Delete template' })); });
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    expect(within(dialog).getByRole('alert')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('renders no delete control when the host does not wire deletion', () => {
    render(
      <DesignSystemsTab systems={[]} selectedId={null} onSelect={vi.fn()} onPreview={vi.fn()} templates={templates} />,
    );
    openMyTemplates();
    expect(screen.getByTestId('library-template-saved')).toBeTruthy();
    expect(screen.queryByTestId('library-template-delete-saved')).toBeNull();
  });
});

function renderPanel(overrides: Partial<ComponentProps<typeof DesignFilesPanel>> = {}) {
  return render(
    <DesignFilesPanel
      projectId="test-project"
      files={[]}
      onRefreshFiles={vi.fn()}
      onOpenFile={vi.fn()}
      onRenameFile={vi.fn()}
      onDeleteFile={vi.fn()}
      onDeleteFiles={vi.fn()}
      onUpload={vi.fn()}
      onUploadFiles={vi.fn()}
      onPaste={vi.fn()}
      onNewSketch={vi.fn()}
      onClearUploadError={vi.fn()}
      {...overrides}
    />,
  );
}

describe('Workspace: per-project folder override', () => {
  it('exposes the project-folder control in the Design Files toolbar and calls the host', () => {
    const onChangeProjectFolder = vi.fn();
    renderPanel({ onChangeProjectFolder });
    const control = screen.getByTestId<HTMLButtonElement>('design-files-project-folder');
    expect(control.disabled).toBe(false);
    fireEvent.click(control);
    expect(onChangeProjectFolder).toHaveBeenCalledOnce();
  });

  it('locks the control while the switch is in flight and hides it when unwired', () => {
    const { unmount } = renderPanel({ onChangeProjectFolder: vi.fn(), projectFolderBusy: true });
    expect(screen.getByTestId<HTMLButtonElement>('design-files-project-folder').disabled).toBe(true);
    unmount();
    renderPanel();
    expect(screen.queryByTestId('design-files-project-folder')).toBeNull();
  });
});
