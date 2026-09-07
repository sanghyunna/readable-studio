import type { ProjectMetadata, ProjectPlatform } from '@readable-studio/contracts';

type BriefAssumption = {
  id: string;
  value: string | string[];
};

const PROJECT_PLATFORMS: readonly string[] = [
  'auto',
  'responsive',
  'web-desktop',
  'mobile-ios',
  'mobile-android',
  'tablet',
  'desktop-app',
];

/** Applies a known brief field to the top-level metadata consumed by prompt composers. */
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
      if (!list.every(item => PROJECT_PLATFORMS.includes(item))) return metadata;
      return { ...metadata, platformTargets: list as ProjectPlatform[] };
    case 'companionSurfaces':
      if (!list.every(item => item === 'landing' || item === 'os-widgets')) return metadata;
      return {
        ...metadata,
        includeLandingPage: list.includes('landing'),
        includeOsWidgets: list.includes('os-widgets'),
      };
    case 'speakerNotes':
      return value === 'yes' || value === 'no'
        ? { ...metadata, speakerNotes: value === 'yes' }
        : metadata;
    case 'animations':
      return value === 'yes' || value === 'no'
        ? { ...metadata, animations: value === 'yes' }
        : metadata;
    default:
      return metadata;
  }
}
