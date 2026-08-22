import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import dynamic from 'next/dynamic';
import { AnimatePresence, MotionConfig } from 'motion/react';
import { useAnalytics } from './analytics/provider';
import {
  trackFileUploadResult,
  trackProjectCreateResult,
} from './analytics/events';
import { deriveUploadCohort } from './analytics/upload-tracking';
import { detectClientType } from './analytics/identity';
import {
  deriveConfigureGlobals,
  projectKindToTracking,
  fidelityToTracking,
} from '@readable-studio/contracts/analytics';
import type { AmrModelsResponse, ChatSessionMode } from '@readable-studio/contracts';
import { EntryView } from './components/EntryView';
import type { IntegrationTab } from './components/IntegrationsView';
import type { CreateInput, ImportClaudeDesignOutcome } from './components/NewProjectPanel';
import { MemoryToast } from './components/MemoryToast';
import { Toast } from './components/Toast';
import { PetOverlay, type PetTaskCenter } from './components/pet/PetOverlay';
import { buildPetTaskCenter } from './components/pet/taskCenter';
import { migrateCustomPetAtlas } from './components/pet/pets';
import { TooltipLayer } from './components/TooltipLayer';
import { openWorkspaceTab, WorkspaceTabsBar } from './components/WorkspaceTabsBar';
import {
  IframeKeepAliveProvider,
  useIframeKeepAlivePool,
} from './components/IframeKeepAlivePool';
import type { SettingsSection, SettingsHighlight } from './components/SettingsDialog';
import {
  daemonIsLive,
  fetchAppVersionInfo,
  fetchAgentsStream,
  fetchDesignSystems,
  fetchDesignTemplates,
  fetchSkills,
  uploadProjectFiles,
  replaceProjectWorkingDir,
} from './providers/registry';
import {
  RUNS_CHANGED_EVENT,
  fetchAmrModels,
  fetchVelaLoginStatus,
  listProjectRuns,
  type VelaLoginStatus,
} from './providers/daemon';
import { AMR_LOGIN_STATUS_EVENT } from './components/amrLoginPolling';
import { navigate, useRoute } from './router';
import {
  fetchDaemonConfig,
  DEFAULT_PET,
  loadConfig,
  mergeDaemonConfig,
  saveConfig,
  syncConfigToDaemon,
} from './state/config';
import { applyAppearanceToDocument } from './state/appearance';
import {
  switchApiProtocolConfig,
  updateCurrentApiProtocolConfig,
} from './state/apiProtocolConfig';
import {
  buildPersistedConfig,
  resolveSettingsCloseConfig,
} from './state/settings-persistence';
import { isMacPlatform } from './utils/platform';
import {
  createProject,
  createPluginShareProject,
  deleteProject as deleteProjectApi,
  getProject,
  importClaudeDesignZip,
  importFolderProject,
  listProjects,
  listTemplates,
  deleteTemplate,
  patchProject,
} from './state/projects';
import { useModalWindowDragGuard } from './hooks/useModalWindowDragGuard';
import type {
  PluginShareAction,
  PluginShareProjectOutcome,
} from './state/projects';
import type { ReadableStudioHostProjectImportSuccess } from '@readable-studio/host';
import { useI18n } from './i18n';
import type {
  AgentInfo,
  AgentModelChoice,
  ApiProtocol,
  AppConfig,
  AppVersionInfo,
  ChatAttachment,
  DesignSystemGenerationJob,
  DesignSystemSummary,
  Project,
  ProjectTemplate,
  ProviderModelOption,
  SkillSummary,
} from './types';

const MarketplaceView = dynamic(
  () => import('./components/MarketplaceView').then((m) => m.MarketplaceView),
  { ssr: false },
);
const PluginDetailView = dynamic(
  () => import('./components/PluginDetailView').then((m) => m.PluginDetailView),
  { ssr: false },
);
const ProjectView = dynamic(
  () => import('./components/ProjectView').then((m) => m.ProjectView),
  { ssr: false },
);
const DesignSystemCreationFlow = dynamic(
  () => import('./components/DesignSystemFlow').then((m) => m.DesignSystemCreationFlow),
  { ssr: false },
);
const DesignSystemDetailView = dynamic(
  () => import('./components/DesignSystemFlow').then((m) => m.DesignSystemDetailView),
  { ssr: false },
);
const SettingsDialog = dynamic(
  () => import('./components/SettingsDialog').then((m) => m.SettingsDialog),
  { ssr: false },
);

const APP_CONFIG_CHANGED_EVENT = 'readable-studio:app-config-changed';
const AMR_AGENT_ID = 'amr';
const AMR_PROFILE_ENV_KEY = 'READABLE_AMR_PROFILE';


function amrProfileForConfig(config: AppConfig): string | null {
  const profile = config.agentCliEnv?.[AMR_AGENT_ID]?.[AMR_PROFILE_ENV_KEY];
  return typeof profile === 'string' && profile ? profile : null;
}

function sameAgentModelChoice(
  left: AgentModelChoice | undefined,
  right: AgentModelChoice | undefined,
): boolean {
  return (left?.model ?? null) === (right?.model ?? null)
    && (left?.reasoning ?? null) === (right?.reasoning ?? null);
}

function clearStaleAmrModelChoiceOnProfileChange(
  previous: AppConfig,
  next: AppConfig,
): AppConfig {
  if (amrProfileForConfig(previous) === amrProfileForConfig(next)) return next;

  const previousChoice = previous.agentModels?.[AMR_AGENT_ID];
  const nextChoice = next.agentModels?.[AMR_AGENT_ID];
  if (!nextChoice || !sameAgentModelChoice(previousChoice, nextChoice)) return next;

  const nextAgentModels = { ...(next.agentModels ?? {}) };
  delete nextAgentModels[AMR_AGENT_ID];
  return { ...next, agentModels: nextAgentModels };
}

type ProjectListRequest = {
  generation: number;
  mutationVersion: number;
};

function mergeAmrModelsIntoAgents(
  agents: AgentInfo[],
  amrModels: AmrModelsResponse | null,
): AgentInfo[] {
  if (!amrModels || amrModels.models.length === 0) return agents;
  return agents.map((agent) => {
    if (agent.id !== 'amr') return agent;
    const shouldPreferAgentModels =
      amrModels.source === 'preset' &&
      Array.isArray(agent.models) &&
      agent.models.length > 0;
    if (shouldPreferAgentModels) return agent;
    return { ...agent, models: amrModels.models, modelsSource: 'live' };
  });
}

const CANONICAL_AGENT_ORDER = [
  'amr',
  'claude',
  'codex',
  'devin',
  'gemini',
  'opencode',
  'hermes',
  'trae-cli',
  'grok-build',
  'kimi',
  'cursor-agent',
  'qwen',
  'qoder',
  'copilot',
  'pi',
  'kiro',
  'kilo',
  'vibe',
  'deepseek',
  'aider',
  'antigravity',
  'reasonix',
] as const;

const CANONICAL_AGENT_ORDER_INDEX = new Map<string, number>(
  CANONICAL_AGENT_ORDER.map((id, index) => [id, index]),
);

function orderAgentsByRegistry(agents: AgentInfo[]): AgentInfo[] {
  return agents
    .map((agent, index) => ({ agent, index }))
    .sort((left, right) => {
      const leftRank =
        CANONICAL_AGENT_ORDER_INDEX.get(left.agent.id) ??
        CANONICAL_AGENT_ORDER.length;
      const rightRank =
        CANONICAL_AGENT_ORDER_INDEX.get(right.agent.id) ??
        CANONICAL_AGENT_ORDER.length;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.index - right.index;
    })
    .map(({ agent }) => agent);
}

