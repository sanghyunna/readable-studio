// Stage B of plugin-driven-flow-plan — Home intent rail.
//
// The Home input card sits naked above an unstructured prompt. New
// users frequently type a request without knowing which scenario
// plugin to apply, which lands them in the generic agent path and
// stretches the convergence loop. This chip rail exposes high-signal
// NewProjectModal categories plus a small set of lower-row shortcuts
// (plugin authoring / Figma / template), so the same Enter
// keystroke can hit a scenario-bound run. The generic "other" path stays
// in the free-form prompt instead of becoming a redundant chip.
//
// The catalog stays a pure data table:
//   - `id` — stable React key + test selector.
//   - `label` — English copy. Localisation can layer on later by
//     swapping this for a Dict lookup; keeping it inline lets the
//     rail ship without burning through 17 locale files for two
//     new strings (see plan §B / open questions).
//   - `icon` — name from the shared Icon registry.
//   - `action` — discriminated union the HomeView dispatcher matches
//     on. The rail component itself stays presentational.

import type { ProjectKind, ProjectMetadata } from '@readable-studio/contracts';
import type { DefaultScenarioPluginId } from '@readable-studio/contracts';
import type { IconName } from '../Icon';

// Plugin ids the chip rail can dispatch to. Chips route to a
// `DefaultScenarioPluginId`, keeping the daemon's fallback table the
// source of truth for Home queries.
export type ChipScenarioPluginId = DefaultScenarioPluginId;

export type ChipAction =
  | {
      kind: 'apply-scenario';
      pluginId: ChipScenarioPluginId;
      projectKind: ProjectKind;
      inputs?: Record<string, unknown>;
      projectMetadata?: ProjectMetadata;
    }
  | {
      kind: 'apply-figma-migration';
      pluginId: 'readable-figma-migration';
      projectKind: ProjectKind;
      inputs?: Record<string, unknown>;
      projectMetadata?: ProjectMetadata;
    }
  | { kind: 'create-plugin' }
  | { kind: 'open-template-picker' };

// Two intent groups: "create" = produce a design artifact, "migrate" =
// lower-row starter shortcuts such as plugin authoring, imports, and
// templates. The grouping is structural only — HomeHero renders the two
// groups in separate flex containers so they wrap onto separate rows on
// narrow viewports without horizontal scrolling.
export type ChipGroup = 'create' | 'migrate';

export interface HomeHeroChip {
  id: string;
  label: string;
  icon: IconName;
  group: ChipGroup;
  hint?: string;
  action: ChipAction;
}

export const HOME_HERO_CHIPS: ReadonlyArray<HomeHeroChip> = [
  {
    id: 'prototype',
    label: 'Prototype',
    icon: 'palette',
    group: 'create',
    // Prototype now binds to the bundled `example-web-prototype` plugin,
    // which ships `assets/template.html` (single-file HTML prototype
    // seed), `references/layouts.md` (paste-ready section layouts), and
    // a P0 checklist. The previous routing to the generic
    // readable-new-generation router left the agent to invent every section's
    // CSS, producing inconsistent type scales and density between turns.
    // Web-prototype's manifest owns the editable `{{fidelity}}`,
    // `{{artifactKind}}`, `{{audience}}`, `{{designSystem}}`, and
    // `{{template}}` slots; Home renders those placeholders inline.
    action: {
      kind: 'apply-scenario',
      pluginId: 'example-web-prototype',
      projectKind: 'prototype',
    },
  },
  {
    id: 'deck',
    label: 'Slide deck',
    icon: 'present',
    group: 'create',
    // Slide deck binds to `example-simple-deck`, which ships a 353-line
    // `assets/template.html` (the 1920×1080 + scale-to-fit + nav + print
    // framework paired with proven slide CSS), 8 paste-ready layouts in
    // `references/layouts.md` (cover, body, big-stat, three-point,
    // pipeline, dark quote, before/after, closing), and a P0/P1/P2
    // checklist that catches overflow at 1280×800 / 1440×900. The
    // previous routing to readable-new-generation gave the agent only the
    // generic deck-framework directive — which fixed nav but not slide
    // layout — so density bugs (168px headline + absolute footer
    // collision) shipped on default decks.
    action: {
      kind: 'apply-scenario',
      pluginId: 'example-simple-deck',
      projectKind: 'deck',
    },
  },
  {
    id: 'report',
    label: 'Report',
    icon: 'file',
    group: 'create',
    hint: 'Generate a flowing long-form report document — title, exec summary, sections, tables, and appendix.',
    action: {
      kind: 'apply-scenario',
      pluginId: 'example-report',
      projectKind: 'prototype',
      projectMetadata: {
        kind: 'prototype',
        intent: 'report',
      },
    },
  },
  {
    id: 'create-plugin',
    label: 'Create plugin',
    icon: 'edit',
    group: 'migrate',
    hint: 'Author a reusable Readable Studio plugin and add it to My plugins.',
    action: { kind: 'create-plugin' },
  },
  {
    id: 'figma',
    label: 'From Figma',
    icon: 'import',
    group: 'migrate',
    hint: 'Migrate a Figma frame into the active design system.',
    action: {
      kind: 'apply-figma-migration',
      pluginId: 'readable-figma-migration',
      projectKind: 'prototype',
      inputs: {
        figmaUrl: 'the Figma file URL you provide',
        targetStack: 'React 18 + Tailwind',
      },
    },
  },
  {
    id: 'template',
    label: 'From template',
    icon: 'file-code',
    group: 'migrate',
    hint: 'Start from a bundled template.',
    action: { kind: 'open-template-picker' },
  },
];

export function chipsForGroup(group: ChipGroup): HomeHeroChip[] {
  return HOME_HERO_CHIPS.filter((c) => c.group === group);
}

// Helper used by tests + the rail component to pull the chip metadata
// off a click target without round-tripping through React state.
export function findChip(id: string): HomeHeroChip | undefined {
  return HOME_HERO_CHIPS.find((c) => c.id === id);
}
