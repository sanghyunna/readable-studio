// InlineModelSwitcher — top-bar chip exposing CLI/BYOK + model picker.
//
// Lives in the entry view's sticky top-bar so users can swap between a
// local CLI and BYOK (and the active model under either) without having
// to open the full Settings dialog. The chip is intentionally narrow —
// it shows the active mode + agent/provider + model in one line and
// opens a compact popover for switching. All persistence is delegated
// upward through the same callbacks `AvatarMenu` already uses, so the
// switcher inherits autosave + daemon sync without re-implementing it.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import {
  agentIdToTracking,
  byokProtocolToTracking,
  modelIdForTracking,
} from '@readable-studio/contracts/analytics';
import { useAnalytics } from '../analytics/provider';
import { recordAmrEntry, type AmrEntryAttribution } from '../analytics/amr-attribution';
import { trackExecutionSettingsPopoverClick } from '../analytics/events';
import {
  beginAmrAuthTracking,
  resolveAmrAuthTracking,
} from '../analytics/amr-auth';
import { KNOWN_PROVIDERS } from '../state/config';
import { fetchProviderModels } from '../providers/provider-models';
import { SUGGESTED_MODELS_BY_PROTOCOL } from '../state/apiProtocols';
import {
  cancelVelaLogin,
  fetchVelaLoginStatus,
  startVelaLogin,
  type VelaLoginStatus,
} from '../providers/daemon';
import type { AgentInfo, ApiProtocol, AppConfig, ExecMode } from '../types';
import { apiProtocolLabel } from '../utils/apiProtocol';
import { AgentIcon } from './AgentIcon';
import { Icon } from './Icon';
import {
  AMR_LOGIN_STATUS_EVENT,
  AMR_LOGIN_POLL_INTERVAL_MS,
  AMR_LOGIN_STARTUP_SETTLE_MS,
  amrLoginPollOutcome,
  amrLoginStatusEventReason,
  notifyAmrLoginStatusChanged,
} from './amrLoginPolling';
import { normalizeAgentModelChoice } from './agentModelSelection';
import { SearchableModelSelect } from './modelOptions';
import { dedupeAgentModels } from './modelCatalog';
import { placePopover } from './popoverPlacement';
import {
  mergeProviderModelOptions,
  providerModelsCacheKey,
  type ProviderModelsCache,
} from './providerModelsCache';

/**
 * Which concern the mount exposes.
 *
 * `combined` is the historical top-bar chip (mode + agent + model in one
 * popover). The Hub composer footer instead mounts the SAME component twice —
 * once as `agent`, once as `model` — so each button opens only its own
 * concern. Splitting by variant (rather than forking a second component) keeps
 * exactly one implementation of agent selection, model selection, the AMR
 * login dance and the provider-models fetch.
 */
export type InlineSwitcherVariant = 'combined' | 'agent' | 'model';

interface Props {
  config: AppConfig;
  agents: AgentInfo[];
  agentsLoading?: boolean;
  providerModelsCache?: ProviderModelsCache;
  compact?: boolean;
  variant?: InlineSwitcherVariant;
  daemonLive: boolean;
  onModeChange: (mode: ExecMode) => void;
  onAgentChange: (id: string) => void;
  onAgentModelChange: (
    id: string,
    choice: { model?: string; reasoning?: string },
  ) => void;
  onApiProtocolChange: (protocol: ApiProtocol) => void;
  onApiModelChange: (model: string) => void;
  /** Lets the home picker warm the shared cache itself. Without it the picker
   *  only READS the cache (warmed by Settings/onboarding), so on a fresh load
   *  the BYOK list falls back to the small static seed list. */
  onProviderModelsCacheChange?: Dispatch<SetStateAction<ProviderModelsCache>>;
  onOpenSettings: (
    section?:
      | 'execution'
      | 'language'
      | 'appearance'
      | 'notifications'
      | 'pet'
      | 'about',
  ) => void;
}

const API_PROTOCOL_TABS: Array<{ id: ApiProtocol; title: string }> = [
  { id: 'anthropic', title: 'Anthropic' },
  { id: 'openai', title: 'OpenAI' },
  { id: 'azure', title: 'Azure' },
  { id: 'google', title: 'Google' },
  { id: 'aihubmix', title: 'AIHubMix' },
];

const AMR_REMINDER_SEEN_KEY = 'readable-studio:inline-amr-cli-reminder-seen:v2';
let amrReminderSeenFallback = false;

function readAmrReminderSeen(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage
      ? window.localStorage.getItem(AMR_REMINDER_SEEN_KEY) === '1'
      : amrReminderSeenFallback;
  } catch {
    return amrReminderSeenFallback;
  }
}

