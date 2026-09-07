// EntryShell — the centered-hero entry layout.
//
// This component owns the entire JSX render and local UI state for
// the redesigned home view (left rail + sticky settings cog + hero +
// recent projects + plugins section). App owns the new-project modal. It is
// intentionally a sibling of `EntryView` so that upstream `main`
// changes to `EntryView` (props, lifecycle, helpers, exports) can be
// rebased without touching this file. `EntryView` becomes a thin wrapper
// that passes data and callbacks through to this shell.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  type ChatSessionMode,
  type InstalledPluginRecord,
} from '@readable-studio/contracts';
import { useAnalytics } from '../analytics/provider';
import { trackHomeNavClick } from '../analytics/events';
import { useT } from '../i18n';
import { navigate, useRoute } from '../router';
import type {
  AgentInfo,
  ApiProtocol,
  AppConfig,
  AppTheme,
  DesignSystemSummary,
  ExecMode,
  Project,
  ProjectMetadata,
  ProjectTemplate,
  SkillSummary,
} from '../types';
import { CenteredLoader } from './Loading';
import { DesignsTab } from './DesignsTab';
import { DesignSystemPreviewModal } from './DesignSystemPreviewModal';
import { DesignSystemsTab } from './DesignSystemsTab';
import type { EntryView as EntryViewKind } from './EntryNavRail';
import { HubHome } from './hub/HubHome';
import { openSessionRoute } from './hub/openSessionRoute';
import {
  createPluginAuthoringHandoff,
  createPluginUseHandoff,
  type HomePromptHandoff,
} from './home-hero/plugin-authoring';
import type { PluginUseAction } from './plugins-home/useActions';
import { IntegrationsView, type IntegrationTab } from './IntegrationsView';
import { InlineModelSwitcher } from './InlineModelSwitcher';
import { requireModelSelection } from './agentModelSelection';
import type { EntrySettingsSection } from './EntrySettingsMenu';
import { PluginsView } from './PluginsView';
import type { CreateInput, CreateTab } from './NewProjectPanel';
import type { PluginLoopSubmit } from './PluginLoopHome';
import type {
  PluginShareAction,
  PluginShareProjectOutcome,
} from '../state/projects';
import { TasksView } from './TasksView';
import { useRuntimeUsername } from '../hooks/useRuntimeUser';
import { AnimatePresence } from 'motion/react';
import { smoothScrollToTop } from '../utils/smoothScrollToTop';
import {
  type ProviderModelsCache,
} from './providerModelsCache';

// The topbar chips (GitHub star, model switcher, Use everywhere)
// collapse into the settings dropdown when the viewport gets
// narrow. The transition is driven entirely by CSS @media queries
// in `entry-layout.css` so server and client render identical
// markup — both surfaces are always present, and CSS toggles
// `display` based on `--compact-topbar` breakpoint (900px).

interface Props {
  skills: SkillSummary[];
  designTemplates: SkillSummary[];
  designSystems: DesignSystemSummary[];
  projects: Project[];
  templates: ProjectTemplate[];
  defaultDesignSystemId: string | null;
  integrationInitialTab?: IntegrationTab;
  skillsLoading?: boolean;
  designSystemsLoading?: boolean;
  projectsLoading?: boolean;
  // Execution / model-switching context. Threaded down from `App` so the
  // top-bar `InlineModelSwitcher` can render the active mode/agent/model
  // and persist changes through the same callbacks the project view uses.
  config: AppConfig;
  providerModelsCache?: ProviderModelsCache;
  onProviderModelsCacheChange?: Dispatch<SetStateAction<ProviderModelsCache>>;
  agents: AgentInfo[];
  agentsLoading?: boolean;
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
  // Quick theme switch from the avatar-popover dropdown. Lets the user
  // flip between system / light / dark without opening the full Settings
  // dialog. App owns persistence; this component just calls the callback.
  onThemeChange: (theme: AppTheme) => void;
  onCreateProject: (
    input: CreateInput & {
      pendingPrompt?: string;
      pluginId?: string;
      appliedPluginSnapshotId?: string;
      pluginInputs?: Record<string, unknown>;
      conversationMode?: ChatSessionMode;
      autoSendFirstMessage?: boolean;
      pendingFiles?: File[];
    },
  ) => Promise<boolean> | boolean | void;
  onCreatePluginShareProject: (
    pluginId: string,
    action: PluginShareAction,
    locale?: string,
  ) => Promise<PluginShareProjectOutcome>;
  onOpenNewProject: (tab: CreateTab) => void;
  onOpenProject: (id: string) => void;
  onDeleteProject: (id: string) => Promise<boolean | void> | boolean | void;
  onRenameProject: (id: string, name: string) => void;
  onChangeDefaultDesignSystem: (id: string) => void;
  onCreateDesignSystem?: () => void;
  // NOTE: first-run onboarding intentionally no longer hosts guided
  // design-system creation, so EntryShell deliberately does not accept a
  // `renderDesignSystemCreation` renderer. Guided creation stays reachable
  // from the standalone `design-system-create` route and the Design Systems
  // tab; do not re-thread an onboarding renderer here.
  onOpenDesignSystem?: (id: string) => void;
  onDesignSystemsRefresh?: () => Promise<void> | void;
  onOpenSettings: (section?: EntrySettingsSection) => void;
}

