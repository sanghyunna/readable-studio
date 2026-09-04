// Creation-time brief seeding.
//
// The New project modal used to freeze fidelity / platform targets / companion
// surfaces / speaker notes / animations into `project.metadata` at create time,
// where nothing could ever change them again. Creation is now a composer send,
// so those same settings are seeded as *brief assumptions* carrying their
// current default. The Brief card then renders them as correctable chips, which
// makes them editable for the first time — a capability gain, not a removal.
//
// Provenance is `default` for anything the user never touched, so the receipt
// reads honestly: these are assumptions the app made, not statements the user
// gave.

import type { ProjectKind, ProjectMetadata, ProjectPlatform } from '../../types';
import type { BriefAssumption } from '../brief-state';

/** The creation settings that used to be modal-only, with their safe defaults. */
export interface CreationDefaults {
  fidelity: 'wireframe' | 'high-fidelity';
  platformTargets: ProjectPlatform[];
  includeLandingPage: boolean;
  includeOsWidgets: boolean;
  speakerNotes: boolean;
  animations: boolean;
}

export const CREATION_DEFAULTS: CreationDefaults = {
  // Mirrors the old panel default at NewProjectPanel's `useState('high-fidelity')`.
  fidelity: 'high-fidelity',
  platformTargets: ['responsive'],
  includeLandingPage: false,
  includeOsWidgets: false,
  speakerNotes: false,
  animations: false,
};

const PLATFORM_LABELS: Record<string, string> = {
  responsive: 'Responsive web',
  'web-desktop': 'Desktop web',
  'mobile-ios': 'iOS app',
  'mobile-android': 'Android app',
  tablet: 'Tablet app',
  'desktop-app': 'Desktop app',
  auto: 'Auto',
};

const FIDELITY_LABELS: Record<CreationDefaults['fidelity'], string> = {
  wireframe: 'Wireframe',
  'high-fidelity': 'High fidelity',
};

function platformLabel(value: ProjectPlatform): string {
  return PLATFORM_LABELS[value] ?? value;
}

/**
 * Which settings are meaningful for a kind. Mirrors the old per-tab
 * conditionals in NewProjectPanel so no kind gains a control it never had:
 * fidelity/platforms/surfaces were prototype-family, speaker notes were deck,
 * animations were template.
 */
function fieldsForKind(kind: ProjectKind): {
  designSettings: boolean;
  speakerNotes: boolean;
  animations: boolean;
} {
  return {
    designSettings: kind === 'prototype' || kind === 'template' || kind === 'other',
    speakerNotes: kind === 'deck',
    animations: kind === 'template',
  };
}

/**
 * Build the brief assumptions for the settings the modal used to freeze.
 * `metadata` wins over the default when the caller (an Advanced-disclosure
 * create, or an import) already made an explicit choice.
 */