function upsertAgent(agents: AgentInfo[], agent: AgentInfo): AgentInfo[] {
  const index = agents.findIndex((item) => item.id === agent.id);
  if (index === -1) return [...agents, agent];
  const next = agents.slice();
  next[index] = agent;
  return next;
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

function scheduleStartupIdle(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const requestIdle = (window as unknown as {
    requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  }).requestIdleCallback;
  if (typeof requestIdle === 'function') {
    const id = requestIdle(callback, { timeout: 1200 });
    return () => {
      const cancelIdle = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      if (typeof cancelIdle === 'function') cancelIdle(id);
    };
  }
  const id = window.setTimeout(callback, 0);
  return () => window.clearTimeout(id);
}

// @dsp func-127c6ffb
export function App() {
  // `reducedMotion="user"` makes every motion/react component honor the OS
  // `prefers-reduced-motion` setting: transform/layout animations are zeroed
  // out while opacity-only changes are kept. The CSS `@media (prefers-reduced-
  // motion: reduce)` block covers the CSS-keyframe surfaces, but the dialogs,
  // toasts and popovers that moved to motion/react need this gate too — without
  // it they keep springing/sliding for users who asked us not to animate.
  return (
    <MotionConfig reducedMotion="user">
      <IframeKeepAliveProvider>
        <AppInner />
      </IframeKeepAliveProvider>
    </MotionConfig>
  );
}

function AppInner() {
  const { t } = useI18n();
  const iframeKeepAlivePool = useIframeKeepAlivePool();
  const clientType = useMemo(() => detectClientType(), []);
  useModalWindowDragGuard();
  // Observability marker. `apps/web/src/observability/white-screen.ts`
  // keys its "app actually mounted" success condition on this attribute
  // because the dynamic-import loading shell (`<div class="readable-loading-shell">
  // Loading Readable Studio…</div>`) is itself >MIN_VISIBLE_TEXT and would
  // otherwise be mistaken for a real mount. Survives subsequent render
  // crashes — once App has mounted at least once, it's no longer a white
  // screen (subsequent failures show up as `$exception`).
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-readable-app-mounted', '1');
    }
  }, []);
  const [config, setConfig] = useState<AppConfig>(() => loadConfig());
  const configRef = useRef(config);
  configRef.current = config;
  const latestPersistedConfigRef = useRef(config);
  latestPersistedConfigRef.current = config;
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Surfaced when a picked project folder could not be applied to a freshly
  // created project (expired/invalid desktop token, daemon rejection). Without
  // this the failure was swallowed and the user believed their folder was in
  // effect while the project actually stayed in the managed root.
  const [workingDirError, setWorkingDirError] = useState<string | null>(null);
  const [settingsWelcome, setSettingsWelcome] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection>('execution');
  const [settingsHighlight, setSettingsHighlight] = useState<SettingsHighlight>(null);
  const [integrationInitialTab, setIntegrationInitialTab] = useState<IntegrationTab>('mcp');
  const [daemonLive, setDaemonLive] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const amrModelsRef = useRef<AmrModelsResponse | null>(null);
  const amrPollGenerationRef = useRef(0);
  const agentStreamRequestSeqRef = useRef(0);
  const [amrPollRestartToken, setAmrPollRestartToken] = useState(0);
  const [providerModelsCache, setProviderModelsCache] = useState<
    Record<string, ProviderModelOption[]>
  >({});
  // Functional skills (capabilities the agent invokes mid-task) — stays
  // small and lives under the Settings → Skills surface.
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  // Design templates (rendering catalogue: decks, prototypes, image/video/
  // audio templates) — sourced from /api/design-templates and shown in the
  // EntryView Templates tab. See specs/current/skills-and-design-templates.md.
  const [designTemplates, setDesignTemplates] = useState<SkillSummary[]>([]);
  const [designSystems, setDesignSystems] = useState<DesignSystemSummary[]>([]);
  const [pendingDesignSystemRevisionJobs, setPendingDesignSystemRevisionJobs] = useState<
    Record<string, DesignSystemGenerationJob>
  >({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [petTaskCenter, setPetTaskCenter] = useState<PetTaskCenter>({
    running: [],
    queued: [],
    recent: [],
  });
  const pendingLocalProjectIdsRef = useRef<Set<string>>(new Set());
  const locallyDeletedProjectIdsRef = useRef<Map<string, number>>(new Map());
  const projectListMutationVersionRef = useRef(0);
  const projectListRequestGenerationRef = useRef(0);
  const latestAppliedProjectListGenerationRef = useRef(0);
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [appVersionInfo, setAppVersionInfo] = useState<AppVersionInfo | null>(
    null,
  );
  // Per-resource loading flags. Each goes false the moment its own fetch
  // resolves so each entry-view tab can render as its data lands instead of
  // every tab waiting on the slowest endpoint (typically `/api/agents`,
  // which probes CLI versions and can take seconds on cold start). The entry
  // view picks the right flag for whichever tab the user is currently on.
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [dsLoading, setDsLoading] = useState(true);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [startupDeferredReady, setStartupDeferredReady] = useState(false);
  // Goes true once the daemon-persisted config (agentId/designSystemId/etc.)
  // has merged into local state. Auto-selection effects below wait on this
  // so they don't race ahead of the daemon-stored choice and overwrite it
  // with a freshly picked first-available agent.
  const [daemonConfigLoaded, setDaemonConfigLoaded] = useState(false);
  const route = useRoute();
  const analytics = useAnalytics();

  const beginAgentStreamRequest = useCallback(() => {
    agentStreamRequestSeqRef.current += 1;
    return agentStreamRequestSeqRef.current;
  }, []);

  const isCurrentAgentStreamRequest = useCallback((requestId: number) => {
    return agentStreamRequestSeqRef.current === requestId;
  }, []);

  const restartAmrPolling = useCallback(() => {
    amrPollGenerationRef.current += 1;
    setAmrPollRestartToken((current) => current + 1);
  }, []);

  // v2 schema removed the standalone `app_launch` event; the initial
  // page_view fires from each top-level page surface (home / projects /
  // automations / plugins / design_systems / integrations) instead.
  // `detectClientType` still feeds analytics identity via the provider.
  void detectClientType;

  const rememberLocalProject = useCallback((projectId: string) => {
    pendingLocalProjectIdsRef.current.add(projectId);
    locallyDeletedProjectIdsRef.current.delete(projectId);
    projectListMutationVersionRef.current += 1;
  }, []);

  const clearLocalProject = useCallback((projectId: string, options?: { deleted?: boolean }) => {
    pendingLocalProjectIdsRef.current.delete(projectId);
    projectListMutationVersionRef.current += 1;
    if (options?.deleted) {
      locallyDeletedProjectIdsRef.current.set(
        projectId,
        projectListMutationVersionRef.current,
      );
    }
  }, []);

  const beginProjectListRequest = useCallback((): ProjectListRequest => {
    projectListRequestGenerationRef.current += 1;
    return {
      generation: projectListRequestGenerationRef.current,
      mutationVersion: projectListMutationVersionRef.current,
    };
  }, []);

  const reconcileFetchedProjects = useCallback((list: Project[], request: ProjectListRequest) => {
    const pendingLocalProjectIds = pendingLocalProjectIdsRef.current;
    const locallyDeletedProjectIds = locallyDeletedProjectIdsRef.current;
    const fetchedIds = new Set(list.map((project) => project.id));
    if (request.generation < latestAppliedProjectListGenerationRef.current) {
      const visibleList =
        locallyDeletedProjectIds.size > 0
          ? list.filter((project) => !locallyDeletedProjectIds.has(project.id))
          : list;
      if (visibleList.length === 0) return false;
      const hydratableProjects = visibleList.filter(
        (project) =>
          pendingLocalProjectIds.has(project.id),
      );
      if (hydratableProjects.length === 0) return false;
      const hydratableById = new Map(
        hydratableProjects.map((project) => [project.id, project]),
      );
      for (const project of hydratableProjects) {
        pendingLocalProjectIds.delete(project.id);
      }
      setProjects((current) => {
        let changed = false;
        const currentIds = new Set<string>();
        const next = current.map((project) => {
          currentIds.add(project.id);
          const hydrated = hydratableById.get(project.id);
          if (!hydrated) return project;
          changed = true;
          hydratableById.delete(project.id);
          return hydrated;
        });
        for (const project of hydratableById.values()) {
          if (currentIds.has(project.id)) continue;
          changed = true;
          next.push(project);
        }
        return changed ? next : current;
      });
      return true;
    }
    latestAppliedProjectListGenerationRef.current = request.generation;
    for (const id of fetchedIds) pendingLocalProjectIds.delete(id);
    for (const [id, deletedAtMutationVersion] of locallyDeletedProjectIds) {
      if (
        request.mutationVersion >= deletedAtMutationVersion
        && !fetchedIds.has(id)
      ) {
        locallyDeletedProjectIds.delete(id);
      }
    }
    const activeDeletedProjectIds = new Set(locallyDeletedProjectIds.keys());
    const visibleList =
      activeDeletedProjectIds.size > 0
        ? list.filter((project) => !activeDeletedProjectIds.has(project.id))
        : list;
    const visibleFetchedIds =
      activeDeletedProjectIds.size > 0
        ? new Set(visibleList.map((project) => project.id))
        : fetchedIds;
    setProjects((current) => {
      const preserved = current.filter(
        (project) =>
          pendingLocalProjectIds.has(project.id) &&
          !visibleFetchedIds.has(project.id) &&
          !activeDeletedProjectIds.has(project.id),
      );
      return preserved.length > 0 ? [...preserved, ...visibleList] : visibleList;
    });
    return true;
  }, []);

  // Corporate fork policy: analytics provider methods are no-ops, but keep
  // these calls so stale configs cannot revive the old consent path.
  useEffect(() => {
    analytics.setConsent(false);
  }, [analytics.setConsent]);

  // Keep the legacy analytics identity cleared. The provider no longer
  // installs daemon analytics headers.
  useEffect(() => {
    analytics.setIdentity(null);
  }, [analytics.setIdentity]);

  // App-level AMR sign-in state — declared here because the configure
  // globals effect below reads it; the sync effects live next to the
  // other AMR plumbing further down.
  const [amrLoginStatus, setAmrLoginStatus] = useState<VelaLoginStatus | null>(null);

  // Preserve the old configure-state calculation for compatibility with the
  // analytics wrapper API. The wrapper is a no-op in this fork.
  useEffect(() => {
    if (agentsLoading) return;
    const byokConfigured = (() => {
      const protocols = config.apiProtocolConfigs;
      if (!protocols) return Boolean(config.apiKey?.trim());
      return Object.values(protocols).some(
        (cfg) => Boolean(cfg?.apiKey?.trim()),
      );
    })();
    const globals = deriveConfigureGlobals({
      mode: config.mode,
      agentId: config.agentId,
      agents: agents.map((a) => ({ id: a.id, available: a.available })),
      byokConfigured,
      amrAuthorized: amrLoginStatus?.loggedIn === true,
    });
    analytics.setConfigureGlobals(globals);
  }, [
    analytics.setConfigureGlobals,
    agentsLoading,
    amrLoginStatus,
    config.mode,
    config.agentId,
    config.apiKey,
    config.apiProtocolConfigs,
    agents,
  ]);

  // Sync theme preference to the <html> element so CSS variables pick it up.
  // useLayoutEffect (vs useEffect) fires before the browser paints, so a
  // live theme switch in Settings applies atomically — no 1-frame flash of
  // the old theme. Safe here because the component tree is ssr:false.
  useLayoutEffect(() => {
    applyAppearanceToDocument({
      theme: config.theme ?? 'system',
      accentColorMode: config.accentColorMode,
      accentColor: config.accentColor,
    });
  }, [config.theme, config.accentColorMode, config.accentColor]);

  // Tell the daemon what the user is currently looking at, so the MCP
  // server can surface it as `get_active_context` to a coding agent in
  // another repo. Best-effort fire-and-forget; the daemon holds it in
  // memory with a short TTL and the MCP layer falls back to
  // {active:false} if this hasn't run.
  const activeProjectId = route.kind === 'project' ? route.projectId : null;
  const activeFileName = route.kind === 'project' ? route.fileName : null;
  // The first-run privacy consent banner was removed along with telemetry
  // egress; there is nothing left to consent to.
  // `config.privacyDecisionAt` is intentionally left in the config schema
  // because legacy config files may still include it.
  useEffect(() => {
    const body = activeProjectId
      ? { projectId: activeProjectId, fileName: activeFileName }
      : { active: false };
    fetch('/api/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {
      // Daemon down or transient network — not worth surfacing.
    });
  }, [activeProjectId, activeFileName]);

  useEffect(() => {
    if (!daemonLive) return;
    let cancelled = false;
    let timer: number | null = null;
    const pollGeneration = amrPollGenerationRef.current + 1;
    amrPollGenerationRef.current = pollGeneration;
    const pollDelayMs = 1_000;
    const maxPresetPolls = 10;
    let presetPolls = 0;

    const applyAmrModels = async () => {
      const result = await fetchAmrModels();
      if (
        cancelled ||
        amrPollGenerationRef.current !== pollGeneration ||
        !result ||
        !Array.isArray(result.models) ||
        result.models.length === 0
      ) {
        return;
      }
      amrModelsRef.current = result;
      setAgents((current) => mergeAmrModelsIntoAgents(current, result));
      const shouldPollPreset =
        result.source === 'preset' &&
        !result.remoteError &&
        presetPolls < maxPresetPolls;
      if (shouldPollPreset) {
        presetPolls += 1;
        timer = window.setTimeout(() => {
          void applyAmrModels();
        }, pollDelayMs);
      }
    };

    void applyAmrModels();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [amrPollRestartToken, daemonLive]);

  // App-level AMR sign-in state. Feeds two analytics globals: the
  // `amr` configure_type bucket (deriveConfigureGlobals below) and the
  // `user_id` public param (the AMR account id is the only join key
  // between this PostHog project and the AMR-side one). Child surfaces
  // push status changes up via onAmrLoginStatusChange; the global
  // AMR_LOGIN_STATUS_EVENT covers logins finishing in surfaces that
  // unmounted before their poll settled.
  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      const status = await fetchVelaLoginStatus();
      if (!cancelled && status) setAmrLoginStatus(status);
    };
    void sync();
    const onStatusEvent = () => {
      void sync();
    };
    window.addEventListener(AMR_LOGIN_STATUS_EVENT, onStatusEvent);
    return () => {
      cancelled = true;
      window.removeEventListener(AMR_LOGIN_STATUS_EVENT, onStatusEvent);
    };
  }, [daemonLive]);

  useEffect(() => {
    analytics.setUserId(
      amrLoginStatus?.loggedIn === true ? amrLoginStatus.user?.id ?? null : null,
    );
  }, [analytics.setUserId, amrLoginStatus]);

  const handleAmrLoginStatusChange = useCallback((status: VelaLoginStatus | null) => {
    if (status) setAmrLoginStatus(status);
    if (status?.loggedIn !== true) return;
    restartAmrPolling();
  }, [restartAmrPolling]);

  useEffect(() => {
    let cancelled = false;
    const agentStreamAbort = new AbortController();
    const deferredAbort = new AbortController();
    let cancelDeferredStartup: () => void = () => undefined;
    (async () => {
      const alive = await daemonIsLive();
      if (cancelled) return;
      setDaemonLive(alive);
      if (!alive) {
        // No daemon — clear every loading flag so empty states render
        // instead of the entry view sitting on indefinite spinners.
        setAgentsLoading(false);
        setSkillsLoading(false);
        setDsLoading(false);
        setProjectsLoading(false);
        setDaemonConfigLoaded(true);
        setStartupDeferredReady(true);
        return;
      }

      void fetchSkills().then((list) => {
        if (cancelled) return;
        setSkills(list);
        setSkillsLoading(false);
      });

      void fetchDesignSystems().then((list) => {
        if (cancelled) return;
        setDesignSystems(list);
        setDsLoading(false);
      });

      const request = beginProjectListRequest();
      void listProjects().then((list) => {
        if (cancelled) return;
        reconcileFetchedProjects(list, request);
        setProjectsLoading(false);
      });

      void fetchDaemonConfig().then((daemonConfig) => {
        if (cancelled) return;
        // Compute the next config outside the setConfig updater so we can
        // both (a) call navigate() after setConfig returns — calling it
        // inside the updater would trigger a Router setState during React's
        // render phase — and (b) read next.onboardingCompleted synchronously,
        // since React batches setConfig and the updater doesn't run until
        // the next render. latestPersistedConfigRef is kept in sync with
        // the rendered config and is safe to read here.
        const baseConfig = latestPersistedConfigRef.current;
        const next = clearStaleAmrModelChoiceOnProfileChange(
          baseConfig,
          mergeDaemonConfig(baseConfig, daemonConfig),
        );
        saveConfig(next);
        // Migrate localStorage prefs to daemon on first boot with the new
        // endpoint. If daemon already had values the merge above used them;
        // writing back is idempotent and keeps both sides in sync.
        void syncConfigToDaemon(next);
        latestPersistedConfigRef.current = next;
        setConfig(next);

        // Route first-run users through the global onboarding panel.
        // The onboarding panel and the privacy banner have independent
        // lifecycles: onboarding keys off `onboardingCompleted`, the
        // banner keys off `privacyDecisionAt`. They may coexist on the
        // first launch; the banner sits above the modal layer so it
        // stays actionable regardless of the active view.
        if (!next.onboardingCompleted) {
          navigate({ kind: 'home', view: 'onboarding' }, { replace: true });
        }
        setDaemonConfigLoaded(true);
      });

      cancelDeferredStartup = scheduleStartupIdle(() => {
        if (cancelled) return;
        setStartupDeferredReady(true);

        const agentRequestId = beginAgentStreamRequest();
        void fetchAgentsStream({
          signal: agentStreamAbort.signal,
          onAgent: (agent) => {
            if (cancelled || !isCurrentAgentStreamRequest(agentRequestId)) return;
            setAgents((current) =>
              mergeAmrModelsIntoAgents(
                upsertAgent(current, agent),
                amrModelsRef.current,
              ),
            );
          },
        })
          .then((list) => {
            if (cancelled || !isCurrentAgentStreamRequest(agentRequestId)) return;
            setAgents(
              mergeAmrModelsIntoAgents(
                orderAgentsByRegistry(list),
                amrModelsRef.current,
              ),
            );
          })
          .catch((err) => {
            if (
              cancelled ||
              isAbortError(err) ||
              !isCurrentAgentStreamRequest(agentRequestId)
            ) {
              return;
            }
            setAgents([]);
          })
          .finally(() => {
            if (cancelled || !isCurrentAgentStreamRequest(agentRequestId)) return;
            setAgentsLoading(false);
          });

        void fetchDesignTemplates({ signal: deferredAbort.signal }).then((list) => {
          if (cancelled) return;
          setDesignTemplates(list);
        });

        void listTemplates().then((list) => {
          if (cancelled) return;
          setTemplates(list);
        });

        void fetchAppVersionInfo({ signal: deferredAbort.signal }).then((info) => {
          if (cancelled) return;
          setAppVersionInfo(info);
        });


      });
    })();
    return () => {
      cancelled = true;
      cancelDeferredStartup();
      agentStreamAbort.abort();
      deferredAbort.abort();
    };
  }, [
    beginAgentStreamRequest,
    beginProjectListRequest,
    isCurrentAgentStreamRequest,
    reconcileFetchedProjects,
    t,
  ]);

  // Auto-pick the first available agent once both the daemon-stored config
  // and the agents listing have landed. Splitting this out of bootstrap
  // avoids racing the local-config initial value against a slow agents
  // probe — by the time this runs, daemonConfig has already overlaid the
  // user's previous choice, so we only fill an empty slot.
  //
  // First-run onboarding is the one time we must NOT do this: the onboarding
  // flow is the sole authority for the initial agent pick (AMR is the
  // recommended default there), and AMR (vela) detection is asynchronous. If
  // this fallback fires during onboarding while AMR is still being detected it
  // snaps the slot to the registry-first *detected* agent (Claude) and
  // persists it to the daemon, which then races and clobbers the user's AMR
  // selection on the next launch. Gate on onboardingCompleted so this only
  // backfills an empty slot for returning users.
  useEffect(() => {
    if (!daemonConfigLoaded || agentsLoading) return;
    if (config.onboardingCompleted !== true) return;
    if (config.agentId) return;
    const firstAvailable = agents.find((a) => a.available);
    if (!firstAvailable) return;
    setConfig((prev) => {
      if (prev.agentId) return prev;
      const next: AppConfig = { ...prev, agentId: firstAvailable.id };
      saveConfig(next);
      void syncConfigToDaemon(next);
      return next;
    });
  }, [
    daemonConfigLoaded,
    agentsLoading,
    agents,
    config.agentId,
    config.onboardingCompleted,
  ]);

  // Auto-pick the default design system the same way — only after daemon
  // config has merged so we never overwrite a daemon-stored selection.
  useEffect(() => {
    if (!daemonConfigLoaded || dsLoading) return;
    if (config.designSystemId) return;
    if (designSystems.length === 0) return;
    const id =
      designSystems.find((d) => d.id === 'default')?.id ?? designSystems[0]!.id;
    setConfig((prev) => {
      if (prev.designSystemId) return prev;
      const next: AppConfig = { ...prev, designSystemId: id };
      saveConfig(next);
      void syncConfigToDaemon(next);
      return next;
    });
  }, [daemonConfigLoaded, dsLoading, designSystems, config.designSystemId]);

  // One-shot self-healing migration for pets adopted before the
  // overlay learned atlas-row switching. If the stored pet is a
  // custom / codex pet whose imageUrl is a single-row strip
  // (no atlas), we silently re-download the full spritesheet so
  // hover, drag, and idle-ambient variety all light up on next render.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const upgraded = await migrateCustomPetAtlas(config);
      if (!upgraded || cancelled) return;
      setConfig((prev) => {
        if (!prev.pet) return prev;
        const next: AppConfig = {
          ...prev,
          pet: { ...prev.pet, custom: upgraded },
        };
        saveConfig(next);
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
    // Snapshot the config at mount; migration is one-shot per session
    // and should not re-run every time config changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshProjects = useCallback(async () => {
    const request = beginProjectListRequest();
    const list = await listProjects();
    reconcileFetchedProjects(list, request);
  }, [beginProjectListRequest, reconcileFetchedProjects]);

  const refreshDesignSystems = useCallback(async () => {
    const list = await fetchDesignSystems();
    setDesignSystems(list);
  }, []);

  const refreshSkills = useCallback(async () => {
    const list = await fetchSkills();
    setSkills(list);
  }, []);

  const refreshTemplates = useCallback(async () => {
    const list = await listTemplates();
    setTemplates(list);
  }, []);

  const handleDeleteTemplate = useCallback(async (id: string) => {
    const ok = await deleteTemplate(id);
    if (ok) await refreshTemplates();
    return ok;
  }, [refreshTemplates]);


  /**
   * Autosave-driven persistence path. The settings dialog calls this on
   * every committed edit (via a debounced effect) so localStorage and
   * the daemon stay in lock-step with the user's draft. Onboarding is
   * left alone; the dialog's close path is the canonical "I'm done" signal.
   */
  const handleConfigPersist = useCallback(async (
    next: AppConfig,
  ) => {
    // If the dialog is closing, preserve any onboarding completion that the
    // close gesture already committed so an unmount autosave cannot re-open
    // the welcome flow.
    const persisted = buildPersistedConfig(next, configRef.current);
    latestPersistedConfigRef.current = persisted;
    saveConfig(persisted);
    setConfig(persisted);
    await Promise.all([syncConfigToDaemon(persisted)]);
  }, []);

  const handleModeChange = useCallback(
    (mode: AppConfig['mode']) => {
      const next = { ...config, mode };
      saveConfig(next);
      setConfig(next);
    },
    [config],
  );

  // Quick theme switch from the settings dropdown in the entry view.
  // Skips the full SettingsDialog round-trip so the appearance flip
  // feels instantaneous; the live preview comes for free because the
  // `useLayoutEffect` above re-runs `applyAppearanceToDocument` the
  // moment `config.theme` changes. We still persist to localStorage
  // and the daemon so the choice survives reloads.
  const handleThemeChange = useCallback(
    (theme: AppConfig['theme']) => {
      const next = { ...config, theme };
      saveConfig(next);
      void syncConfigToDaemon(next);
      setConfig(next);
    },
    [config],
  );

  const handleAgentChange = useCallback(
    (agentId: string) => {
      const next = { ...config, agentId };
      saveConfig(next);
      void syncConfigToDaemon(next);
      setConfig(next);
    },
    [config],
  );

  const handleAgentModelChange = useCallback(
    (agentId: string, choice: { model?: string; reasoning?: string }) => {
      const prev = config.agentModels?.[agentId] ?? {};
      const merged = { ...prev, ...choice };
      const nextAgentModels = {
        ...(config.agentModels ?? {}),
        [agentId]: merged,
      };
      const next = { ...config, agentModels: nextAgentModels };
      saveConfig(next);
      void syncConfigToDaemon(next);
      setConfig(next);
    },
    [config],
  );

  // BYOK protocol switch — also flips `mode` to 'api' so the user does
  // not have to take a second step after picking a provider from the
  // inline switcher. The helper preserves any per-protocol fields the
  // user had previously configured for the target protocol.
  const handleApiProtocolChange = useCallback(
    (protocol: ApiProtocol) => {
      const next = switchApiProtocolConfig(config, protocol);
      saveConfig(next);
      void syncConfigToDaemon(next);
      setConfig(next);
    },
    [config],
  );

  // BYOK model picker — patches `model` (and the per-protocol shadow
  // copy) without touching apiKey/baseUrl so the user can swap models
  // mid-session without retyping their key.
  const handleApiModelChange = useCallback(
    (model: string) => {
      const next = updateCurrentApiProtocolConfig(config, { model });
      saveConfig(next);
      void syncConfigToDaemon(next);
      setConfig(next);
    },
    [config],
  );

  const handleChangeDefaultDesignSystem = useCallback(
    (designSystemId: string | null) => {
      const next = { ...config, designSystemId };
      saveConfig(next);
      void syncConfigToDaemon(next);
      setConfig(next);
    },
    [config],
  );

  const refreshAgents = useCallback(
    async (options?: { throwOnError?: boolean; agentCliEnv?: AppConfig['agentCliEnv'] }) => {
      if (options && Object.prototype.hasOwnProperty.call(options, 'agentCliEnv')) {
        const nextConfig = clearStaleAmrModelChoiceOnProfileChange(config, {
          ...config,
          agentCliEnv: options.agentCliEnv ?? {},
        });
        amrModelsRef.current = null;
        saveConfig(nextConfig);
        await syncConfigToDaemon(nextConfig);
        setConfig(nextConfig);
      }
      const agentRequestId = beginAgentStreamRequest();
      setAgentsLoading(true);
      try {
        const next = await fetchAgentsStream({
          onAgent: (agent) => {
            if (!isCurrentAgentStreamRequest(agentRequestId)) return;
            setAgents((current) =>
              mergeAmrModelsIntoAgents(
                upsertAgent(current, agent),
                amrModelsRef.current,
              ),
            );
          },
        });
        const ordered = orderAgentsByRegistry(next);
        if (isCurrentAgentStreamRequest(agentRequestId)) {
          setAgents(mergeAmrModelsIntoAgents(ordered, amrModelsRef.current));
          setAgentsLoading(false);
        }
        return ordered;
      } catch (err) {
        if (!isCurrentAgentStreamRequest(agentRequestId)) return [];
        setAgentsLoading(false);
        if (options?.throwOnError) throw err;
        setAgents([]);
        return [];
      }
    },
    [beginAgentStreamRequest, config, isCurrentAgentStreamRequest],
  );

  useEffect(() => {
    const handleAppConfigChanged = () => {
      void fetchDaemonConfig().then((daemonConfig) => {
        const next = clearStaleAmrModelChoiceOnProfileChange(
          latestPersistedConfigRef.current,
          mergeDaemonConfig(latestPersistedConfigRef.current, daemonConfig),
        );
        latestPersistedConfigRef.current = next;
        saveConfig(next);
        setConfig(next);
        amrModelsRef.current = null;
        restartAmrPolling();
        void refreshAgents();
      });
    };
    window.addEventListener(APP_CONFIG_CHANGED_EVENT, handleAppConfigChanged);
    return () => window.removeEventListener(APP_CONFIG_CHANGED_EVENT, handleAppConfigChanged);
  }, [refreshAgents, restartAmrPolling]);

  const handleCreateProject = useCallback(
    async (
      input: CreateInput & {
        pendingPrompt?: string;
        pluginId?: string;
        pluginType?: string;
        appliedPluginSnapshotId?: string;
        pluginInputs?: Record<string, unknown>;
        conversationMode?: ChatSessionMode;
        autoSendFirstMessage?: boolean;
        requestId?: string;
        pendingFiles?: File[];
        userWorkingDirToken?: string;
      },
    ): Promise<boolean> => {
      // Honor an explicit `null` design system — the create panel defaults
      // to "None" for every kind now, and the user expects that to land
      // as a no-design-system project rather than silently inheriting the
      // workspace default.
      const kind = input.metadata?.kind ?? null;
      const fidelity = fidelityToTracking(input.metadata?.fidelity ?? null);
      const creationSource: 'blank' | 'template' | 'zip' | 'folder' =
        kind === 'template' ? 'template' : 'blank';
      const result = await createProject({
        name: input.name,
        skillId: input.skillId,
        designSystemId: input.designSystemId,
        pendingPrompt: input.pendingPrompt,
        metadata: input.metadata,
        ...(input.conversationMode ? { conversationMode: input.conversationMode } : {}),
        ...(input.pluginId ? { pluginId: input.pluginId } : {}),
        ...(input.appliedPluginSnapshotId
          ? { appliedPluginSnapshotId: input.appliedPluginSnapshotId }
          : {}),
        ...(input.pluginInputs ? { pluginInputs: input.pluginInputs } : {}),
      });
      if (!result) {
        trackProjectCreateResult(
          analytics.track,
          {
            page_name: 'home',
            area: 'new_project',
            project_source: 'create_button',
            project_id: null,
            project_kind: projectKindToTracking(kind),
            fidelity,
            ...(input.pluginId ? { plugin_id: input.pluginId } : {}),
            ...(input.pluginType ? { plugin_type: input.pluginType } : {}),
            result: 'failed',
            error_code: 'CREATE_REQUEST_FAILED',
          },
          { requestId: input.requestId },
        );
        return false;
      }
      const pendingFiles = Array.isArray(input.pendingFiles)
        ? input.pendingFiles.filter((file): file is File => file instanceof File)
        : [];
      // Flip the project onto the user-picked project folder BEFORE
      // uploading staged attachments. `replaceProjectWorkingDir` changes
      // `metadata.baseDir`, so the project starts reading from the external
      // folder. If we uploaded first, the staged files would land in the
      // temporary managed `.readable-studio/projects/<id>` root and then silently vanish
      // from Design Files and the first auto-send context once the project
      // folder flips. Doing the handoff first means the initial upload lands in
      // the final tree.
      const userWorkingDir = input.metadata?.userWorkingDir;
      let workingDirHandoffFailed = false;
      if (userWorkingDir) {
        try {
          await replaceProjectWorkingDir(
            result.project.id,
            userWorkingDir,
            input.userWorkingDirToken,
          );
        } catch (err) {
          // The desktop project-folder token is short-lived (~60s TTL); if the
          // user lingered on Home or the POST was otherwise rejected, the
          // handoff fails AFTER the project already exists. Do NOT swallow
          // this and do NOT proceed: uploading staged attachments or
          // auto-sending the first message would target the managed
          // `.readable-studio/projects/<id>` root the user did not choose. Mark the
          // handoff as failed so the upload + auto-send branches below are
          // skipped, then surface a create-time error so the user can create
          // again after choosing the intended project folder.
          console.warn('Failed to set project folder for new project', userWorkingDir, err);
          workingDirHandoffFailed = true;
          setWorkingDirError(
            `Couldn't apply the chosen folder "${userWorkingDir}". The project was created in the default location. Create it again after choosing the intended project folder before uploading files or sending a message.`,
          );
        }
      }
      let firstMessageAttachments: ChatAttachment[] = [];
      if (!workingDirHandoffFailed && pendingFiles.length > 0) {
        // Home composer attaches stay client-side until submit lands a
        // project; the actual upload happens here. v2 doc wants one
        // file_upload_result per surface — `page_name='home'` /
        // `area='chat_composer'` so it's distinguishable from the
        // file_manager Upload button and the chat_panel composer.
        const cohort = deriveUploadCohort(pendingFiles);
        const uploadResult = await uploadProjectFiles(result.project.id, pendingFiles);
        firstMessageAttachments = uploadResult.uploaded;
        const partial = uploadResult.failed.length > 0;
        if (partial) {
          console.warn('Some Home attachments failed to upload', uploadResult.failed);
        }
        trackFileUploadResult(analytics.track, {
          page_name: 'home',
          area: 'chat_composer',
          project_id: result.project.id,
          ...cohort,
          result: partial ? 'failed' : 'success',
          ...(partial && uploadResult.error
            ? { error_code: uploadResult.error }
            : {}),
        });
      }
      trackProjectCreateResult(
        analytics.track,
        {
          page_name: 'home',
          area: 'new_project',
          project_source: 'create_button',
          project_id: result.project.id,
          project_kind: projectKindToTracking(kind),
          fidelity,
          ...(input.pluginId ? { plugin_id: input.pluginId } : {}),
          ...(input.pluginType ? { plugin_type: input.pluginType } : {}),
          result: 'success',
        },
        { requestId: input.requestId },
      );
      // PluginLoopHome flow: the user already typed (or accepted) the
      // first message on Home. Mark this project so ProjectView fires
      // sendMessage(pendingPrompt) once on mount instead of just
      // pre-filling the composer. Scoped to sessionStorage so a page
      // reload after the run has started does not refire.
      if (
        !workingDirHandoffFailed &&
        input.autoSendFirstMessage &&
        (input.pendingPrompt !== undefined || firstMessageAttachments.length > 0)
      ) {
        try {
          window.sessionStorage.setItem(
            `readable:auto-send-first:${result.project.id}`,
            '1',
          );
          if (firstMessageAttachments.length > 0) {
            window.sessionStorage.setItem(
              `readable:auto-send-attachments:${result.project.id}`,
              JSON.stringify(firstMessageAttachments),
            );
          } else {
            window.sessionStorage.removeItem(
              `readable:auto-send-attachments:${result.project.id}`,
            );
          }
        } catch {
          /* sessionStorage may be unavailable (e.g. SSR / private mode); fall
             back to manual send. */
        }
      }
      const project = result.appliedPluginSnapshotId
        ? {
            ...result.project,
            appliedPluginSnapshotId: result.appliedPluginSnapshotId,
          }
        : result.project;
      rememberLocalProject(project.id);
      flushSync(() => {
        setProjects((curr) => [
          project,
          ...curr.filter((p) => p.id !== project.id),
        ]);
      });
      const projectRoute = {
        kind: 'project',
        projectId: project.id,
        fileName: null,
      } as const;
      openWorkspaceTab(projectRoute);
      navigate(projectRoute);
      return true;
    },
    [analytics.track, rememberLocalProject],
  );

  const handleCreatePluginShareProject = useCallback(
    async (
      pluginId: string,
      action: PluginShareAction,
      locale?: string,
    ): Promise<PluginShareProjectOutcome> => {
      const outcome = await createPluginShareProject(pluginId, action, locale);
      if (!outcome.ok) return outcome;
      try {
        window.sessionStorage.setItem(
          `readable:auto-send-first:${outcome.project.id}`,
          '1',
        );
      } catch {
        // If sessionStorage is unavailable, the project still opens with
        // the prepared prompt in the composer.
      }
      const project = outcome.appliedPluginSnapshotId
        ? {
            ...outcome.project,
            appliedPluginSnapshotId: outcome.appliedPluginSnapshotId,
          }
        : outcome.project;
      rememberLocalProject(project.id);
      setProjects((curr) => [
        project,
        ...curr.filter((p) => p.id !== project.id),
      ]);
      navigate({
        kind: 'project',
        projectId: project.id,
        fileName: null,
      });
      return outcome;
    },
    [rememberLocalProject],
  );

  const handleImportClaudeDesign = useCallback(async (
    file: File,
  ): Promise<ImportClaudeDesignOutcome> => {
    try {
      const result = await importClaudeDesignZip(file);
      rememberLocalProject(result.project.id);
      setProjects((curr) => [
        result.project,
        ...curr.filter((p) => p.id !== result.project.id),
      ]);
      navigate({
        kind: 'project',
        projectId: result.project.id,
        fileName: result.entryFile,
      });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'The ZIP could not be imported.',
      };
    }
  }, [rememberLocalProject]);

  const handleImportFolder = useCallback(async (baseDir: string) => {
    const result = await importFolderProject({ baseDir });
    rememberLocalProject(result.project.id);
    setProjects((curr) => [result.project, ...curr.filter((p) => p.id !== result.project.id)]);
    navigate({
      kind: 'project',
      projectId: result.project.id,
      fileName: null,
    });
  }, [rememberLocalProject]);

  // PR #974: on desktop, the host bridge owns the picker and import POST
  // atomically. The renderer never sees the path, token, or daemon DTO;
  // it receives host-owned project identifiers and refreshes project state
  // through the normal daemon API.
  const handleImportFolderResponse = useCallback(async (result: ReadableStudioHostProjectImportSuccess) => {
    rememberLocalProject(result.projectId);
    const project = await getProject(result.projectId);
    if (project != null) {
      setProjects((curr) => [project, ...curr.filter((p) => p.id !== project.id)]);
    } else {
      // Daemon hasn't materialized the full record yet (race between the
      // host's import POST and our /api/projects read). Seed a minimal
      // placeholder so the route stays alive and ProjectView mounts; the
      // pending-local id keeps reconcileFetchedProjects from evicting the
      // stub until a project-list snapshot actually includes it, and the
      // next refresh swaps it for the real Project record. Without the
      // stub, a stale `[]` list response would replace `projects` with `[]`
      // and the route-guard effect would bounce the user back to Home.
      const stub: Project = {
        id: result.projectId,
        name: '',
        skillId: null,
        designSystemId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      setProjects((curr) => [stub, ...curr.filter((p) => p.id !== stub.id)]);
      const request = beginProjectListRequest();
      const list = await listProjects();
      reconcileFetchedProjects(list, request);
    }
    navigate({
      kind: 'project',
      projectId: result.projectId,
      fileName: null,
    });
  }, [beginProjectListRequest, rememberLocalProject, reconcileFetchedProjects]);

  const handleOpenProject = useCallback((id: string) => {
    navigate({ kind: 'project', projectId: id, fileName: null });
  }, []);

  useEffect(() => {
    if (!config.pet?.enabled || !daemonLive) {
      setPetTaskCenter({ running: [], queued: [], recent: [] });
      return;
    }

    let cancelled = false;
    const refresh = async () => {
      const runs = await listProjectRuns();
      if (cancelled) return;
      setPetTaskCenter(buildPetTaskCenter(projects, runs));
    };
    const handleRunsChanged = () => {
      void refresh();
    };

    void refresh();
    window.addEventListener(RUNS_CHANGED_EVENT, handleRunsChanged);
    const id = window.setInterval(refresh, 2000);
    return () => {
      cancelled = true;
      window.removeEventListener(RUNS_CHANGED_EVENT, handleRunsChanged);
      window.clearInterval(id);
    };
  }, [config.pet?.enabled, daemonLive, projects]);

  const handleDeleteProject = useCallback(async (id: string) => {
    const ok = await deleteProjectApi(id);
    if (!ok) return false;
    clearLocalProject(id, { deleted: true });
    iframeKeepAlivePool.evictProject(id, { includeActive: true });
    setProjects((curr) => curr.filter((p) => p.id !== id));
    if (route.kind === 'project' && route.projectId === id) {
      navigate({ kind: 'home', view: 'home' });
    }
    return true;
  }, [clearLocalProject, iframeKeepAlivePool, route]);

  const handleRenameProject = useCallback(async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setProjects((curr) =>
      curr.map((p) => (p.id === id ? { ...p, name: trimmed } : p)),
    );
    void patchProject(id, { name: trimmed });
  }, []);

  const handleBack = useCallback(() => {
    navigate({ kind: 'home', view: 'home' });
  }, []);

  const handleClearPendingPrompt = useCallback(() => {
    const projectId = route.kind === 'project' ? route.projectId : null;
    if (!projectId) return;
    setProjects((curr) =>
      curr.map((p) =>
        p.id === projectId ? { ...p, pendingPrompt: undefined } : p,
      ),
    );
    void patchProject(projectId, { pendingPrompt: null });
  }, [route]);

  const handleTouchProject = useCallback(() => {
    const projectId = route.kind === 'project' ? route.projectId : null;
    if (!projectId) return;
    const updatedAt = Date.now();
    setProjects((curr) =>
      curr.map((p) => (p.id === projectId ? { ...p, updatedAt } : p)),
    );
    void patchProject(projectId, { updatedAt });
  }, [route]);

  const handleProjectChange = useCallback((updated: Project) => {
    setProjects((curr) => {
      const previous = curr.find((p) => p.id === updated.id);
      if (
        previous
        && (
          previous.skillId !== updated.skillId
          || previous.designSystemId !== updated.designSystemId
          || previous.customInstructions !== updated.customInstructions
        )
      ) {
        iframeKeepAlivePool.evictProject(updated.id, { includeActive: true });
      }
      return curr.map((p) => (p.id === updated.id ? updated : p));
    });
  }, [iframeKeepAlivePool]);

  // ProjectView's prompt-context signature derives from SkillSummary /
  // DesignSystemSummary fields, so a body-only registry edit (same name,
  // description, etc.) leaves every signature unchanged and the active
  // preview keeps serving stale prompt context. Settings → Skills /
  // Settings → Design Systems call back through these handlers after
  // every successful mutation; we drop any pool entry whose project
  // depends on the affected id — active or parked — so the next mount
  // recomposes the system prompt with the new body. A ref tracks
  // projects so the callback is stable across renders.
  const projectsRef = useRef<Project[]>(projects);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  const handleSkillsChanged = useCallback(
    (affectedSkillId?: string) => {
      void fetchSkills().then((list) => setSkills(list));
      void fetchDesignTemplates().then((list) => setDesignTemplates(list));
      iframeKeepAlivePool.evictMatching(
        (entry) => {
          const proj = projectsRef.current.find((p) => p.id === entry.projectId);
          if (!proj) return false;
          if (affectedSkillId) return proj.skillId === affectedSkillId;
          return proj.skillId != null;
        },
        { includeActive: true },
      );
    },
    [iframeKeepAlivePool],
  );

  const handleDesignSystemsChanged = useCallback(
    (affectedDesignSystemId?: string) => {
      void fetchDesignSystems().then((list) => setDesignSystems(list));
      iframeKeepAlivePool.evictMatching(
        (entry) => {
          const proj = projectsRef.current.find((p) => p.id === entry.projectId);
          if (!proj) return false;
          if (affectedDesignSystemId) {
            return proj.designSystemId === affectedDesignSystemId;
          }
          return proj.designSystemId != null;
        },
        { includeActive: true },
      );
    },
    [iframeKeepAlivePool],
  );
  const handleDesignSystemImportRebuildJob = useCallback(
    (designSystemId: string, job: DesignSystemGenerationJob) => {
      setPendingDesignSystemRevisionJobs((current) => ({
        ...current,
        [designSystemId]: job,
      }));
    },
    [],
  );
  const handleDesignSystemRevisionJobConsumed = useCallback((designSystemId: string, jobId: string) => {
    setPendingDesignSystemRevisionJobs((current) => {
      if (current[designSystemId]?.id !== jobId) return current;
      const next = { ...current };
      delete next[designSystemId];
      return next;
    });
  }, []);

  const activeProject =
    route.kind === 'project'
      ? (projects.find((p) => p.id === route.projectId) ?? null)
      : null;

  // Deep-linked route to a project we don't have yet (e.g. after a refresh
  // that finishes after the project list comes back). Fetch it in the
  // background so the view can render rather than bouncing to home.
  useEffect(() => {
    if (route.kind !== 'project') return;
    if (activeProject) return;
    if (!projects.length && !daemonLive) return;
    if (projects.some((p) => p.id === route.projectId)) return;
    let cancelled = false;
    (async () => {
      const project = await getProject(route.projectId);
      if (cancelled) return;
      if (project) {
        setProjects((curr) => {
          const existingIndex = curr.findIndex((candidate) => candidate.id === project.id);
          if (existingIndex < 0) {
            return [...curr, project];
          }
          return curr.map((candidate) => (candidate.id === project.id ? project : candidate));
        });
        return;
      }
      const request = beginProjectListRequest();
      const list = await listProjects();
      if (cancelled) return;
      const applied = reconcileFetchedProjects(list, request);
      if (!applied) return;
      const fetchedProject = locallyDeletedProjectIdsRef.current.has(route.projectId)
        ? undefined
        : list.find((p) => p.id === route.projectId);
      const staleRequest = request.mutationVersion < projectListMutationVersionRef.current;
      const knownLocalProject =
        staleRequest && pendingLocalProjectIdsRef.current.has(route.projectId);
      if (!fetchedProject && !knownLocalProject) {
        navigate({ kind: 'home', view: 'home' }, { replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [route, activeProject, projects, daemonLive, beginProjectListRequest, reconcileFetchedProjects]);

  const openSettings = useCallback((
    section: SettingsSection = 'execution',
    opts?: { highlight?: SettingsHighlight },
  ) => {
    if (section === 'mcpClient' || section === 'integrations') {
      setIntegrationInitialTab(section === 'mcpClient' ? 'mcp' : 'use-everywhere');
      navigate({ kind: 'home', view: 'integrations' });
      return;
    }
    setSettingsWelcome(false);
    setSettingsInitialSection(section);
    setSettingsHighlight(opts?.highlight ?? null);
    setSettingsOpen(true);
    if (section === 'codeAgents' || section === 'execution') {
      void refreshAgents();
    }
  }, [refreshAgents]);

  // Entry point from the failed-run AMR nudge: open Settings on the execution
  // section and flag the AMR agent card for a one-shot scroll-into-view +
  // highlight (and a sign-in coachmark when not yet authorized).
  const openAmrSettings = useCallback(() => {
    openSettings('execution', { highlight: 'amr' });
  }, [openSettings]);

  const openPetSettings = useCallback(() => {
    setSettingsWelcome(false);
    setSettingsInitialSection('pet');
    setSettingsOpen(true);
  }, []);

  const openMcpSettings = useCallback(() => {
    setIntegrationInitialTab('mcp');
    navigate({ kind: 'home', view: 'integrations' });
  }, []);

  // The composer "+" menu's "add plugin" row routes to the home plugin-registry.
  const openPluginRegistry = useCallback(() => {
    navigate({ kind: 'home', view: 'plugins' });
  }, []);

  const handleCompleteOnboarding = useCallback(() => {
    const current = latestPersistedConfigRef.current;
    if (current.onboardingCompleted) return;
    const next: AppConfig = { ...current, onboardingCompleted: true };
    latestPersistedConfigRef.current = next;
    saveConfig(next);
    void syncConfigToDaemon(next);
    setConfig(next);
  }, []);

  // Cmd+, (mac) / Ctrl+, (win/linux) opens Settings. Capture phase so we
  // beat the browser's default Preferences dialog. Platform-gated so
  // meta/ctrl don't conflict across OS.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const primary = isMacPlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (primary && !e.shiftKey && !e.altKey && e.key === ',') {
        if (e.isComposing) return;
        e.preventDefault();
        openSettings();
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [openSettings]);

  // Explicit enabled toggle — true = wake, false = tuck. Persists to
  // localStorage so the overlay state survives across reloads. We keep
  // `adopted` untouched so the entry-view CTA does not regress to
  // "adopt me" once the user has already chosen.
  const handleSetPetEnabled = useCallback((enabled: boolean) => {
    setConfig((curr) => {
      const prev = curr.pet ?? DEFAULT_PET;
      const next: AppConfig = { ...curr, pet: { ...prev, enabled } };
      saveConfig(next);
      return next;
    });
  }, []);

  const handleTuckPet = useCallback(
    () => handleSetPetEnabled(false),
    [handleSetPetEnabled],
  );

  // Toggle wake/tuck — used by the pet rail and the composer button.
  const handleTogglePet = useCallback(() => {
    setConfig((curr) => {
      const prev = curr.pet ?? DEFAULT_PET;
      const next: AppConfig = {
        ...curr,
        pet: { ...prev, enabled: !prev.enabled },
      };
      saveConfig(next);
      return next;
    });
  }, []);

  // Inline adopt — the right-hand pet rail and the composer's pet menu
  // both call this to switch pets without bouncing the user into
  // Settings. It always wakes the overlay so the change is visible.
  const handleAdoptPet = useCallback((petId: string) => {
    setConfig((curr) => {
      const prev = curr.pet ?? DEFAULT_PET;
      const next: AppConfig = {
        ...curr,
        pet: { ...prev, adopted: true, enabled: true, petId },
      };
      saveConfig(next);
      return next;
    });
  }, []);

  // When the user lands on the entry view (route.kind === 'home'), pull
  // a fresh template list. The template store is global — if they just
  // saved a template inside a project, returning home should reflect it
  // immediately in the From-template tab without forcing a page reload.
  useEffect(() => {
    if (route.kind !== 'home') return;
    if (!startupDeferredReady) return;
    void refreshTemplates();
  }, [route.kind, refreshTemplates, startupDeferredReady]);

  // Existing card grids (DesignsTab, ProjectView), pickers (NewProjectPanel,
  // ChatComposer mention) all look skills up by id without caring whether
  // the id resolves to a functional skill or a design template. Pass them
  // the union so the post-split refactor stays invisible to those callers.
  const allSkillSummaries = useMemo(
    () => [...skills, ...designTemplates],
    [skills, designTemplates],
  );
  const enabledSkills = useMemo(
    () =>
      allSkillSummaries.filter(
        (s) => !(config.disabledSkills ?? []).includes(s.id),
      ),
    [allSkillSummaries, config.disabledSkills],
  );
  // Functional-skills-only enabled subset — what ProjectView's chat
  // composer @-picker should see. Without this, a skill the user has
  // disabled in Settings still appears in an existing project's @-mention
  // popover and can ride along to the daemon via skillIds, breaking the
  // Library toggle for projects opened on the post-split branch.
  const enabledFunctionalSkills = useMemo(
    () =>
      skills.filter(
        (s) => !(config.disabledSkills ?? []).includes(s.id),
      ),
    [skills, config.disabledSkills],
  );
  // Templates-only enabled subset — what the EntryView Templates gallery
  // actually renders. Filtering in App keeps the EntryView prop surface
  // narrow ("here are the templates the user has not disabled").
  const enabledDesignTemplates = useMemo(
    () =>
      designTemplates.filter(
        (s) => !(config.disabledSkills ?? []).includes(s.id),
      ),
    [designTemplates, config.disabledSkills],
  );
  const enabledDS = useMemo(
    () =>
      designSystems.filter(
        (d) => !(config.disabledDesignSystems ?? []).includes(d.id),
      ),
    [designSystems, config.disabledDesignSystems],
  );

  // Phase 2B / spec §11.6 — marketplace deep UI dispatch. The
  // /marketplace and /marketplace/:id routes render outside the
  // EntryView / ProjectView split so the discovery surface stays
  // independent of any active project.
  let appMain: ReactNode;
  if (route.kind === 'marketplace') {
    appMain = <MarketplaceView />;
  } else if (route.kind === 'marketplace-detail') {
    appMain = <PluginDetailView pluginId={route.pluginId} />;
  } else if (route.kind === 'design-system-create') {
    appMain = (
      <DesignSystemCreationFlow
        onBack={() => navigate({ kind: 'home', view: 'design-systems' })}
        onCreated={(projectId, project) => {
          if (project) {
            setProjects((curr) => [
              project,
              ...curr.filter((p) => p.id !== project.id),
            ]);
          }
          navigate({ kind: 'project', projectId, conversationId: null, fileName: null });
        }}
        onProjectPrepared={(project) => {
          setProjects((curr) => [
            project,
            ...curr.filter((p) => p.id !== project.id),
          ]);
        }}
        onSystemsRefresh={refreshDesignSystems}
        config={config}
      />
    );
  } else if (route.kind === 'design-system-detail') {
    appMain = (
      <DesignSystemDetailView
        id={route.designSystemId}
        selectedId={config.designSystemId}
        config={config}
        agents={agents}
        onBack={() => navigate({ kind: 'home', view: 'design-systems' })}
        onOpenProject={(projectId) => navigate({ kind: 'project', projectId, conversationId: null, fileName: null })}
        onSetDefault={handleChangeDefaultDesignSystem}
        onSystemsRefresh={refreshDesignSystems}
        onProjectsRefresh={refreshProjects}
        initialRevisionJob={pendingDesignSystemRevisionJobs[route.designSystemId] ?? null}
        onInitialRevisionJobConsumed={(jobId) =>
          handleDesignSystemRevisionJobConsumed(route.designSystemId, jobId)
        }
      />
    );
  } else if (activeProject) {
    appMain = (
      <ProjectView
        key={activeProject.id}
        project={activeProject}
        routeFileName={route.kind === 'project' ? route.fileName : null}
        routeConversationId={route.kind === 'project' ? route.conversationId : null}
        config={config}
        agents={agents}
        skills={enabledFunctionalSkills}
        designTemplates={designTemplates}
        designSystems={designSystems}
        daemonLive={daemonLive}
        onModeChange={handleModeChange}
        onAgentChange={handleAgentChange}
        onAgentModelChange={handleAgentModelChange}
        onRefreshAgents={refreshAgents}
        onThemeChange={handleThemeChange}
        onOpenSettings={openSettings}
        onOpenAmrSettings={openAmrSettings}
        onOpenMcpSettings={openMcpSettings}
        onBrowsePlugins={openPluginRegistry}
        onAdoptPetInline={handleAdoptPet}
        onTogglePet={handleTogglePet}
        onOpenPetSettings={openPetSettings}
        onBack={handleBack}
        onClearPendingPrompt={handleClearPendingPrompt}
        onTouchProject={handleTouchProject}
        onProjectChange={handleProjectChange}
        onProjectsRefresh={refreshProjects}
        onChangeDefaultDesignSystem={handleChangeDefaultDesignSystem}
        onDesignSystemsRefresh={refreshDesignSystems}
      />
    );
  } else {
    appMain = (
      <EntryView
        skills={enabledSkills}
        designTemplates={enabledDesignTemplates}
        designSystems={enabledDS}
        projects={projects}
        templates={templates}
        onDeleteTemplate={handleDeleteTemplate}
        defaultDesignSystemId={config.designSystemId}
        agents={agents}
        agentsLoading={agentsLoading}
        config={config}
        providerModelsCache={providerModelsCache}
        onProviderModelsCacheChange={setProviderModelsCache}
        integrationInitialTab={integrationInitialTab}
        daemonLive={daemonLive}
        onModeChange={handleModeChange}
        onAgentChange={handleAgentChange}
        onAgentModelChange={handleAgentModelChange}
        onApiProtocolChange={handleApiProtocolChange}
        onApiModelChange={handleApiModelChange}
        onConfigPersist={handleConfigPersist}
        onRefreshAgents={refreshAgents}
        onThemeChange={handleThemeChange}
        skillsLoading={skillsLoading}
        designSystemsLoading={dsLoading}
        projectsLoading={projectsLoading}
        onCreateProject={handleCreateProject}
        onCreatePluginShareProject={handleCreatePluginShareProject}
        onImportClaudeDesign={handleImportClaudeDesign}
        onImportFolder={handleImportFolder}
        onImportFolderResponse={handleImportFolderResponse}
        onOpenProject={handleOpenProject}
        onDeleteProject={handleDeleteProject}
        onRenameProject={handleRenameProject}
        onChangeDefaultDesignSystem={handleChangeDefaultDesignSystem}
        onCreateDesignSystem={() => navigate({ kind: 'design-system-create' })}
        onOpenDesignSystem={(id: string) => navigate({ kind: 'design-system-detail', designSystemId: id })}
        onDesignSystemsRefresh={refreshDesignSystems}
        onOpenSettings={openSettings}
        onCompleteOnboarding={handleCompleteOnboarding}
      />
    );
  }
  return (
    <>
      <div
        className={`workspace-shell workspace-shell--${clientType}`}
        data-client-type={clientType}
      >
        <WorkspaceTabsBar
          route={route}
          projects={projects}
          onboardingCompleted={config.onboardingCompleted === true}
        />
        <div className="workspace-shell__body">
          {appMain}
        </div>
      </div>
      {clientType === 'desktop' ? null : (
        <PetOverlay
          pet={config.pet?.enabled ? config.pet : undefined}
          taskCenter={petTaskCenter}
          onOpenProject={handleOpenProject}
        />
      )}
      <TooltipLayer />
      <AnimatePresence>
      {settingsOpen ? (
        <SettingsDialog
          initial={config}
          agents={agents}
          agentsLoading={agentsLoading}
          daemonLive={daemonLive}
          appVersionInfo={appVersionInfo}
          welcome={settingsWelcome}
          initialSection={settingsInitialSection}
          initialHighlight={settingsHighlight}
          onPersist={handleConfigPersist}
          onClose={() => {
            // Closing the dialog is the canonical "I'm done" gesture
            // now that there is no global Save button. We mark
            // onboardingCompleted on close so the welcome modal stops
            // re-prompting on every refresh, regardless of whether
            // the user changed anything during the session.
            const next = resolveSettingsCloseConfig(config, latestPersistedConfigRef.current);
            if (!next.onboardingCompleted || !config.onboardingCompleted) {
              latestPersistedConfigRef.current = next;
              saveConfig(next);
              void syncConfigToDaemon(next);
              setConfig(next);
            }
            setSettingsOpen(false);
            setSettingsHighlight(null);
          }}
          onRefreshAgents={refreshAgents}
          onAmrLoginStatusChange={handleAmrLoginStatusChange}
          onSkillsRefresh={refreshSkills}
          onProjectsRefresh={refreshProjects}
          onSkillsChanged={handleSkillsChanged}
          onDesignSystemsChanged={handleDesignSystemsChanged}
          onDesignSystemImportRebuildJob={handleDesignSystemImportRebuildJob}
          providerModelsCache={providerModelsCache}
          onProviderModelsCacheChange={setProviderModelsCache}
        />
      ) : null}
      </AnimatePresence>
      <MemoryToast onOpenMemory={() => openSettings('memory')} />
      {workingDirError ? (
        <Toast
          message={workingDirError}
          role="alert"
          onDismiss={() => setWorkingDirError(null)}
        />
      ) : null}
    </>
  );
}
