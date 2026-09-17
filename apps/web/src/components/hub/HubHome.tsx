// Entry hub: the surface that replaced the welcome/hero screen.
//
// Left panel owns navigation (project -> session tree). The center is a calm
// start surface: a live-work strip when something is running, the composer,
// and the New Project modal launcher. Past work is never dumped into the center canvas.
//
// AppInner owns the persistent rail, controller and overlays. This component
// renders only the stage from that ancestor context. Tests must supply an
// explicit host/provider too; a missing shell is a wiring error.

import { type ReactNode } from 'react';

import { useT } from '../../i18n';
import type {
  DesignSystemSummary,
  Project,
  SkillSummary,
} from '../../types';
import { HomeView } from '../HomeView';
import type { HomePromptHandoff } from '../home-hero/plugin-authoring';
import { Icon } from '../Icon';
import type { PluginLoopSubmit } from '../PluginLoopHome';
import type { HubImportFileOutcome } from './drop-to-edit';
import { HubDropToEdit } from './HubDropToEdit';
import chromeStyles from './HubChrome.module.css';
import { HubPerformanceToggle, type PerformanceProfile } from './HubPerformanceToggle';
import { useHubRail } from './HubRailContext';
import { relativeTimeShort } from './relativeTime';
import type { HubDestination } from './types';
import type { HubNavigateDestination } from './useHubRailController';

export { clampHubRailWidth } from './useHubRailController';

const EMPTY_DESIGN_SYSTEMS: DesignSystemSummary[] = [];

interface Props {
  /** Inactive entry tabs retain their composer but cannot consume commands. */
  active?: boolean;
  projects: Project[];
  /** Windows account running the local daemon, when available. */
  username?: string | null;
  projectsLoading?: boolean;
  /** Open an existing session directly in the workspace. */
  onOpenSession: (projectId: string, conversationId: string) => void;
  /** Rich creation payload; HomeView owns all composer submission state. */
  onSubmit?: (payload: PluginLoopSubmit) => Promise<boolean> | boolean | void;
  modelSelectionGuard?: () => boolean;
  /** @deprecated compatibility for callers not yet migrated to the rich payload. */
  onSubmitPrompt?: (prompt: string, options?: { designSystemId: string | null }) => unknown;
  /** Open a project itself, including projects with no sessions. */
  onOpenProject?: (projectId: string) => void;
  onViewAllProjects?: () => void;
  onBrowseRegistry?: () => void;
  onOpenMcp?: () => void;
  onOpenNewProject?: (tab: 'template') => void;
  /**
   * Drop-to-edit: route ONE existing document through the import path and
   * land in the workspace with it open. The zone below the composer only
   * renders when a host wires this; the entry shell always does.
   */
  onImportFile?: (file: File) => Promise<HubImportFileOutcome> | HubImportFileOutcome;
  /** Plugin/authoring selection handed back from a Library destination. */
  promptHandoff?: HomePromptHandoff | null;
  skills?: SkillSummary[];
  skillsLoading?: boolean;
  /** Navigate to one of the entry destinations (rail footer library menu). */
  onOpenDestination?: (destination: HubDestination) => void;
  /** Open settings (rail footer gear and workspace menu). */
  onOpenSettings?: () => void;
  /** Open the surface that owns the workspace storage roots. */
  onOpenWorkspaceFolder?: () => void;
  /** Name of the active workspace, rendered in the rail footer row. */
  workspaceName?: string | null;
  designSystems?: DesignSystemSummary[];
  defaultDesignSystemId?: string | null;
  onNewProject: () => void;
  /** Persisted rename/delete for a project row; the hub never invents these. */
  onRenameProject?: (projectId: string, name: string) => void;
  onDeleteProject?: (projectId: string) => Promise<boolean | void> | boolean | void;
  onNavigateDestination?: (destination: HubNavigateDestination) => void;
  currentSessionId?: string | null;
  /** Brand click returns to the hub itself; entry chrome owns the target. */
  onGoHome?: () => void;
  /**
   * The agent + model control for the composer footer, mounted as an opaque
   * node. EntryShell owns the real InlineModelSwitcher (config, agents,
   * daemon state and every persistence callback); the hub only forwards the
   * SAME node down to HomeView, so the live callbacks stay real without
   * threading a dozen execution inputs through this component.
   */
  executionSwitcher?: ReactNode;
  /**
   * Low-spec profile mirrored from `AppConfig.performanceProfile`. The chrome
   * toggle renders only when a host wires the change handler (EntryShell
   * always does); it never replaces another control.
   */
  performanceProfile?: PerformanceProfile;
  onPerformanceProfileChange?: (profile: PerformanceProfile) => void;
}