// Map an EntryNavRail view id to the analytics `element` enum on
// `home/nav` ui_click. Returns `null` for views without a dedicated nav
// button (the rail's "Home" target is the brand logo, which gets its own
// element value via the logo click handler — not the changeView path).
function navElementForView(
  next: EntryViewKind,
):
  | 'home'
  | 'projects'
  | 'automations'
  | 'plugins'
  | 'design_systems'
  | 'integrations'
  | null {
  switch (next) {
    case 'home':
      return 'home';
    case 'projects':
      return 'projects';
    case 'tasks':
      return 'automations';
    case 'plugins':
      return 'plugins';
    case 'design-systems':
      return 'design_systems';
    case 'integrations':
      return 'integrations';
    default:
      return null;
  }
}

// Tab views stay mounted (so previews/thumbnails survive a tab switch) but the
// inactive ones must leave layout, the accessibility tree, and tab order.
// `content-visibility: hidden` still reserves the hidden pane's block size,
// which pushes later sidebar destinations far below the sticky topbar.
function inactiveViewProps(active: boolean) {
  return {
    style: active ? undefined : ({ display: 'none' } as const),
    // React 18 cannot serialize inert as a boolean prop; use the DOM boolean API.
    ref: (node: HTMLDivElement | null) => {
      node?.toggleAttribute('inert', !active);
    },
    'aria-hidden': !active,
  };
}

