// @vitest-environment jsdom
//
// Creation is a composer send, not a settings transaction. These tests pin the
// three claims that re-expression rests on:
//   1. a project is created from the composer without the modal ever opening,
//   2. every control relocated off the modal main path is still reachable,
//   3. a settings value that used to be frozen at create time is now editable
//      after creation through a Brief chip.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@readable-studio/host', () => ({
  isReadableStudioHostAvailable: () => true,
  pickAndImportHostProject: vi.fn(),
  pickHostWorkingDir: vi.fn(),
}));

import { NewProjectAdvanced } from '../../src/components/NewProjectAdvanced';
import { BriefCard } from '../../src/components/BriefCard';
import {
  applyBriefAssumptionToMetadata,
  creationBriefAssumptions,
} from '../../src/components/home-hero/creation-brief';
import { mergeBriefAssumptions, type ProjectBrief } from '../../src/components/brief-state';
import type {
  DesignSystemSummary,
  ProjectMetadata,
  ProjectTemplate,
  SkillSummary,
} from '../../src/types';

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

const designSystems: DesignSystemSummary[] = [
  {
    id: 'clay',
    title: 'Clay',
    summary: 'Friendly tactile product UI.',
    category: 'Product',
    swatches: ['#f4efe7', '#25211d'],
  },
];

const templates: ProjectTemplate[] = [
  {
    id: 'tmpl-landing',
    name: 'Landing Page',
    description: 'A saved landing page starter.',
    files: [{ name: 'prototype/App.jsx', content: '' }],
    createdAt: 1714867200000,
  },
];

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

const originalResizeObserver = globalThis.ResizeObserver;
const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = originalResizeObserver;
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

function renderAdvanced(overrides: Partial<Parameters<typeof NewProjectAdvanced>[0]> = {}) {
  const onCreate = overrides.onCreate ?? vi.fn();
  render(
    <NewProjectAdvanced
      skills={skills}
      designSystems={designSystems}
      defaultDesignSystemId={null}
      templates={templates}
      onCreate={onCreate}
      {...overrides}
    />,
  );
  return { onCreate };
}

describe('creation is a composer send, not a settings transaction', () => {
  it('seeds the settings the modal used to freeze as correctable brief assumptions', () => {
    const assumptions = creationBriefAssumptions('prototype', { kind: 'prototype' });
    const ids = assumptions.map((item) => item.id);

    expect(ids).toContain('fidelity');
    expect(ids).toContain('platformTargets');
    expect(ids).toContain('companionSurfaces');

    // The default carries through with honest provenance: the app assumed it,
    // the user did not state it.
    const fidelity = assumptions.find((item) => item.id === 'fidelity');
    expect(fidelity?.value).toBe('high-fidelity');
    expect(fidelity?.provenance).toBe('default');
  });

  it('keeps per-kind settings scoped exactly as the modal tabs were', () => {
    const deck = creationBriefAssumptions('deck', { kind: 'deck' }).map((i) => i.id);
    const template = creationBriefAssumptions('template', { kind: 'template' }).map((i) => i.id);

    // Speaker notes were the deck tab only; animations were the template tab only.
    expect(deck).toContain('speakerNotes');
    expect(deck).not.toContain('animations');
    expect(template).toContain('animations');
    expect(template).not.toContain('speakerNotes');
  });

  it('marks an explicitly chosen value as stated rather than assumed', () => {
    const assumptions = creationBriefAssumptions('prototype', {
      kind: 'prototype',
      fidelity: 'wireframe',
    });
    const fidelity = assumptions.find((item) => item.id === 'fidelity');

    expect(fidelity?.value).toBe('wireframe');
    expect(fidelity?.provenance).toBe('stated');
  });
});

describe('post-creation chip edits change values that used to be frozen', () => {
  it('writes a corrected fidelity back onto project metadata', () => {
    const created: ProjectMetadata = { kind: 'prototype', fidelity: 'high-fidelity' };
    const corrected = applyBriefAssumptionToMetadata(created, {
      id: 'fidelity',
      label: 'Fidelity',
      value: 'wireframe',
      provenance: 'stated',
    });

    // Before re-expression this value was written once at create time and no UI
    // could ever change it again.
    expect(created.fidelity).toBe('high-fidelity');
    expect(corrected.fidelity).toBe('wireframe');
  });

  it('maps companion surfaces back onto both metadata booleans', () => {
    const corrected = applyBriefAssumptionToMetadata(
      { kind: 'prototype', includeLandingPage: false, includeOsWidgets: false },
      {
        id: 'companionSurfaces',
        label: 'Companion surfaces',
        value: ['landing'],
        provenance: 'stated',
      },
    );

    expect(corrected.includeLandingPage).toBe(true);
    expect(corrected.includeOsWidgets).toBe(false);
  });

  it('drives a real fidelity correction through the mounted Brief card', async () => {
    const seeded = creationBriefAssumptions('prototype', { kind: 'prototype' });
    let brief: ProjectBrief = mergeBriefAssumptions(null, seeded, 1);
    const onSteer = vi.fn();
    const onChange = vi.fn((next: ProjectBrief) => {
      brief = next;
    });

    render(<BriefCard brief={brief} onChange={onChange} onSteer={onSteer} />);

    fireEvent.click(screen.getByRole('listitem', { name: /Fidelity/i }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Wireframe' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply correction' }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());

    const next = brief.assumptions.find((item) => item.id === 'fidelity');
    expect(next?.value).toBe('wireframe');
    expect(next?.provenance).toBe('stated');
    // The correction also steers work already in flight.
    expect(onSteer).toHaveBeenCalledWith(expect.stringContaining('[brief correction — fidelity]'));

    // And it lands on metadata, which is the capability that did not exist before.
    expect(applyBriefAssumptionToMetadata({ kind: 'prototype' }, next!).fidelity).toBe('wireframe');
  });
});