export function creationBriefAssumptions(
  kind: ProjectKind,
  metadata?: ProjectMetadata | null,
): BriefAssumption[] {
  const fields = fieldsForKind(kind);
  const assumptions: BriefAssumption[] = [];

  const stated = (explicit: boolean): BriefAssumption['provenance'] =>
    explicit ? 'stated' : 'default';

  if (fields.designSettings) {
    const fidelity = metadata?.fidelity ?? CREATION_DEFAULTS.fidelity;
    assumptions.push({
      id: 'fidelity',
      label: 'Fidelity',
      value: fidelity,
      displayValue: FIDELITY_LABELS[fidelity],
      provenance: stated(metadata?.fidelity !== undefined),
      question: {
        id: 'fidelity',
        label: 'Fidelity',
        type: 'radio',
        options: [
          { label: FIDELITY_LABELS.wireframe, value: 'wireframe' },
          { label: FIDELITY_LABELS['high-fidelity'], value: 'high-fidelity' },
        ],
      },
    });

    const targets = metadata?.platformTargets?.length
      ? metadata.platformTargets
      : CREATION_DEFAULTS.platformTargets;
    assumptions.push({
      id: 'platformTargets',
      label: 'Target platforms',
      value: targets,
      displayValue: targets.map(platformLabel).join(', '),
      provenance: stated(Boolean(metadata?.platformTargets?.length)),
      question: {
        id: 'platformTargets',
        label: 'Target platforms',
        type: 'checkbox',
        maxSelections: 6,
        options: (
          ['responsive', 'web-desktop', 'mobile-ios', 'mobile-android', 'tablet', 'desktop-app'] as const
        ).map((value) => ({ label: platformLabel(value), value })),
      },
    });

    const surfaces: string[] = [];
    const landing = metadata?.includeLandingPage ?? CREATION_DEFAULTS.includeLandingPage;
    const widgets = metadata?.includeOsWidgets ?? CREATION_DEFAULTS.includeOsWidgets;
    if (landing) surfaces.push('landing');
    if (widgets) surfaces.push('os-widgets');
    assumptions.push({
      id: 'companionSurfaces',
      label: 'Companion surfaces',
      value: surfaces,
      displayValue: surfaces.length
        ? surfaces.map((s) => (s === 'landing' ? 'Landing page' : 'OS widgets')).join(', ')
        : 'None',
      provenance: stated(
        metadata?.includeLandingPage !== undefined || metadata?.includeOsWidgets !== undefined,
      ),
      question: {
        id: 'companionSurfaces',
        label: 'Companion surfaces',
        type: 'checkbox',
        maxSelections: 2,
        options: [
          { label: 'Landing page', value: 'landing' },
          { label: 'OS widgets', value: 'os-widgets' },
        ],
      },
    });
  }

  if (fields.speakerNotes) {
    const notes = metadata?.speakerNotes ?? CREATION_DEFAULTS.speakerNotes;
    assumptions.push({
      id: 'speakerNotes',
      label: 'Speaker notes',
      value: notes ? 'yes' : 'no',
      displayValue: notes ? 'Included' : 'Not included',
      provenance: stated(metadata?.speakerNotes !== undefined),
      question: {
        id: 'speakerNotes',
        label: 'Use speaker notes',
        type: 'radio',
        options: [
          { label: 'Included', value: 'yes' },
          { label: 'Not included', value: 'no' },
        ],
      },
    });
  }

  if (fields.animations) {
    const anim = metadata?.animations ?? CREATION_DEFAULTS.animations;
    assumptions.push({
      id: 'animations',
      label: 'Animations',
      value: anim ? 'yes' : 'no',
      displayValue: anim ? 'Included' : 'Not included',
      provenance: stated(metadata?.animations !== undefined),
      question: {
        id: 'animations',
        label: 'Include animations',
        type: 'radio',
        options: [
          { label: 'Included', value: 'yes' },
          { label: 'Not included', value: 'no' },
        ],
      },
    });
  }

  return assumptions;
}

/**
 * Apply a brief correction back onto project metadata. This is what makes the
 * chips a real capability gain: a value frozen at create time before is now
 * writable for the life of the project.
 */
export function applyBriefAssumptionToMetadata(
  metadata: ProjectMetadata,
  assumption: BriefAssumption,
): ProjectMetadata {
  const { id, value } = assumption;
  const list = Array.isArray(value) ? value : [value];
  switch (id) {
    case 'fidelity':
      return value === 'wireframe' || value === 'high-fidelity'
        ? { ...metadata, fidelity: value }
        : metadata;
    case 'platformTargets':
      return { ...metadata, platformTargets: list as ProjectPlatform[] };
    case 'companionSurfaces':
      return {
        ...metadata,
        includeLandingPage: list.includes('landing'),
        includeOsWidgets: list.includes('os-widgets'),
      };
    case 'speakerNotes':
      return { ...metadata, speakerNotes: value === 'yes' };
    case 'animations':
      return { ...metadata, animations: value === 'yes' };
    default:
      return metadata;
  }
}