export function HubHome({
  active = true,
  projects,
  projectsLoading = false,
  onSubmit,
  modelSelectionGuard,
  onSubmitPrompt,
  onOpenProject,
  onViewAllProjects,
  onBrowseRegistry,
  onOpenMcp,
  onOpenNewProject,
  onImportFile,
  promptHandoff,
  skills,
  skillsLoading,
  designSystems = EMPTY_DESIGN_SYSTEMS,
  defaultDesignSystemId = null,
  executionSwitcher,
  performanceProfile = 'full',
  onPerformanceProfileChange,
}: Props) {
  const t = useT();
  const rail = useHubRail();
  const { railCollapsed, running, commandChip, consumeCommandChip } = rail;

  return (
    <div
      className="hub"
      data-rail-collapsed={railCollapsed ? 'true' : 'false'}
      data-rail-host="shell"
    >
      <div className="hub__wash" aria-hidden="true" />
      <div className="sr-only" role="status" aria-live="polite" data-testid="hub-live-region">
        {rail.announcement}
      </div>
      {/* The aggregate read failure is text, not a colour: assistive tech and
          a sighted user get the same fact. */}
      <div
        className="hub__status"
        role="status"
        aria-live="polite"
        data-testid="hub-sessions-status"
        hidden={rail.failedSessionReads === 0}
      >
        {rail.failedSessionReads > 0
          ? t('hub.sessionsFailed', { count: String(rail.failedSessionReads) })
          : ''}
      </div>

      <div className="hub__stage">
        {/* Stable chrome row: sits above the start surface, away from the
            composer's agent / model / send cluster. */}
        {onPerformanceProfileChange ? (
          <div className={chromeStyles.chrome} data-testid="hub-chrome">
            <HubPerformanceToggle
              profile={performanceProfile}
              onProfileChange={onPerformanceProfileChange}
            />
          </div>
        ) : null}
        <div className="hub__start">
          {running ? (
            <button
              type="button"
              className="hub__live"
              data-testid="hub-live-strip"
              onClick={() => rail.openSession(running.session)}
            >
              <span className="hub__live-state">{t('hub.liveRunning')}</span>
              <span className="hub__live-text">
                {t('hub.liveWorking', {
                  project: running.project.name,
                  session: running.session.title,
                })}
              </span>
              <span className="hub__live-time" data-testid="hub-live-time">
                {relativeTimeShort(running.session.updatedAt, t)}
              </span>
              <Icon name="arrow-up" size={15} className="hub__live-arrow" />
            </button>
          ) : null}

          <HomeView
            surface="hub"
            richDataEnabled={Boolean(onSubmit)}
            modelSelectionGuard={modelSelectionGuard}
            projects={projects}
            projectsLoading={projectsLoading}
            designSystems={designSystems}
            defaultDesignSystemId={defaultDesignSystemId}
            onSubmit={onSubmit ?? ((payload) => {
              onSubmitPrompt?.(payload.prompt, { designSystemId: payload.designSystemId ?? null });
            })}
            onOpenProject={onOpenProject ?? (() => undefined)}
            onViewAllProjects={onViewAllProjects ?? (() => undefined)}
            onBrowseRegistry={onBrowseRegistry}
            onOpenMcp={onOpenMcp}
            onOpenNewProject={onOpenNewProject}
            promptHandoff={promptHandoff}
            skills={skills}
            skillsLoading={skillsLoading}
            commandChip={active ? commandChip : null}
            onCommandChipAccepted={consumeCommandChip}
            executionSwitcher={executionSwitcher}
          />

          {projects.length === 0 && !projectsLoading ? (
            <p className="hub__empty" data-testid="hub-empty">
              <strong>{t('hub.noProjectsTitle')}</strong> {t('hub.noProjectsBody')}
            </p>
          ) : null}
          {/* Editing an existing document is its own way in. The zone is a
              sibling of the composer, so the composer's attachment drop keeps
              its own files; the left panel and Ctrl K need no hint line. */}
          {onImportFile ? <HubDropToEdit onImportFile={onImportFile} /> : null}
        </div>
      </div>
    </div>
  );
}