describe('relocated pre-creation controls stay reachable', () => {
  it('keeps the disclosure closed so it never gates the main creation path', () => {
    renderAdvanced();

    expect(screen.getByTestId('new-project-advanced-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('new-project-advanced-body')).toBeNull();
    // Nothing on the main path renders a create form.
    expect(screen.queryByTestId('create-project')).toBeNull();
  });

  it('reveals the full creation stack for power users when opened', () => {
    renderAdvanced({
      onImportClaudeDesign: vi.fn(),
      onImportFolderResponse: vi.fn(),
    });

    fireEvent.click(screen.getByTestId('new-project-advanced-toggle'));

    // The working-directory picker, template picker and imports are the
    // genuinely pre-creation controls this disclosure exists to host.
    expect(screen.getByTestId('new-project-panel')).toBeTruthy();
    expect(screen.getByTestId('create-project')).toBeTruthy();
    expect(screen.getByTestId('new-project-import-folder')).toBeTruthy();
    expect(screen.getByTestId('new-project-import-claude-zip')).toBeTruthy();
    expect(screen.getByTestId('new-project-name')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'From template' })).toBeTruthy();
    // The working-directory picker is present on the main tab.
    expect(document.querySelector('.newproj-working-dir')).toBeTruthy();

    // Full stack, not a trimmed subset: the settings pickers are all here too.
    expect(screen.getByTestId('newproj-mode-picker')).toBeTruthy();
    expect(screen.getByTestId('new-project-name')).toBeTruthy();
  });

  it('keeps the design-system picker off the main creation path, where the hero owns it', () => {
    // Closed disclosure == the main path. No second picker for a value the
    // hero already carries.
    renderAdvanced();
    expect(screen.queryByTestId('design-system-trigger')).toBeNull();
  });

  it('still carries the default design system into the payload while the picker is hidden', async () => {
    const onCreate = vi.fn().mockResolvedValue(true);
    render(
      <NewProjectAdvanced
        skills={skills}
        designSystems={designSystems}
        defaultDesignSystemId="clay"
        templates={templates}
        onCreate={onCreate}
      />,
    );

    fireEvent.click(screen.getByTestId('new-project-advanced-toggle'));
    fireEvent.click(screen.getByTestId('create-project'));

    // Hiding a duplicate control must never silently drop the value it carried.
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ designSystemId: 'clay' }),
      );
    });
  });

  it('still offers the design-system picker inside the full Advanced stack', () => {
    renderAdvanced();
    fireEvent.click(screen.getByTestId('new-project-advanced-toggle'));

    // Power users who open the disclosure lose nothing, including multi-select.
    expect(screen.getByTestId('design-system-trigger')).toBeTruthy();
  });

  it('opens directly on the template tab when the template chip deep-links it', async () => {
    renderAdvanced({ requestedTab: 'template' });

    await waitFor(() => {
      expect(screen.getByTestId('new-project-advanced-body')).toBeTruthy();
    });
    expect(
      screen.getByRole('tab', { name: 'From template' }).getAttribute('aria-selected'),
    ).toBe('true');
    // The template picker itself, not a one-click direct starter.
    expect(screen.getByText('Landing Page')).toBeTruthy();
  });

  it('still creates through the disclosure and collapses on success', async () => {
    const onCreate = vi.fn().mockResolvedValue(true);
    renderAdvanced({ onCreate });

    fireEvent.click(screen.getByTestId('new-project-advanced-toggle'));
    fireEvent.click(screen.getByTestId('create-project'));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(screen.queryByTestId('new-project-advanced-body')).toBeNull();
    });
  });

  it('surfaces a create failure without collapsing the disclosure', async () => {
    const onCreate = vi.fn().mockResolvedValue(false);
    renderAdvanced({ onCreate });

    fireEvent.click(screen.getByTestId('new-project-advanced-toggle'));
    fireEvent.click(screen.getByTestId('create-project'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not create project');
    expect(screen.getByTestId('new-project-advanced-body')).toBeTruthy();
  });
});