export function EntryShell({
  skills,
  designTemplates,
  designSystems,
  projects,
  templates,
  defaultDesignSystemId,
  integrationInitialTab = 'mcp',
  skillsLoading = false,
  designSystemsLoading = false,
  projectsLoading = false,
  config,
  providerModelsCache: sharedProviderModelsCache,
  onProviderModelsCacheChange,
  agents,
  agentsLoading = false,
  daemonLive,
  onModeChange,
  onAgentChange,
  onAgentModelChange,
  onApiProtocolChange,
  onApiModelChange,
  onConfigPersist,
  onRefreshAgents,
  onThemeChange,
  onCreateProject,
  onCreatePluginShareProject,
  onOpenNewProject,
  onOpenProject,
  onDeleteProject,
  onRenameProject,
  onChangeDefaultDesignSystem,
  onCreateDesignSystem,
  onOpenDesignSystem,
  onDesignSystemsRefresh,
  onOpenSettings,
}: Props) {
  const t = useT();
  // Each entry sub-view (home / projects / design-systems) is its own
  // URL now, so the browser back/forward buttons work and a deep link
  // to /design-systems lands on that section. We derive the active
  // view from the route rather than keeping it in component state.
  const route = useRoute();
  const username = useRuntimeUsername();
  const view: EntryViewKind = route.kind === 'home' ? route.view : 'home';
  const [previewSystemId, setPreviewSystemId] = useState<string | null>(null);
  const [localProviderModelsCache, setLocalProviderModelsCache] =
    useState<ProviderModelsCache>({});
  const hasSharedProviderModelsCache =
    Boolean(sharedProviderModelsCache) && Boolean(onProviderModelsCacheChange);
  const activeProviderModelsCache =
    hasSharedProviderModelsCache
      ? sharedProviderModelsCache!
      : localProviderModelsCache;
  const activeSetProviderModelsCache =
    hasSharedProviderModelsCache
      ? onProviderModelsCacheChange!
      : setLocalProviderModelsCache;
  const [integrationTab, setIntegrationTab] = useState<IntegrationTab>(integrationInitialTab);
  const [homePromptHandoff, setHomePromptHandoff] = useState<HomePromptHandoff | null>(null);
  const entryMainScrollRef = useRef<HTMLElement | null>(null);
  const analytics = useAnalytics();
  function changeView(next: EntryViewKind) {
    const navElement = navElementForView(next);
    if (navElement) {
      trackHomeNavClick(analytics.track, {
        page_name: 'home',
        area: 'nav',
        element: navElement,
      });
    }
    navigate({ kind: 'home', view: next });
  }

  function startPluginAuthoring(goal?: string) {
    setHomePromptHandoff(
      createPluginAuthoringHandoff(Date.now(), goal),
    );
    changeView('home');
  }

  function usePluginFromLibrary(
    record: InstalledPluginRecord,
    action: PluginUseAction = 'use',
  ) {
    setHomePromptHandoff(
      createPluginUseHandoff(Date.now(), record.id, { action }),
    );
    changeView('home');
  }

  useEffect(() => {
    if (view !== 'home' || !homePromptHandoff) return;
    const frame = window.requestAnimationFrame(() => {
      const scrollContainer = entryMainScrollRef.current;
      if (!scrollContainer) return;
      smoothScrollToTop(scrollContainer);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [homePromptHandoff?.id, view]);

  useEffect(() => {
    setIntegrationTab(integrationInitialTab);
  }, [integrationInitialTab]);

  function openIntegrationTab(tab: IntegrationTab) {
    setIntegrationTab(tab);
    changeView('integrations');
  }

  function openNewProject(tab: CreateTab = 'prototype') {
    onOpenNewProject(tab);
  }

  const previewSystem = useMemo(
    () => (previewSystemId ? designSystems.find((d) => d.id === previewSystemId) ?? null : null),
    [designSystems, previewSystemId],
  );

  // The rail footer names the workspace the user actually configured; with no
  // project location set there is nothing to name, so the row falls back to
  // its generic label rather than inventing an identity.
  const activeWorkspaceName = useMemo(() => {
    const locations = config.projectLocations ?? [];
    const active =
      locations.find((location) => location.id === config.defaultProjectLocationId) ??
      locations[0];
    return active?.name?.trim() || null;
  }, [config.projectLocations, config.defaultProjectLocationId]);

  // Plan §3.F5 — the home prompt-loop submit path. The user picks a
  // plugin (which calls /api/plugins/:id/apply and binds a snapshot),
  // edits the rendered example query if any, then presses Enter. We
  // derive a project name from the active plugin (or prompt head),
  // forward the pluginId so POST /api/projects pins the snapshot to
  // project + conversation, and request auto-send of the first
  // message so the user lands inside a running pipeline.
  //
  // Stage B of plugin-driven-flow-plan: the rail can stamp a
  // `projectKind` on the payload so the created project records the
  // chosen artifact type. Free-form Home submits now arrive with the
  // hidden readable-default router plugin and projectKind='other', so the
  // agent asks for the exact task type before continuing.
  function handlePluginLoopSubmit(payload: PluginLoopSubmit) {
    if (!requireModelSelection(config, agents)) return;
    const head = payload.prompt.trim().split(/\s+/).slice(0, 8).join(' ');
    const firstAttachmentName = payload.attachments?.[0]?.name ?? '';
    const fallbackName = head.length > 0 ? head : firstAttachmentName || 'Untitled';
    const name =
      payload.pluginTitle && payload.pluginTitle.trim().length > 0
        ? payload.pluginTitle.trim()
        : fallbackName;
    const requestedKind = payload.projectKind;
    const metadata: ProjectMetadata = {
      ...(payload.projectMetadata ?? {}),
      kind:
        requestedKind === 'prototype' ||
        requestedKind === 'deck' ||
        requestedKind === 'template' ||
        requestedKind === 'other'
          ? requestedKind
          : payload.projectMetadata?.kind ?? 'prototype',
      nameSource: 'prompt',
      ...(payload.visualReferences.length > 0
        ? { visualReferences: payload.visualReferences }
        : {}),
      ...(payload.contextMcpServers && payload.contextMcpServers.length > 0
        ? { contextMcpServers: payload.contextMcpServers }
        : {}),
      ...(payload.examplePromptContext ? {
        examplePrompt: true,
        examplePromptTitle: payload.examplePromptContext.title,
        examplePromptBrief: payload.examplePromptContext.brief,
      } : {}),
    };
    return onCreateProject({
      name,
      skillId: payload.skillId ?? null,
      designSystemId: payload.designSystemId ?? null,
      metadata,
      pendingPrompt: payload.prompt,
      ...(payload.pluginId ? { pluginId: payload.pluginId } : {}),
      ...(payload.pluginType ? { pluginType: payload.pluginType } : {}),
      ...(payload.appliedPluginSnapshotId
        ? { appliedPluginSnapshotId: payload.appliedPluginSnapshotId }
        : {}),
      ...(payload.pluginInputs ? { pluginInputs: payload.pluginInputs } : {}),
      ...(payload.conversationMode ? { conversationMode: payload.conversationMode } : {}),
      ...(payload.attachments && payload.attachments.length > 0
        ? { pendingFiles: payload.attachments }
        : {}),
      autoSendFirstMessage: payload.autoSendFirstMessage ?? true,
    });
  }


  const switcherProps = {
    config,
    agents,
    agentsLoading,
    providerModelsCache: activeProviderModelsCache,
    onProviderModelsCacheChange: activeSetProviderModelsCache,
    daemonLive,
    onModeChange,
    onAgentChange,
    onAgentModelChange,
    onApiProtocolChange,
    onApiModelChange,
    onOpenSettings,
  } as const;

  // Top bar keeps the combined chip (mode · agent · model in one popover).
  const executionSwitcher = <InlineModelSwitcher {...switcherProps} />;

  // Hub composer footer: two separate buttons — agent, then model to its
  // right — each opening only its own concern. Both are the same component in
  // a different variant, so agent selection, model selection and the
  // provider-models fetch each exist exactly once.
  const composerAgentModelControls = (
    <>
      <InlineModelSwitcher {...switcherProps} variant="agent" />
      <InlineModelSwitcher {...switcherProps} variant="model" />
    </>
  );

  return (
    <div className="entry-shell entry-shell--no-header">
      <div className="entry">
        <main className="entry-main entry-main--scroll" ref={entryMainScrollRef}>
          <div className="entry-main__topbar">
            {/* The topbar rail toggle was removed: it duplicated the rail's own
                collapse control and, once the traffic lights moved right, it
                was the control crammed against the chrome band. Expand /
                collapse now lives in the rail strip (`entry-nav-collapse`),
                which is always visible. */}
            <div className="entry-main__topbar-chips entry-main__topbar-chips--icon-only">
              {executionSwitcher}
            </div>
            {/* The top-right trio (execution-settings gear with the daemon
                status dot, help launcher, account avatar) was removed at the
                user's request. Settings stays reachable from the hub rail
                footer gear (`hub-footer-settings`) and from the hub's
                "workspace folder" / library rows; theme and language moved into
                the full Settings dialog's Appearance and Language sections; the
                daemon live/offline signal keeps its dedicated hub status chip
                (`hub__status`). The help menu is gone entirely. */}
          </div>
          <div
            className={`entry-main__inner${
              view === 'home'
                ? ' entry-main__inner--home'
                : ' entry-main__inner--wide'
            }`}
          >
            <div data-testid="entry-view-home" data-active={view === 'home' ? 'true' : 'false'} {...inactiveViewProps(view === 'home')}>
              {/* The welcome/hero screen was replaced by the project + session
                  hub. Navigation lives in the hub's left panel; the centre stays
                  a calm start surface instead of a wall of past projects. */}
              <HubHome
                active={view === 'home'}
                projects={projects}
                username={username}
                projectsLoading={projectsLoading}
                onOpenSession={openSessionRoute}
                onOpenProject={onOpenProject}
                onOpenDestination={(destination) => changeView(destination)}
                onOpenSettings={() => onOpenSettings()}
                onOpenWorkspaceFolder={() => onOpenSettings('projectLocations')}
                workspaceName={activeWorkspaceName}
                designSystems={designSystems}
                defaultDesignSystemId={defaultDesignSystemId}
                onSubmit={handlePluginLoopSubmit}
                onViewAllProjects={() => changeView('projects')}
                onBrowseRegistry={() => changeView('plugins')}
                onOpenMcp={() => openIntegrationTab('mcp')}
                onOpenNewProject={(tab) => openNewProject(tab)}
                promptHandoff={homePromptHandoff}
                skills={skills}
                skillsLoading={skillsLoading}
                onNewProject={() => openNewProject()}
                onRenameProject={onRenameProject}
                onDeleteProject={(projectId) => { void onDeleteProject(projectId); }}
                onNavigateDestination={changeView}
                onGoHome={() => changeView('home')}
                /* Same component, same callbacks as the top bar — mounted as
                   the split agent + model pair the composer footer contract
                   requires. */
                executionSwitcher={composerAgentModelControls}
              />
            </div>
            <div data-testid="entry-view-projects" data-active={view === 'projects' ? 'true' : 'false'} {...inactiveViewProps(view === 'projects')}>
              {view !== 'projects' ? null : projectsLoading || skillsLoading || designSystemsLoading ? (
                <CenteredLoader label={t('common.loading')} />
              ) : (
                <div className="entry-section">
                  <header className="entry-section__head">
                    <h1 className="entry-section__title">{t('entry.navProjects')}</h1>
                  </header>
                  <DesignsTab
                    projects={projects}
                    skills={skills}
                    designSystems={designSystems}
                    onOpen={onOpenProject}
                    onDelete={onDeleteProject}
                    onRename={onRenameProject}
                    onNewProject={() => openNewProject()}
                  />
                </div>
              )}
            </div>
            <div data-testid="entry-view-tasks" data-active={view === 'tasks' ? 'true' : 'false'} {...inactiveViewProps(view === 'tasks')}>
              <TasksView
                skills={skills}
                designTemplates={designTemplates}
              />
            </div>
            <div data-testid="entry-view-plugins" data-active={view === 'plugins' ? 'true' : 'false'} {...inactiveViewProps(view === 'plugins')}>
              <PluginsView
                onCreatePlugin={startPluginAuthoring}
                onUsePlugin={usePluginFromLibrary}
                onCreatePluginShareProject={onCreatePluginShareProject}
              />
            </div>
            <div data-testid="entry-view-design-systems" data-active={view === 'design-systems' ? 'true' : 'false'} {...inactiveViewProps(view === 'design-systems')}>
              {designSystemsLoading ? (
                <CenteredLoader label={t('common.loading')} />
              ) : (
                <div className="entry-section">
                  <header className="entry-section__head">
                    <h1 className="entry-section__title">{t('entry.navDesignSystems')}</h1>
                  </header>
                  <DesignSystemsTab
                    systems={designSystems}
                    templates={templates}
                    selectedId={defaultDesignSystemId}
                    onSelect={onChangeDefaultDesignSystem}
                    onCreate={onCreateDesignSystem}
                    onOpenSystem={onOpenDesignSystem}
                    onSystemsRefresh={onDesignSystemsRefresh}
                    onPreview={(id) => setPreviewSystemId(id)}
                  />
                </div>
              )}
            </div>
            {view === 'integrations' ? (
              <IntegrationsView initialTab={integrationTab} />
            ) : null}
          </div>
        </main>
      </div>
      <AnimatePresence>
        {previewSystem ? (
          <DesignSystemPreviewModal
            system={previewSystem}
            onClose={() => setPreviewSystemId(null)}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}
