// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const folderImport = vi.hoisted(() => ({
  available: true,
  clearError: vi.fn(),
  error: null,
  importing: false,
  openFolder: vi.fn(),
}));

vi.mock('../../src/components/useOpenFolderImport', () => ({
  useOpenFolderImport: () => folderImport,
}));

import { NewProjectModal } from '../../src/components/NewProjectModal';
import type { DesignSystemSummary, SkillSummary } from '../../src/types';

const skills: SkillSummary[] = [
  {
    id: 'prototype-skill',
    name: 'Prototype',
    description: 'Build prototypes',
    mode: 'prototype',
    surface: 'web',
    previewType: 'html',
    designSystemRequired: true,
    defaultFor: ['prototype'],
    triggers: [],
    upstream: null,
    hasBody: true,
    examplePrompt: 'Build a prototype.',
    aggregatesExamples: false,
  },
];

const designSystems: DesignSystemSummary[] = [];

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  folderImport.available = true;
  folderImport.openFolder.mockReset();
});

describe('New Project folder entry', () => {
  it('calls folder import once when the current folder control is clicked', async () => {
    // Given: the live New Project modal with folder import available.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <NewProjectModal
        open
        skills={skills}
        designSystems={designSystems}
        defaultDesignSystemId={null}
        templates={[]}
        onCreate={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // When: the user selects the stable current folder import control.
    fireEvent.click(await screen.findByTestId('new-project-import-folder'));

    // Then: the panel delegates to the folder-import hook exactly once.
    expect(folderImport.openFolder).toHaveBeenCalledTimes(1);
  });

  it('does not render a folder control when folder import is unavailable', () => {
    // Given: the folder-import hook reports no available import capability.
    folderImport.available = false;

    // When: the live New Project modal renders.
    render(
      <NewProjectModal
        open
        skills={skills}
        designSystems={designSystems}
        defaultDesignSystemId={null}
        templates={[]}
        onCreate={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // Then: no non-actionable folder control is exposed.
    expect(screen.queryByTestId('new-project-import-folder')).toBeNull();
  });
});