function markAmrReminderSeen(): void {
  if (typeof window === 'undefined') return;
  try {
    if (window.localStorage) {
      window.localStorage.setItem(AMR_REMINDER_SEEN_KEY, '1');
      return;
    }
  } catch {
    // Ignore storage failures; the reminder is purely advisory UI.
  }
  amrReminderSeenFallback = true;
}

function displayAgentName(agent: Pick<AgentInfo, 'id' | 'name'>): string {
  return agent.id === 'amr' ? 'Readable Studio AMR' : agent.name;
}

function displayAgentChipName(agent: Pick<AgentInfo, 'id' | 'name'>): string {
  return agent.id === 'amr' ? 'AMR' : displayAgentName(agent);
}

export function InlineModelSwitcher({
  config,
  agents,
  agentsLoading = false,
  providerModelsCache,
  compact = false,
  variant = 'combined',
  daemonLive,
  onModeChange,
  onAgentChange,
  onAgentModelChange,
  onApiProtocolChange,
  onApiModelChange,
  onProviderModelsCacheChange,
  onOpenSettings,
}: Props) {
  const t = useT();
  const analytics = useAnalytics();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const [popoverPos, setPopoverPos] = useState<
    { left: number; top: number } | null
  >(null);
  // The panel is portaled out of the anchor, so context rules that used to
  // match by ancestry (`.home-hero__execution-switcher .inline-switcher__popover`)
  // no longer apply. The host surface is resolved at open time and mirrored
  // onto the portaled node, the same way SessionModeToggle does it.
  const [surface, setSurface] = useState<'home-hero' | null>(null);
  const providerModelsFetchingRef = useRef<Set<string>>(new Set());
  const [amrStatus, setAmrStatus] = useState<VelaLoginStatus | null>(null);
  const [amrLoginPending, setAmrLoginPending] = useState(false);
  const [amrLoginError, setAmrLoginError] = useState<string | null>(null);
  const [amrReminderSeen, setAmrReminderSeen] = useState(readAmrReminderSeen);
  const [showAmrReminderInPopover, setShowAmrReminderInPopover] =
    useState(false);
  const amrPollRef = useRef<number | null>(null);
  const amrLoginStartedAtRef = useRef<number | null>(null);

  const stopAmrPolling = useCallback(() => {
    if (amrPollRef.current !== null) {
      window.clearInterval(amrPollRef.current);
      amrPollRef.current = null;
    }
  }, []);

  const refreshAmrStatus = useCallback(async () => {
    const next = await fetchVelaLoginStatus();
    if (next) {
      setAmrStatus(next);
      const pendingStartup =
        amrLoginStartedAtRef.current !== null &&
        Date.now() - amrLoginStartedAtRef.current < AMR_LOGIN_STARTUP_SETTLE_MS;
      if (next.loggedIn) {
        amrLoginStartedAtRef.current = null;
        setAmrLoginPending(false);
      } else if (next.loginInFlight) {
        setAmrLoginPending(true);
      } else if (!pendingStartup) {
        amrLoginStartedAtRef.current = null;
        setAmrLoginPending(false);
      }
    }
    return next;
  }, []);

  const startAmrPolling = useCallback((startedAt = Date.now()) => {
    stopAmrPolling();
    amrLoginStartedAtRef.current = startedAt;
    const tick = async () => {
      const next = await refreshAmrStatus();
      const outcome = amrLoginPollOutcome(next, startedAt);
      if (outcome === 'signed-in') {
        resolveAmrAuthTracking(analytics.track, 'success', undefined, {
          signedInUserId: next?.user?.id ?? null,
        });
        notifyAmrLoginStatusChanged();
        stopAmrPolling();
        amrLoginStartedAtRef.current = null;
        setAmrLoginPending(false);
        return;
      }
      if (outcome === 'stopped' || outcome === 'timed-out') {
        stopAmrPolling();
        if (outcome === 'timed-out') {
          resolveAmrAuthTracking(analytics.track, 'timeout', 'login_timeout');
          void cancelVelaLogin().then(() =>
            notifyAmrLoginStatusChanged('login-canceled'),
          );
        } else {
          resolveAmrAuthTracking(analytics.track, 'failed', 'login_stopped');
        }
        amrLoginStartedAtRef.current = null;
        setAmrLoginPending(false);
        setAmrLoginError(t('settings.amrLoginErrorCompact'));
      }
    };
    amrPollRef.current = window.setInterval(() => {
      void tick();
    }, AMR_LOGIN_POLL_INTERVAL_MS);
  }, [analytics.track, refreshAmrStatus, stopAmrPolling, t]);

  const handleAmrSignIn = useCallback(async (
    attribution?: AmrEntryAttribution | null,
  ) => {
    const startedAt = Date.now();
    amrLoginStartedAtRef.current = startedAt;
    setAmrLoginError(null);
    setAmrLoginPending(true);
    beginAmrAuthTracking(attribution, startedAt);
    const result = await startVelaLogin(attribution);
    if (!result.ok && !result.alreadyRunning) {
      resolveAmrAuthTracking(analytics.track, 'failed', 'spawn_failed');
      amrLoginStartedAtRef.current = null;
      setAmrLoginPending(false);
      setAmrLoginError(result.error || t('settings.amrLoginErrorCompact'));
      return;
    }
    notifyAmrLoginStatusChanged('login-started');
    startAmrPolling(startedAt);
  }, [analytics.track, startAmrPolling, t]);

  const handleAmrCancelLogin = useCallback(async () => {
    resolveAmrAuthTracking(analytics.track, 'cancelled');
    stopAmrPolling();
    amrLoginStartedAtRef.current = null;
    setAmrLoginError(null);
    setAmrLoginPending(false);
    await cancelVelaLogin();
    notifyAmrLoginStatusChanged('login-canceled');
    await refreshAmrStatus();
  }, [analytics.track, refreshAmrStatus, stopAmrPolling]);

  const handleAgentButtonClick = useCallback(
    async (agentId: string) => {
      trackExecutionSettingsPopoverClick(analytics.track, {
        page_name: 'home',
        area: 'execution_settings_popover',
        element: 'agent_card',
        cli_provider_id: agentIdToTracking(agentId),
      });
      onAgentChange?.(agentId);
      if (agentId !== 'amr') return;
      if (amrLoginPending) {
        await handleAmrCancelLogin();
        return;
      }
      const attribution = recordAmrEntry(
        analytics.track,
        'inline_model_switcher_amr_row',
      );
      const latest = await refreshAmrStatus();
      if (latest?.loggedIn) return;
      await handleAmrSignIn(attribution);
    },
    [
      amrLoginPending,
      analytics.track,
      handleAmrCancelLogin,
      handleAmrSignIn,
      onAgentChange,
      refreshAmrStatus,
    ],
  );

  // Keep the panel inside the viewport from every mount point, and follow the
  // anchor when the window resizes or an ancestor scrolls.
  useLayoutEffect(() => {
    if (!open) {
      setPopoverPos(null);
      return undefined;
    }
    const place = () => {
      const anchor = wrapRef.current;
      const popover = popoverRef.current;
      if (!anchor || !popover) return;
      const anchorBox = anchor.getBoundingClientRect();
      const width = popover.offsetWidth;
      if (width === 0) return;
      const viewportWidth =
        window.innerWidth || document.documentElement.clientWidth;
      const viewportHeight =
        window.innerHeight || document.documentElement.clientHeight;
      setPopoverPos(
        placePopover(
          anchorBox,
          { width, height: popover.offsetHeight },
          { width: viewportWidth, height: viewportHeight },
        ),
      );
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      const target = e.target as Node;
      if (wrapRef.current.contains(target)) return;
      // The model picker (`SearchableModelSelect`) renders its option list in a
      // portal on `document.body`, so a click on an option lands OUTSIDE
      // `wrapRef`. Without this guard the mousedown would close the whole
      // switcher panel before the option's click fires, unmounting the picker
      // and dropping the selection — the model would never change.
      // The panel itself is portaled to <body> (it must escape the Hub
      // composer card's `overflow: hidden` + backdrop-filter clip), so a click
      // inside it also lands outside `wrapRef`.
      if (
        target instanceof Element &&
        (target.closest('.model-select-searchable__popover') ||
          target.closest('.inline-switcher__popover'))
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      // Focus returns to the trigger so the panel is not a keyboard dead end.
      chipRef.current?.focus();
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open && agents.some((agent) => agent.id === 'amr' && agent.available)) {
      void refreshAmrStatus();
    }
    return () => stopAmrPolling();
  }, [agents, open, refreshAmrStatus, stopAmrPolling]);

  useEffect(() => {
    const onStatusChange = (event: Event) => {
      const reason = amrLoginStatusEventReason(event);
      if (reason === 'login-started') {
        const startedAt = Date.now();
        amrLoginStartedAtRef.current = startedAt;
        setAmrLoginError(null);
        setAmrLoginPending(true);
        startAmrPolling(startedAt);
      } else if (reason === 'login-canceled') {
        amrLoginStartedAtRef.current = null;
        stopAmrPolling();
        setAmrLoginPending(false);
      }
      void refreshAmrStatus().then((next) => {
        if (next?.loggedIn) {
          amrLoginStartedAtRef.current = null;
          stopAmrPolling();
          return;
        }
        if (next?.loginInFlight) startAmrPolling();
      });
    };
    window.addEventListener(AMR_LOGIN_STATUS_EVENT, onStatusChange);
    return () => {
      window.removeEventListener(AMR_LOGIN_STATUS_EVENT, onStatusChange);
    };
  }, [refreshAmrStatus, startAmrPolling, stopAmrPolling]);

  const installedAgents = useMemo(
    () => agents.filter((a) => a.available),
    [agents],
  );
  const currentAgent = useMemo(
    () => agents.find((a) => a.id === config.agentId) ?? null,
    [agents, config.agentId],
  );
  const amrInstalled = installedAgents.some((a) => a.id === 'amr');
  const shouldOfferAmrReminder =
    config.mode === 'daemon' && config.agentId !== 'amr' && amrInstalled;
  const showAmrReminder = shouldOfferAmrReminder && !amrReminderSeen;

  const currentChoice =
    (config.agentId && config.agentModels?.[config.agentId]) || {};
  const normalizedCurrentChoice = normalizeAgentModelChoice(
    currentAgent,
    currentChoice,
  );
  const currentAgentId = currentAgent?.id ?? null;
  const normalizedCurrentModelId = normalizedCurrentChoice?.model ?? null;
  const normalizedCurrentReasoning = normalizedCurrentChoice?.reasoning;
  const currentAgentModelIds = currentAgent?.models?.map((m) => m.id) ?? [];
  const configuredModelId =
    typeof currentChoice.model === 'string' && currentChoice.model
      ? currentChoice.model
      : null;
  const currentModelId =
    currentAgent?.id === 'amr' &&
    configuredModelId &&
    !currentAgentModelIds.includes(configuredModelId)
      ? currentAgent?.models?.[0]?.id ?? null
      : configuredModelId ?? currentAgent?.models?.[0]?.id ?? null;

  useEffect(() => {
    if (!currentAgentId || !normalizedCurrentModelId) return;
    onAgentModelChange(currentAgentId, {
      model: normalizedCurrentModelId,
      reasoning: normalizedCurrentReasoning,
    });
  }, [
    currentAgentId,
    normalizedCurrentModelId,
    normalizedCurrentReasoning,
    onAgentModelChange,
  ]);

  // One coherent, correctly-named set: alias/id pairs the daemon reports
  // separately (`sonnet` + `claude-sonnet-4-5`) collapse into a single honest
  // entry that still executes the canonical id. Nothing is invented or dropped.
  const agentModelChoices = useMemo(
    () => dedupeAgentModels(currentAgent?.models ?? []),
    [currentAgent],
  );

  const currentModelLabel =
    agentModelChoices.find((m) => m.id === currentModelId)?.label ??
    currentAgent?.models?.find((m) => m.id === currentModelId)?.label ??
    null;
  const amrLoggedIn = amrStatus?.loggedIn === true;
  const amrActionLabel = amrLoginPending
    ? t('settings.amrSigningIn')
    : amrLoggedIn
      ? t('settings.amrSignedIn')
      : t('settings.amrSignIn');
  const amrPendingHoverLabel = t('settings.amrCancelSignIn');
  const amrInlineStatus = amrLoginError
    ? amrLoginError
    : amrLoggedIn
      ? t('settings.amrSignedIn')
      : amrLoginPending
        ? t('settings.amrSigningIn')
        : t('settings.amrSignIn');
  const amrStatusIconName = amrLoggedIn
      ? 'check'
      : amrLoginPending
        ? 'spinner'
        : null;

  const apiProtocol = config.apiProtocol ?? 'anthropic';
  const providerForProtocol = useMemo(
    () =>
      KNOWN_PROVIDERS.find(
        (p) =>
          p.protocol === apiProtocol &&
          (config.apiProviderBaseUrl
            ? p.baseUrl === config.apiProviderBaseUrl
            : false),
      ) ?? KNOWN_PROVIDERS.find((p) => p.protocol === apiProtocol),
    [apiProtocol, config.apiProviderBaseUrl],
  );
  const providerModelsKey = useMemo(
    () =>
      providerModelsCacheKey(
        apiProtocol,
        config.baseUrl,
        config.apiKey,
        config.apiVersion ?? '',
      ),
    [apiProtocol, config.apiKey, config.apiVersion, config.baseUrl],
  );
  const fetchedApiModelOptions = providerModelsCache?.[providerModelsKey] ?? [];

  // Warm the shared provider-models cache from the home picker itself. The
  // picker otherwise depends on Settings/onboarding having fetched first, so on
  // a fresh load the BYOK list shows only the small static seed list instead of
  // the live catalogue. We fetch when the panel is open in BYOK mode and the
  // preconditions for the active protocol are met (AIHubMix's catalogue is
  // public, so it needs no key; every other protocol needs one). Results are
  // keyed identically to Settings (`providerModelsKey`), so a single fetch
  // serves both surfaces and replaces any stale slot.
  useEffect(() => {
    if (!open || config.mode !== 'api' || !onProviderModelsCacheChange) return;
    if (apiProtocol === 'azure' || apiProtocol === 'ollama') return;
    if (apiProtocol !== 'aihubmix' && !config.apiKey.trim()) return;
    const baseUrl = config.baseUrl.trim();
    if (!/^https?:\/\//i.test(baseUrl)) return;
    const key = providerModelsKey;
    if (fetchedApiModelOptions.length) return;
    if (providerModelsFetchingRef.current.has(key)) return;
    providerModelsFetchingRef.current.add(key);
    let active = true;
    void fetchProviderModels({
      protocol: apiProtocol,
      baseUrl,
      apiKey: config.apiKey,
    })
      .then((result) => {
        if (active && result.ok && result.models?.length) {
          onProviderModelsCacheChange((current) => ({
            ...current,
            [key]: result.models ?? [],
          }));
        }
      })
      .catch(() => {
        // Non-fatal: the picker falls back to the static seed list.
      })
      .finally(() => {
        providerModelsFetchingRef.current.delete(key);
      });
    return () => {
      active = false;
    };
  }, [
    open,
    config.mode,
    config.apiKey,
    config.baseUrl,
    apiProtocol,
    providerModelsKey,
    fetchedApiModelOptions.length,
    onProviderModelsCacheChange,
  ]);

  const suggestedApiModelIds = useMemo(
    () =>
      Array.from(
        new Set(
          providerForProtocol?.models?.length
            ? providerForProtocol.models
            : SUGGESTED_MODELS_BY_PROTOCOL[apiProtocol],
        ),
      ),
    [apiProtocol, providerForProtocol],
  );
  const apiModelOptions = useMemo(
    () => mergeProviderModelOptions(fetchedApiModelOptions, suggestedApiModelIds),
    [fetchedApiModelOptions, suggestedApiModelIds],
  );
  const apiModelIds = useMemo(
    () => apiModelOptions.map((model) => model.id),
    [apiModelOptions],
  );
  const apiModelChoices = useMemo(
    () => apiModelOptions.map((model) => ({ id: model.id, label: model.label })),
    [apiModelOptions],
  );

  // Chip text — keep it tight so the pill doesn't wrap on small viewports.
  // CLI: "Claude · Sonnet 4.5"; BYOK: "Anthropic · sonnet-4.5".
  const chipMode =
    config.mode === 'daemon'
      ? t('inlineSwitcher.chipCli')
      : t('inlineSwitcher.chipByok');
  const chipPrimary =
    config.mode === 'daemon'
      ? currentAgent
        ? displayAgentChipName(currentAgent)
        : agentsLoading
          ? t('inlineSwitcher.detectingAgent')
          : t('inlineSwitcher.noAgent')
      : apiProtocolLabel(apiProtocol);
  const chipModel =
    config.mode === 'daemon'
      ? currentModelLabel && currentModelId !== 'default'
        ? currentModelLabel
        : t('inlineSwitcher.modelDefault')
      : config.model.trim() || t('inlineSwitcher.modelDefault');

  const handleChipClick = useCallback(() => {
    const nextOpen = !open;
    if (nextOpen) {
      setSurface(
        wrapRef.current?.closest('.home-hero__execution-switcher')
          ? 'home-hero'
          : null,
      );
    }
    if (nextOpen && showAmrReminder) {
      setShowAmrReminderInPopover(true);
      setAmrReminderSeen(true);
      markAmrReminderSeen();
    } else if (!nextOpen) {
      setShowAmrReminderInPopover(false);
    }
    setOpen(nextOpen);
  }, [open, showAmrReminder]);

  useEffect(() => {
    if (!open || config.mode !== 'daemon' || config.agentId === 'amr') {
      setShowAmrReminderInPopover(false);
    }
  }, [config.agentId, config.mode, open]);

  const isAgentVariant = variant === 'agent';
  const isModelVariant = variant === 'model';
  const splitAgentLabel = `${t('inlineSwitcher.agentLabel')}: ${chipPrimary}`;
  const splitModelLabel = `${t('inlineSwitcher.modelLabel')}: ${chipModel}`;
  const triggerAccessibleName = isAgentVariant
    ? splitAgentLabel
    : isModelVariant
      ? splitModelLabel
      : `${chipMode} · ${chipPrimary} · ${chipModel}`;

  return (
    <div
      className={
        `inline-switcher${compact ? ' inline-switcher--compact' : ''}` +
        (variant === 'combined' ? '' : ` inline-switcher--${variant}`)
      }
      ref={wrapRef}
      data-testid={
        variant === 'combined'
          ? 'inline-model-switcher'
          : `inline-model-switcher-${variant}`
      }
    >
      <button
        ref={chipRef}
        type="button"
        className={
          'inline-switcher__chip' +
          (variant === 'combined' ? '' : ` inline-switcher__chip--${variant}`) +
          (showAmrReminder ? ' has-amr-reminder' : '')
        }
        data-testid={
          variant === 'combined'
            ? 'inline-model-switcher-chip'
            : `inline-model-switcher-${variant}-trigger`
        }
        onClick={handleChipClick}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerAccessibleName}
        title={triggerAccessibleName}
        data-tooltip={triggerAccessibleName}
      >
        {showAmrReminder && !isModelVariant ? (
          <span
            className="inline-switcher__amr-reminder-dot inline-switcher__amr-reminder-dot--chip"
            data-testid="inline-model-switcher-amr-reminder"
            aria-hidden="true"
          />
        ) : null}
        {isModelVariant ? null : (
          <span className="inline-switcher__chip-icon" aria-hidden="true">
            {config.mode === 'daemon' && currentAgent ? (
              <AgentIcon id={currentAgent.id} size={18} />
            ) : (
              <span className="inline-switcher__byok-glyph">
                <Icon
                  name={config.mode === 'daemon' && agentsLoading ? 'spinner' : 'link'}
                  size={12}
                />
              </span>
            )}
          </span>
        )}
        {/* Split mounts carry a single honest label each: the agent button is
            the agent icon alone, the model button the model name alone. No
            chevron on either — they open a popover, not an inline dropdown. */}
        {isAgentVariant ? null : (
          <span className="inline-switcher__chip-text">
            {isModelVariant ? (
              <span className="inline-switcher__chip-model">{chipModel}</span>
            ) : (
              <>
                <span className="inline-switcher__chip-mode">{chipMode}</span>
                <span className="inline-switcher__chip-sep" aria-hidden="true">
                  ·
                </span>
                <span className="inline-switcher__chip-primary">{chipPrimary}</span>
                <span className="inline-switcher__chip-sep" aria-hidden="true">
                  ·
                </span>
                <span className="inline-switcher__chip-model">{chipModel}</span>
              </>
            )}
          </span>
        )}
        {variant === 'combined' ? (
          <Icon
            name="chevron-down"
            size={12}
            className="inline-switcher__chip-chevron"
          />
        ) : null}
      </button>

      {open && typeof document !== 'undefined' ? createPortal(
        <div
          ref={popoverRef}
          className={
            'inline-switcher__popover inline-switcher__popover--layer' +
            (surface ? ` inline-switcher__popover--${surface}` : '')
          }
          role="menu"
          data-testid={
            variant === 'combined'
              ? 'inline-model-switcher-popover'
              : `inline-model-switcher-${variant}-popover`
          }
          style={
            popoverPos === null
              ? undefined
              : ({
                  left: `${popoverPos.left}px`,
                  top: `${popoverPos.top}px`,
                  right: 'auto',
                  bottom: 'auto',
                } satisfies CSSProperties)
          }
        >
          {isModelVariant ? null : (
          <div className="inline-switcher__row">
            <span className="inline-switcher__label">
              {t('inlineSwitcher.modeLabel')}
            </span>
            <div className="inline-switcher__seg" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={config.mode === 'daemon'}
                className={
                  'inline-switcher__seg-btn' +
                  (config.mode === 'daemon' ? ' is-active' : '')
                }
                data-testid="inline-model-switcher-mode-daemon"
                disabled={!daemonLive && config.mode !== 'daemon'}
                onClick={() => {
                  trackExecutionSettingsPopoverClick(analytics.track, {
                    page_name: 'home',
                    area: 'execution_settings_popover',
                    element: 'mode_local_cli',
                  });
                  // Optional-call so a transient Fast Refresh state where a
                  // parent has not yet re-rendered with the new prop signature
                  // does not crash the entire entry view. The same defensive
                  // pattern is applied to every callback below.
                  onModeChange?.('daemon');
                  if (!daemonLive) {
                    setOpen(false);
                    onOpenSettings?.('execution');
                  }
                }}
                title={
                  !daemonLive
                    ? t('inlineSwitcher.daemonOffline')
                    : t('inlineSwitcher.useCli')
                }
              >
                {t('inlineSwitcher.chipCli')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={config.mode === 'api'}
                className={
                  'inline-switcher__seg-btn' +
                  (config.mode === 'api' ? ' is-active' : '')
                }
                data-testid="inline-model-switcher-mode-api"
                onClick={() => {
                  trackExecutionSettingsPopoverClick(analytics.track, {
                    page_name: 'home',
                    area: 'execution_settings_popover',
                    element: 'mode_byok',
                  });
                  onModeChange?.('api');
                }}
                title={t('inlineSwitcher.useByok')}
              >
                {t('inlineSwitcher.chipByok')}
              </button>
            </div>
          </div>
          )}

          {config.mode === 'daemon' ? (
            <>
              {isModelVariant ? null : (
              <div className="inline-switcher__row">
                <span className="inline-switcher__label">
                  {t('inlineSwitcher.agentLabel')}
                </span>
                {installedAgents.length === 0 ? (
                  <span className="inline-switcher__hint">
                    {t('inlineSwitcher.noAgentsDetected')}
                  </span>
                ) : (
                  <div
                    className="inline-switcher__agent-grid"
                    role="radiogroup"
                  >
                    {installedAgents.map((a) => {
                      const active = config.agentId === a.id;
                      const agentName = displayAgentChipName(a);
                      const showAgentReminder =
                        a.id === 'amr' &&
                        showAmrReminderInPopover &&
                        config.agentId !== 'amr';
                      return (
                        <div
                          key={a.id}
                          className="inline-switcher__agent-row"
                        >
                          <button
                            type="button"
                            role="radio"
                            aria-checked={active}
                            aria-label={
                              a.id === 'amr'
                                ? `${agentName} ${amrInlineStatus}`
                                : agentName
                            }
                            className={
                              'inline-switcher__agent' +
                              (active ? ' is-active' : '') +
                              (showAgentReminder ? ' has-amr-reminder' : '')
                            }
                            data-testid={`inline-model-switcher-agent-${a.id}`}
                            onClick={() => void handleAgentButtonClick(a.id)}
                            title={
                              a.id === 'amr' && amrLoginPending
                                ? amrPendingHoverLabel
                                : a.id !== 'amr' && a.version
                                  ? `${agentName} · ${a.version}`
                                  : agentName
                            }
                          >
                            <AgentIcon id={a.id} size={20} />
                            {showAgentReminder ? (
                              <span
                                className="inline-switcher__amr-reminder-dot inline-switcher__amr-reminder-dot--agent"
                                data-testid="inline-model-switcher-agent-amr-reminder"
                                aria-hidden="true"
                              />
                            ) : null}
                            <span className="inline-switcher__agent-name">
                              {agentName}
                            </span>
                            {a.id === 'amr' ? (
                              <span className="inline-switcher__agent-status">
                                {amrStatusIconName ? (
                                  <span
                                    className={
                                      'inline-switcher__agent-status-icon' +
                                      (amrLoginPending ? ' is-pending' : '') +
                                      (amrLoggedIn ? ' is-signed-in' : '') +
                                      (!amrLoginPending && !amrLoggedIn ? ' is-signed-out' : '')
                                    }
                                  >
                                    <Icon name={amrStatusIconName} size={13} />
                                  </span>
                                ) : null}
                                <span
                                  className={
                                    'inline-switcher__agent-action-label' +
                                    (amrLoginPending ? ' is-cancelable' : '')
                                  }
                                >
                                  <span className="inline-switcher__agent-action-default">
                                    {amrActionLabel}
                                  </span>
                                  {amrLoginPending ? (
                                    <span
                                      className="inline-switcher__agent-action-hover"
                                      aria-hidden="true"
                                    >
                                      {amrPendingHoverLabel}
                                    </span>
                                  ) : null}
                                </span>
                              </span>
                            ) : null}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              )}

              {isModelVariant &&
              currentAgent &&
              agentModelChoices.length > 0 ? (
                // DEFECT: clicking the model button used to open a panel that
                // merely CONTAINED another control the user then had to
                // operate. The model button now opens the list of models
                // itself — one click to open, one click to pick.
                <div
                  className="inline-switcher__model-list"
                  role="listbox"
                  aria-label={t('inlineSwitcher.modelLabel')}
                  data-testid="inline-model-switcher-model-list"
                >
                  {agentModelChoices.map((model) => {
                    const selected = model.id === currentModelId;
                    return (
                      <button
                        key={model.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={
                          'inline-switcher__model-option' +
                          (selected ? ' is-active' : '')
                        }
                        data-testid={`inline-model-switcher-model-option-${model.id}`}
                        onClick={() => {
                          trackExecutionSettingsPopoverClick(analytics.track, {
                            page_name: 'home',
                            area: 'execution_settings_popover',
                            element: 'model_dropdown',
                            execution_mode: 'local_cli',
                            model_id: modelIdForTracking(model.id),
                          });
                          onAgentModelChange?.(currentAgent.id, {
                            model: model.id,
                          });
                          setOpen(false);
                        }}
                      >
                        <span className="inline-switcher__model-option-label">
                          {model.label}
                        </span>
                        <span
                          className="inline-switcher__model-option-check"
                          aria-hidden="true"
                        >
                          {selected ? <Icon name="check" size={13} /> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : !isAgentVariant &&
              currentAgent &&
              currentAgent.models &&
              currentAgent.models.length > 0 ? (
                <div className="inline-switcher__row">
                  <span className="inline-switcher__label">
                    {t('inlineSwitcher.modelLabel')}
                  </span>
                  <SearchableModelSelect
                    className="inline-switcher__select"
                    data-testid="inline-model-switcher-agent-model"
                    searchInputTestId="inline-model-switcher-agent-model-search"
                    popoverTestId="inline-model-switcher-agent-model-popover"
                    searchPlaceholder={t('designs.searchPlaceholder')}
                    aria-label={t('inlineSwitcher.modelLabel')}
                    models={agentModelChoices}
                    value={currentModelId ?? ''}
                    onChange={(nextValue) => {
                      trackExecutionSettingsPopoverClick(analytics.track, {
                        page_name: 'home',
                        area: 'execution_settings_popover',
                        element: 'model_dropdown',
                        execution_mode: 'local_cli',
                        model_id: modelIdForTracking(nextValue),
                      });
                      onAgentModelChange?.(currentAgent.id, {
                        model: nextValue,
                      });
                    }}
                    additionalOptions={
                      currentAgent.id !== 'amr' &&
                      currentModelId &&
                      !agentModelChoices.some((m) => m.id === currentModelId)
                        ? [
                            {
                              value: currentModelId,
                              label: `${currentModelId} ${t('inlineSwitcher.customSuffix')}`,
                            },
                          ]
                        : undefined
                    }
                  />
                </div>
              ) : isModelVariant ? (
                // The model button must never open an empty panel: with no
                // agent picked (or an agent that exposes no models) it says so
                // and points at the agent/settings path instead.
                <div className="inline-switcher__row">
                  <span className="inline-switcher__label">
                    {t('inlineSwitcher.modelLabel')}
                  </span>
                  <span className="inline-switcher__hint">
                    {currentAgent
                      ? t('inlineSwitcher.openSettingsForModel')
                      : t('inlineSwitcher.noAgentsDetected')}
                  </span>
                </div>
              ) : null}
            </>
          ) : (
            <>
              {isModelVariant ? null : (
              <div className="inline-switcher__row">
                <span className="inline-switcher__label">
                  {t('inlineSwitcher.providerLabel')}
                </span>
                <div className="inline-switcher__chips" role="tablist">
                  {API_PROTOCOL_TABS.map((tab) => {
                    const active = apiProtocol === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        className={
                          'inline-switcher__chip-tab' +
                          (active ? ' is-active' : '')
                        }
                        data-testid={`inline-model-switcher-provider-${tab.id}`}
                        onClick={() => {
                          // Unlike Settings (which skips unmapped protocols),
                          // report the click even when the protocol has no v2
                          // provider_id (e.g. aihubmix) — just omit the field.
                          trackExecutionSettingsPopoverClick(analytics.track, {
                            page_name: 'home',
                            area: 'execution_settings_popover',
                            element: 'byok_provider_tab',
                            provider_id:
                              byokProtocolToTracking(tab.id) ?? undefined,
                          });
                          onApiProtocolChange?.(tab.id);
                        }}
                      >
                        {tab.title}
                      </button>
                    );
                  })}
                </div>
              </div>
              )}

              {isAgentVariant ? null : (
              <div className="inline-switcher__row">
                <span className="inline-switcher__label">
                  {t('inlineSwitcher.modelLabel')}
                </span>
                {apiModelOptions.length > 0 ? (
                  <SearchableModelSelect
                    className="inline-switcher__select"
                    data-testid="inline-model-switcher-api-model"
                    searchInputTestId="inline-model-switcher-api-model-search"
                    popoverTestId="inline-model-switcher-api-model-popover"
                    searchPlaceholder={t('designs.searchPlaceholder')}
                    aria-label={t('inlineSwitcher.modelLabel')}
                    models={apiModelChoices}
                    value={config.model}
                    onChange={(nextValue) => {
                      trackExecutionSettingsPopoverClick(analytics.track, {
                        page_name: 'home',
                        area: 'execution_settings_popover',
                        element: 'model_dropdown',
                        execution_mode: 'byok',
                        provider_id:
                          byokProtocolToTracking(apiProtocol) ?? undefined,
                        model_id: modelIdForTracking(nextValue),
                      });
                      onApiModelChange?.(nextValue);
                    }}
                    additionalOptions={
                      config.model && !apiModelIds.includes(config.model)
                        ? [
                            {
                              value: config.model,
                              label: `${config.model} ${t('inlineSwitcher.customSuffix')}`,
                            },
                          ]
                        : undefined
                    }
                  />
                ) : (
                  <span className="inline-switcher__hint">
                    {t('inlineSwitcher.openSettingsForModel')}
                  </span>
                )}
              </div>
              )}

              {!config.apiKey ? (
                <div className="inline-switcher__warn" role="status">
                  {t('inlineSwitcher.missingApiKey')}
                </div>
              ) : null}
            </>
          )}

          <button
            type="button"
            className="inline-switcher__more"
            data-testid="inline-model-switcher-open-settings"
            onClick={() => {
              trackExecutionSettingsPopoverClick(analytics.track, {
                page_name: 'home',
                area: 'execution_settings_popover',
                element: 'open_execution_settings',
              });
              setOpen(false);
              onOpenSettings?.('execution');
            }}
          >
            <Icon name="settings" size={13} />
            <span>{t('inlineSwitcher.openFullSettings')}</span>
          </button>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
