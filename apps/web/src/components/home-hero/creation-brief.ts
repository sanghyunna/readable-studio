import type { ProjectMetadata, ProjectPlatform } from '../../types';
import type { BriefAssumption } from '../brief-state';

/** Project settings are projected only after an explicit answer or receipt. */
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
    case 'platformTargets': {
      const platforms: readonly string[] = [
        'auto', 'responsive', 'web-desktop', 'mobile-ios', 'mobile-android', 'tablet', 'desktop-app',
      ];
      if (!list.every(item => platforms.includes(item))) return metadata;
      return { ...metadata, platformTargets: list as ProjectPlatform[] };
    }
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
