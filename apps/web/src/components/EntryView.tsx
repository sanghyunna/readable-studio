import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { ReadableStudioHostProjectImportSuccess } from '@readable-studio/host';
import type {
  AgentInfo,
  ApiProtocol,
  AppConfig,
  AppTheme,
  DesignSystemSummary,
  ExecMode,
  Project,
  ProjectKind,
  ProjectMetadata,
  ProjectTemplate,
  ProviderModelOption,
  SkillSummary,
} from '../types';
// `EntryShell` owns the redesigned home layout (left rail + centered
// hero + recent projects + plugins). Keeping the redesign in a sibling
// component lets future rebases against upstream `EntryView` stay close
// to a no-op here.
import { EntryShell } from './EntryShell';
import type { IntegrationTab } from './IntegrationsView';
import type { CreateInput, ImportClaudeDesignOutcome } from './NewProjectPanel';
import type { EntrySettingsSection } from './EntrySettingsMenu';
import type {
  PluginShareAction,
  PluginShareProjectOutcome,
} from '../state/projects';

interface Props {
  // Union of functional skills + design templates — used for id-based
  // lookups (DesignsTab project chips, NewProjectPanel skill picker).
  // The Templates gallery itself reads `designTemplates` instead so it
  // doesn't accidentally show functional skills as renderable cards.
  skills: SkillSummary[];
  // Design templates only. Sourced from /api/design-templates. See
  // specs/current/skills-and-design-templates.md.
  designTemplates: SkillSummary[];
  designSystems: DesignSystemSummary[];
  projects: Project[];
  templates: ProjectTemplate[];
  onDeleteTemplate: (id: string) => Promise<boolean>;
  defaultDesignSystemId: string | null;
  agents: AgentInfo[];
  // Forwarded to EntryShell → OnboardingView so the AMR cloud card can show a
  // detecting/skeleton state while the cold-start agent stream is in flight.
  agentsLoading?: boolean;
  // Execution / model-switching context forwarded to the EntryShell so the
  // sticky top-bar can expose the active CLI/BYOK + model and persist
  // changes through the same channels as the project view.
  config: AppConfig;
  providerModelsCache?: Record<string, ProviderModelOption[]>;
  onProviderModelsCacheChange?: Dispatch<SetStateAction<Record<string, ProviderModelOption[]>>>;
  integrationInitialTab?: IntegrationTab;
  daemonLive: boolean;
  onModeChange: (mode: ExecMode) => void;
  onAgentChange: (id: string) => void;
  onAgentModelChange: (
    id: string,
    choice: { model?: string; reasoning?: string },
  ) => void;
  onApiProtocolChange: (protocol: ApiProtocol) => void;
  onApiModelChange: (model: string) => void;
  onConfigPersist: (cfg: AppConfig) => Promise<void> | void;
  onRefreshAgents: () => Promise<AgentInfo[]> | AgentInfo[];
  // Quick theme switch invoked from the avatar-popover dropdown so the
  // user can flip light/dark/system without opening the full Settings
  // dialog. Persistence happens in `App`; this component just forwards.
  onThemeChange: (theme: AppTheme) => void;
  // Per-resource loading flags. Each tab gates its own content on whichever
  // flag matches the data it renders, so a slow `/api/agents` probe does
  // not block tabs that don't need agents. Templates are not gated here —
  // the New project modal renders an empty state until they arrive (fast
  // fetch), which keeps the prop surface narrower.
  skillsLoading?: boolean;
  designSystemsLoading?: boolean;
  projectsLoading?: boolean;
  onCreateProject: (
    input: CreateInput & {
      pendingPrompt?: string;
      pluginId?: string;
      appliedPluginSnapshotId?: string;
      pluginInputs?: Record<string, unknown>;
      autoSendFirstMessage?: boolean;
      pendingFiles?: File[];
    },
  ) => Promise<boolean> | boolean | void;
  onCreatePluginShareProject: (
    pluginId: string,
    action: PluginShareAction,
    locale?: string,
  ) => Promise<PluginShareProjectOutcome>;
  onImportClaudeDesign: (
    file: File,
  ) => Promise<ImportClaudeDesignOutcome | void> | ImportClaudeDesignOutcome | void;
  onImportFolder?: (baseDir: string) => Promise<void> | void;
  onImportFolderResponse?: (response: ReadableStudioHostProjectImportSuccess) => Promise<void> | void;
  onOpenProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onChangeDefaultDesignSystem: (id: string) => void;
  onCreateDesignSystem?: () => void;
  onOpenDesignSystem?: (id: string) => void;
  onDesignSystemsRefresh?: () => Promise<void> | void;
  onOpenSettings: (section?: 'execution' | 'integrations' | 'mcpClient' | 'language' | 'appearance' | 'notifications' | 'pet' | 'projectLocations' | 'library' | 'about' | 'memory' | 'designSystems') => void;
  onCompleteOnboarding: () => void;
}

