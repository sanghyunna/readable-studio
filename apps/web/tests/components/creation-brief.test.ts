import { describe, expect, it } from 'vitest';
import { applyBriefAssumptionToMetadata } from '../../src/components/home-hero/creation-brief';
import type { BriefAssumption } from '../../src/components/brief-state';
import type { ProjectMetadata } from '../../src/types';

describe('brief metadata write-back', () => {
  it('updates every prompt-facing creation field and is idempotent', () => {
    const initial: ProjectMetadata = { kind: 'prototype' };
    const corrections: BriefAssumption[] = [
      { id: 'fidelity', label: 'Fidelity', value: 'wireframe', provenance: 'stated' as const },
      { id: 'platformTargets', label: 'Platforms', value: ['responsive', 'mobile-ios'], provenance: 'stated' as const },
      { id: 'companionSurfaces', label: 'Surfaces', value: ['landing'], provenance: 'stated' as const },
      { id: 'speakerNotes', label: 'Notes', value: 'yes', provenance: 'stated' as const },
      { id: 'animations', label: 'Animations', value: 'no', provenance: 'stated' as const },
    ];

    const corrected = corrections.reduce<ProjectMetadata>(applyBriefAssumptionToMetadata, initial);
    const reapplied = corrections.reduce<ProjectMetadata>(applyBriefAssumptionToMetadata, corrected);

    expect(corrected).toEqual({
      kind: 'prototype',
      fidelity: 'wireframe',
      platformTargets: ['responsive', 'mobile-ios'],
      includeLandingPage: true,
      includeOsWidgets: false,
      speakerNotes: true,
      animations: false,
    });
    expect(reapplied).toEqual(corrected);
  });

  it('does not write invalid prompt-facing values', () => {
    const metadata = { kind: 'prototype' as const };
    expect(applyBriefAssumptionToMetadata(metadata, {
      id: 'platformTargets',
      label: 'Platforms',
      value: ['invalid-platform'],
      provenance: 'stated',
    })).toBe(metadata);
    expect(applyBriefAssumptionToMetadata(metadata, {
      id: 'speakerNotes',
      label: 'Notes',
      value: 'maybe',
      provenance: 'stated',
    })).toBe(metadata);
  });
});