export function EntryView({
  skills,
  designTemplates,
  designSystems,
  projects,
  templates,
  onDeleteTemplate,
  defaultDesignSystemId,
  agents,
  agentsLoading,
  config,
  providerModelsCache,
  onProviderModelsCacheChange,
  integrationInitialTab,
  daemonLive,
  onModeChange,
  onAgentChange,
  onAgentModelChange,
  onApiProtocolChange,
  onApiModelChange,
  onConfigPersist,
  onRefreshAgents,
  onThemeChange,
  skillsLoading = false,
  designSystemsLoading = false,
  projectsLoading = false,
  onCreateProject,
  onCreatePluginShareProject,
  onImportClaudeDesign,
  onImportFolder,
  onImportFolderResponse,
  onOpenProject,
  onDeleteProject,
  onRenameProject,
  onChangeDefaultDesignSystem,
  onCreateDesignSystem,
  onOpenDesignSystem,
  onDesignSystemsRefresh,
  onOpenSettings,
  onCompleteOnboarding,
}: Props) {
  void useCallback;
  void useEffect;
  void useState;

  const openSettings = onOpenSettings as (section?: EntrySettingsSection) => void;

  return (
    <EntryShell
      skills={skills}
      designTemplates={designTemplates}
      designSystems={designSystems}
      projects={projects}
      templates={templates}
      onDeleteTemplate={onDeleteTemplate}
      defaultDesignSystemId={defaultDesignSystemId}
      {...(integrationInitialTab ? { integrationInitialTab } : {})}
      skillsLoading={skillsLoading}
      designSystemsLoading={designSystemsLoading}
      projectsLoading={projectsLoading}
      config={config}
      providerModelsCache={providerModelsCache}
      onProviderModelsCacheChange={onProviderModelsCacheChange}
      agents={agents}
      {...(agentsLoading !== undefined ? { agentsLoading } : {})}
      daemonLive={daemonLive}
      onModeChange={onModeChange}
      onAgentChange={onAgentChange}
      onAgentModelChange={onAgentModelChange}
      onApiProtocolChange={onApiProtocolChange}
      onApiModelChange={onApiModelChange}
      onConfigPersist={onConfigPersist}
      onRefreshAgents={onRefreshAgents}
      onThemeChange={onThemeChange}
      onCreateProject={onCreateProject}
      onCreatePluginShareProject={onCreatePluginShareProject}
      onImportClaudeDesign={onImportClaudeDesign}
      {...(onImportFolder ? { onImportFolder } : {})}
      {...(onImportFolderResponse ? { onImportFolderResponse } : {})}
      onOpenProject={onOpenProject}
      onDeleteProject={onDeleteProject}
      onRenameProject={onRenameProject}
      onChangeDefaultDesignSystem={onChangeDefaultDesignSystem}
      onCreateDesignSystem={onCreateDesignSystem}
      onOpenDesignSystem={onOpenDesignSystem}
      onDesignSystemsRefresh={onDesignSystemsRefresh}
      onOpenSettings={openSettings}
      onCompleteOnboarding={onCompleteOnboarding}
    />
  );
}

// Map a skill's declared mode to project metadata. Falls back to the same
// defaults the new-project form would apply (high-fidelity prototype, no
// speaker notes on decks, no template animations) so 'Use this prompt'
// produces a project indistinguishable from one created via the form. Per-
// skill hints in SKILL.md frontmatter (readable.fidelity, readable.speaker_notes,
// readable.animations) override the defaults so each example reproduces the
// shipped example.html — e.g. wireframe-sketch declares fidelity:wireframe.
//
// Kept exported (and the kindForSkill helper too) so the New project modal
// and any future skill-driven creation surface can share the mapping.
export function metadataForSkill(skill: SkillSummary): ProjectMetadata {
  const kind = kindForSkill(skill);
  if (kind === 'prototype') {
    return { kind, fidelity: skill.fidelity ?? 'high-fidelity' };
  }
  if (kind === 'deck') {
    return {
      kind,
      speakerNotes:
        typeof skill.speakerNotes === 'boolean' ? skill.speakerNotes : false,
    };
  }
  if (kind === 'template') {
    return {
      kind,
      animations:
        typeof skill.animations === 'boolean' ? skill.animations : false,
    };
  }
  return { kind: 'other' };
}

export function kindForSkill(skill: SkillSummary): ProjectKind {
  if (skill.mode === 'deck') return 'deck';
  if (skill.mode === 'prototype') return 'prototype';
  if (skill.mode === 'template') return 'template';
  return 'other';
}
