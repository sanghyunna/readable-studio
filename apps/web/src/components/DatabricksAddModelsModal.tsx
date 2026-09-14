// Databricks "Add Models" modal.
//
// Opened from the trailing action row of the Databricks model dropdown. The
// flow is: pick a signed-in CLI profile -> scan the workspace (serving
// endpoints + Unity Catalog model services, streamed incrementally) -> flip
// the endpoints you want into the registered catalogue. Registration is the
// only thing this modal writes: it publishes the new catalogue through
// `notifyDatabricksModelsChanged` and never touches the active model choice.
//
// When the daemon reports `setupRequired` (no signed-in CLI profile and no
// saved workspace connection) the modal opens on a setup step instead: it asks
// for the workspace URL and a personal access token, saves the connection
// through `POST /setup` and drops straight into the scan step. The same form
// is reachable deliberately from the profile step ("Connect another
// workspace"). The credential lives in the request body only: it leaves
// state and the DOM the moment it is submitted and is never echoed back.
//
// Guided dead-end states remain only for daemons that do not report the flag
// and for the case where the daemon itself is unreachable.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { createPortal } from 'react-dom';
import { Button, Input, Switch, ToggleCard } from '@readable-studio/components';
import type {
  DatabricksAvailability,
  DatabricksEndpoint,
  DatabricksEndpointApi,
  DatabricksEndpointKind,
  DatabricksIssue,
  DatabricksProfile,
  DatabricksRegisteredEndpoint,
  DatabricksScanEvent,
  DatabricksScanResponse,
} from '@readable-studio/contracts';
import { useT } from '../i18n';
import { modalContent, modalOverlay, useFadingSurface } from '../motion';
import {
  cancelDatabricksScan,
  disableDatabricksModel,
  enableDatabricksModel,
  fetchDatabricksModels,
  fetchDatabricksScan,
  fetchDatabricksStatus,
  probeDatabricks,
  setupDatabricks,
  startDatabricksScan,
  streamDatabricksScanEvents,
  type DatabricksSetupResponse,
  type DatabricksStatusWithSetup,
} from '../providers/databricks';
import { openExternalUrl } from '../providers/registry';
import {
  notifyDatabricksModelsChanged,
  registeredEndpointToModelOption,
  databricksProtocolDescription,
  databricksLimitDescription,
} from './databricksModels';
import { Icon } from './Icon';
import styles from './DatabricksAddModelsModal.module.css';

interface Props {
  open: boolean;
  onClose: () => void;
  /** HTTPS install / docs links the daemon reports for the Databricks agent. */
  installUrl?: string;
  docsUrl?: string;
}

export function DatabricksAddModelsModal({ open, ...rest }: Props) {
  const wasOpenRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  if (open && !wasOpenRef.current && typeof document !== 'undefined') {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  wasOpenRef.current = open;

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {open ? <DatabricksAddModelsModalBody {...rest} returnFocusRef={returnFocusRef} /> : null}
    </AnimatePresence>,
    document.body,
  );
}

type Translate = ReturnType<typeof useT>;

type Step = 'setup' | 'scan';

// Technical examples stay untranslated on purpose.
const HOST_PLACEHOLDER = 'https://adb-1234567890123456.7.azuredatabricks.net';
const TOKEN_PLACEHOLDER = 'dapi…';

/**
 * Accepts a bare hostname or a full URL and returns the https origin the
 * daemon should connect to, or null when the input is not a usable address.
 */
function normalizeWorkspaceHost(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || !url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The daemon's placeholder-free guidance per issue action. */
function issueActionText(t: Translate, issue: DatabricksIssue | undefined): string | null {
  switch (issue?.action) {
    case 'install-cli':
      return t('databricks.issue.installCli');
    case 'choose-executable':
      return t('databricks.issue.chooseExecutable');
    case 'sign-in':
      return t('databricks.issue.signIn');
    case 'rescan':
      return t('databricks.issue.rescan');
    case 'verify':
      return t('databricks.issue.verify');
    case 'check-permissions':
      return t('databricks.issue.checkPermissions');
    default:
      return null;
  }
}

function kindLabel(t: Translate, kind: DatabricksEndpointKind): string {
  return kind === 'uc-model-service'
    ? t('databricks.kind.modelService')
    : t('databricks.kind.serving');
}

function apiLabel(t: Translate, api: DatabricksEndpointApi): string {
  if (api === 'openai-completions') return 'OpenAI-compatible Chat';
  if (api === 'anthropic-messages') return t('databricks.api.anthropic');
  return t('databricks.api.unknown');
}

function availabilityLabel(t: Translate, availability: DatabricksAvailability): string {
  switch (availability) {
    case 'compatible':
      return t('databricks.availability.compatible');
    case 'verification-required':
      return t('databricks.availability.verificationRequired');
    case 'unavailable':
      return t('databricks.availability.unavailable');
    default:
      return t('databricks.availability.stale');
  }
}

function pickInitialProfile(profiles: DatabricksProfile[]): string | null {
  return (
    profiles.find((profile) => profile.isDefault && profile.auth === 'authenticated')?.id ??
    profiles.find((profile) => profile.auth === 'authenticated')?.id ??
    profiles.find((profile) => profile.isDefault)?.id ??
    profiles[0]?.id ??
    null
  );
}

function mergeProfiles(
  current: DatabricksProfile[],
  incoming: DatabricksProfile[],
): DatabricksProfile[] {
  if (current.length === 0) return incoming;
  const byId = new Map(incoming.map((profile) => [profile.id, profile]));
  const merged = current.map((profile) => byId.get(profile.id) ?? profile);
  for (const profile of incoming) {
    if (!current.some((existing) => existing.id === profile.id)) merged.push(profile);
  }
  return merged;
}

function upsertEndpoint(
  list: DatabricksEndpoint[],
  endpoint: DatabricksEndpoint,
): DatabricksEndpoint[] {
  const index = list.findIndex((item) => item.id === endpoint.id);
  if (index === -1) return [...list, endpoint];
  const next = list.slice();
  next[index] = endpoint;
  return next;
}

function mergeEndpoints(
  list: DatabricksEndpoint[],
  incoming: DatabricksEndpoint[],
): DatabricksEndpoint[] {
  return incoming.reduce(upsertEndpoint, list);
}

function isScanSettled(state: DatabricksScanResponse['state']): boolean {
  return state === 'complete' || state === 'partial' || state === 'failed' || state === 'cancelled';
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function DatabricksAddModelsModalBody({
  onClose,
  installUrl,
  docsUrl,
  returnFocusRef,
}: Omit<Props, 'open'> & { returnFocusRef: MutableRefObject<HTMLElement | null> }) {
  const t = useT();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const backdropMotion = useFadingSurface(modalOverlay);
  const contentMotion = useFadingSurface(modalContent);

  const [status, setStatus] = useState<DatabricksStatusWithSetup | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const statusLoadRef = useRef<Promise<void> | null>(null);
  const [profiles, setProfiles] = useState<DatabricksProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [probingProfileId, setProbingProfileId] = useState<string | null>(null);

  const [registered, setRegistered] = useState<DatabricksRegisteredEndpoint[]>([]);
  const [registryRevision, setRegistryRevision] = useState<number | null>(null);

  const [scan, setScan] = useState<DatabricksScanResponse | null>(null);
  const [scanEndpoints, setScanEndpoints] = useState<DatabricksEndpoint[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const scanAbortRef = useRef<AbortController | null>(null);
  const activeScanIdRef = useRef<string | null>(null);

  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  // Setup step. `stepOverride` is the user's deliberate choice (open the form
  // from the profile step, go back, or the post-setup jump to scanning); null
  // means "follow what status says". The token is controlled state so the
  // submit gate can react to it, and it is cleared the moment it is submitted.
  const [stepOverride, setStepOverride] = useState<Step | null>(null);
  const [host, setHost] = useState('');
  const [token, setToken] = useState('');
  const [hostError, setHostError] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const hostRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const stopScanStream = useCallback(() => {
    scanAbortRef.current?.abort();
    scanAbortRef.current = null;
  }, []);

  const loadRegistered = useCallback(async () => {
    const response = await fetchDatabricksModels();
    setRegistered(response.models);
    setRegistryRevision(response.revision);
    return response;
  }, []);

  const loadStatus = useCallback(() => {
    if (statusLoadRef.current) return statusLoadRef.current;

    const request = (async () => {
      setStatusLoading(true);
      setStatusError(null);
      try {
        const next = await fetchDatabricksStatus();
        setStatus(next);
        setProfiles((current) => mergeProfiles(current, next.profiles));
        setSelectedProfileId((current) =>
          current && next.profiles.some((profile) => profile.id === current)
            ? current
            : pickInitialProfile(next.profiles),
        );

        if (next.cli === 'ready' && (next.profiles.length === 0 || next.auth === 'unchecked')) {
          const discovered = await probeDatabricks();
          setProfiles((current) => mergeProfiles(current, discovered.profiles));
          setSelectedProfileId((current) =>
            current && discovered.profiles.some((profile) => profile.id === current)
              ? current
              : pickInitialProfile(discovered.profiles),
          );
        }
      } catch (err) {
        setStatusError(errorMessage(err, t('databricks.error.generic')));
      } finally {
        setStatusLoading(false);
      }
    })();

    statusLoadRef.current = request;
    void request.finally(() => {
      if (statusLoadRef.current === request) statusLoadRef.current = null;
    });
    return request;
  }, [t]);

  useEffect(() => {
    void loadStatus();
    void loadRegistered().catch(() => {
      // The registered list is informational here; a failure leaves it empty
      // and the status/guided state still explains what is wrong.
    });
  }, [loadRegistered, loadStatus]);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, [returnFocusRef]);

  // Leaving the modal must not leave a discovery running in the daemon.
  useEffect(
    () => () => {
      stopScanStream();
      const runningScanId = activeScanIdRef.current;
      if (runningScanId) void cancelDatabricksScan(runningScanId).catch(() => undefined);
    },
    [stopScanStream],
  );

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleDialogKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      handleClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (!event.currentTarget.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    }
  }, [handleClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        handleClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [handleClose]);

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) ?? null,
    [profiles, selectedProfileId],
  );

  const probeProfile = useCallback(async (profileId: string) => {
    setProbingProfileId(profileId);
    try {
      const response = await probeDatabricks({ profileId });
      setProfiles((current) => mergeProfiles(current, response.profiles));
    } catch {
      setProfiles((current) =>
        current.map((profile) =>
          profile.id === profileId ? { ...profile, auth: 'unreachable' } : profile,
        ),
      );
    } finally {
      setProbingProfileId((current) => (current === profileId ? null : current));
    }
  }, []);

  const handleSelectProfile = useCallback(
    (profile: DatabricksProfile) => {
      setSelectedProfileId(profile.id);
      if (profile.auth === 'unchecked') void probeProfile(profile.id);
    },
    [probeProfile],
  );

  const applyScanEvent = useCallback((event: DatabricksScanEvent) => {
    if (event.type === 'snapshot' || event.type === 'done') {
      // The event revision is the stream's monotonic sequence; like the
      // progress/endpoint branches below, never let the scan fall behind it,
      // or the next enable would carry a stale expectedRevision.
      setScan({ ...event.scan, revision: Math.max(event.scan.revision, event.revision) });
      setScanEndpoints((current) => mergeEndpoints(current, event.scan.endpoints));
      return;
    }
    if (event.type === 'endpoint') {
      setScanEndpoints((current) => upsertEndpoint(current, event.endpoint));
      setScan((current) =>
        current ? { ...current, revision: Math.max(current.revision, event.revision) } : current,
      );
      return;
    }
    setScan((current) =>
      current
        ? {
            ...current,
            revision: Math.max(current.revision, event.revision),
            state: event.state,
            counters: event.counters,
            completeness: event.completeness,
            issues: event.issues,
          }
        : current,
    );
  }, []);

  const runScan = useCallback(async (profileId: string | null = selectedProfileId) => {
    if (!profileId) return;
    stopScanStream();
    const previousScanId = activeScanIdRef.current;
    if (previousScanId) void cancelDatabricksScan(previousScanId).catch(() => undefined);
    activeScanIdRef.current = null;

    setScanning(true);
    setScanError(null);
    setScanEndpoints([]);
    setRowErrors({});
    const controller = new AbortController();
    scanAbortRef.current = controller;
    try {
      const started = await startDatabricksScan({ profileId });
      if (controller.signal.aborted) return;
      activeScanIdRef.current = started.scanId;
      setScan(started);
      setScanEndpoints(started.endpoints);
      if (isScanSettled(started.state)) return;

      const sawDone = await streamDatabricksScanEvents(
        started.scanId,
        { onEvent: applyScanEvent },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (!sawDone) {
        // The stream closed early: the snapshot is the truth of record.
        const snapshot = await fetchDatabricksScan(started.scanId);
        setScan(snapshot);
        setScanEndpoints((current) => mergeEndpoints(current, snapshot.endpoints));
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setScanError(errorMessage(err, t('databricks.scan.failed')));
      }
    } finally {
      if (scanAbortRef.current === controller) {
        scanAbortRef.current = null;
        activeScanIdRef.current = null;
        setScanning(false);
      }
    }
  }, [applyScanEvent, selectedProfileId, stopScanStream, t]);

  const cancelScan = useCallback(() => {
    const runningScanId = activeScanIdRef.current;
    stopScanStream();
    activeScanIdRef.current = null;
    setScanning(false);
    if (runningScanId) void cancelDatabricksScan(runningScanId).catch(() => undefined);
    setScan((current) => (current ? { ...current, state: 'cancelled' } : current));
  }, [stopScanStream]);

  const publishRegistered = useCallback(async () => {
    const response = await loadRegistered();
    notifyDatabricksModelsChanged(response.models.map(registeredEndpointToModelOption));
    return response;
  }, [loadRegistered]);

  const setRegistration = useCallback(
    async (endpoint: DatabricksEndpoint, enabled: boolean) => {
      setPendingIds((current) => new Set(current).add(endpoint.id));
      setRowErrors((current) => {
        if (!(endpoint.id in current)) return current;
        const next = { ...current };
        delete next[endpoint.id];
        return next;
      });
      try {
        if (enabled) {
          if (!scan) return;
          await enableDatabricksModel(endpoint.id, {
            scanId: scan.scanId,
            expectedRevision: scan.revision,
          });
        } else {
          await disableDatabricksModel(endpoint.id, {
            expectedRevision: registryRevision ?? scan?.revision ?? 0,
          });
        }
        setScanEndpoints((current) =>
          current.map((item) => (item.id === endpoint.id ? { ...item, enabled } : item)),
        );
        await publishRegistered();
      } catch (err) {
        setRowErrors((current) => ({
          ...current,
          [endpoint.id]: errorMessage(err, t('databricks.error.generic')),
        }));
      } finally {
        setPendingIds((current) => {
          const next = new Set(current);
          next.delete(endpoint.id);
          return next;
        });
      }
    },
    [publishRegistered, registryRevision, scan, t],
  );

  const authenticatedProfiles = profiles.filter((profile) => profile.auth === 'authenticated');
  // A signed-in profile (CLI or saved workspace connection) is the truth of
  // record for scanning; the daemon owns whether the CLI is involved at all.
  const canScan = selectedProfile?.auth === 'authenticated' && !scanning;

  const setupRequired = status?.setupRequired === true && authenticatedProfiles.length === 0;
  const step: Step = stepOverride ?? (setupRequired ? 'setup' : 'scan');
  const canLeaveSetup = !setupRequired;

  useEffect(() => {
    if (step === 'setup' && stepOverride === 'setup') hostRef.current?.focus();
  }, [step, stepOverride]);

  const submitSetup = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (settingUp) return;
      const normalizedHost = normalizeWorkspaceHost(host);
      if (!normalizedHost) {
        setHostError(t('databricks.setup.hostInvalid'));
        return;
      }
      const credential = token;
      if (!credential) return;
      // The credential lives in the request body only: it leaves state (and
      // with it the DOM) before the request starts, and a failed attempt says
      // so and asks for it again. The host is kept so a typo is a quick fix.
      setToken('');
      setHostError(null);
      setSetupError(null);
      setSettingUp(true);
      let response: DatabricksSetupResponse;
      try {
        response = await setupDatabricks({
          mode: 'workspace-token',
          host: normalizedHost,
          token: credential,
        });
      } catch (err) {
        if (!mountedRef.current) return;
        setSetupError(errorMessage(err, t('databricks.setup.failed')));
        setSettingUp(false);
        return;
      }
      // The modal closed meanwhile: do not start a scan nobody can cancel.
      if (!mountedRef.current) return;
      setSettingUp(false);
      setHost('');
      setStatus(response.status);
      const incoming = response.status.profiles.some((profile) => profile.id === response.profile.id)
        ? response.status.profiles
        : [...response.status.profiles, response.profile];
      setProfiles((current) => mergeProfiles(current, incoming));
      setSelectedProfileId(response.profile.id);
      setStepOverride('scan');
      void runScan(response.profile.id);
    },
    [host, runScan, settingUp, t, token],
  );

  // One unified list: everything the latest scan returned, followed by models
  // registered earlier that this scan did not (or has not yet) reached.
  const rows = useMemo<DatabricksEndpoint[]>(() => {
    const seen = new Set(scanEndpoints.map((endpoint) => endpoint.id));
    const leftovers = registered.filter((endpoint) => !seen.has(endpoint.id));
    return [...scanEndpoints, ...leftovers];
  }, [registered, scanEndpoints]);
  const registeredCount = rows.filter((row) => row.enabled).length;

  const partial =
    scan && !scanning
      ? scan.state === 'partial' ||
        scan.completeness.truncated ||
        scan.counters.scopesInaccessible > 0
      : false;

  const guided = (() => {
    if (statusLoading && !status) return null;
    if (statusError) {
      return { title: t('databricks.auth.unreachableTitle'), body: statusError, command: null };
    }
    if (!status) return null;
    // A usable connection exists (CLI profile or saved workspace): CLI health
    // is never a reason to block the scan step.
    if (authenticatedProfiles.length > 0) return null;
    if (status.cli === 'missing') {
      return {
        title: t('databricks.cli.missingTitle'),
        body: t('databricks.cli.missingBody'),
        command: null,
      };
    }
    if (status.cli === 'unsupported') {
      return {
        title: t('databricks.cli.unsupportedTitle'),
        body: t('databricks.cli.unsupportedBody'),
        command: null,
      };
    }
    if (status.cli === 'uninvocable') {
      return {
        title: t('databricks.cli.uninvocableTitle'),
        body: t('databricks.cli.uninvocableBody'),
        command: null,
      };
    }
    if (status.auth === 'keyring-unavailable') {
      return {
        title: t('databricks.auth.keyringTitle'),
        body: t('databricks.auth.keyringBody'),
        command: 'databricks auth login --host <workspace-url> --profile <profile-name>',
      };
    }
    if (status.auth === 'unreachable' && authenticatedProfiles.length === 0) {
      return {
        title: t('databricks.auth.unreachableTitle'),
        body: t('databricks.auth.unreachableBody'),
        command: null,
      };
    }
    if (status.auth === 'unsupported-auth' && authenticatedProfiles.length === 0) {
      return {
        title: t('databricks.auth.unsupportedTitle'),
        body: t('databricks.auth.unsupportedBody'),
        command: 'databricks auth login --host <workspace-url> --profile <profile-name>',
      };
    }
    if (authenticatedProfiles.length === 0 && profiles.every((profile) => profile.auth !== 'unchecked')) {
      return {
        title: t('databricks.auth.requiredTitle'),
        body: t('databricks.auth.requiredBody'),
        command: 'databricks auth login --host <workspace-url> --profile <profile-name>',
      };
    }
    return null;
  })();

  const statusIssueTexts = (status?.issues ?? [])
    .map((issue) => issueActionText(t, issue))
    .filter((text): text is string => text !== null);

  return (
    <motion.div
      className={`modal-backdrop ${styles.backdrop}`}
      role="presentation"
      data-testid="databricks-add-models-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) handleClose();
      }}
      {...backdropMotion}
    >
      <motion.section
        className={`modal ${styles.modal}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="databricks-add-models-title"
        data-testid="databricks-add-models-modal"
        onKeyDown={handleDialogKeyDown}
        {...contentMotion}
      >
        <header className={styles.head}>
          <div className={styles.titles}>
            <h2 id="databricks-add-models-title">{t('databricks.modal.title')}</h2>
            <p>{t('databricks.modal.subtitle')}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className={styles.close}
            onClick={handleClose}
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className={styles.body}>
          {statusLoading && !status ? (
            <div className={styles.status} role="status">
              <Icon name="spinner" size={14} />
              <span>{t('databricks.modal.checkingCli')}</span>
            </div>
          ) : step === 'setup' ? (
            <section
              className={styles.section}
              aria-labelledby="databricks-setup-label"
              data-testid="databricks-setup-step"
            >
              <div className={styles.sectionHead}>
                <span id="databricks-setup-label" className={styles.label}>
                  {t('databricks.setup.label')}
                </span>
                <div className={styles.quietActions}>
                  {canLeaveSetup ? (
                    <button
                      type="button"
                      className={styles.quietAction}
                      onClick={() => setStepOverride('scan')}
                      data-testid="databricks-setup-back"
                    >
                      <Icon name="arrow-left" size={12} />
                      <span>{t('databricks.setup.back')}</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={styles.quietAction}
                    disabled={statusLoading}
                    onClick={() => void loadStatus()}
                    data-testid="databricks-check-again"
                  >
                    <Icon name={statusLoading ? 'spinner' : 'reload'} size={12} />
                    <span>{t('databricks.modal.checkAgain')}</span>
                  </button>
                </div>
              </div>

              <form
                className={styles.setup}
                noValidate
                onSubmit={(event) => void submitSetup(event)}
                data-testid="databricks-setup-form"
              >
                <div className={styles.setupIntro}>
                  <span className={styles.guidedGlyph} aria-hidden="true">
                    <Icon name="globe" size={18} />
                  </span>
                  <p>{t('databricks.setup.intro')}</p>
                </div>

                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('databricks.setup.hostLabel')}</span>
                  <Input
                    ref={hostRef}
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={HOST_PLACEHOLDER}
                    value={host}
                    disabled={settingUp}
                    aria-invalid={hostError ? true : undefined}
                    onChange={(event) => {
                      setHost(event.target.value);
                      if (hostError) setHostError(null);
                    }}
                    data-testid="databricks-setup-host"
                  />
                  {hostError ? (
                    <span className={styles.fieldError} role="alert">
                      {hostError}
                    </span>
                  ) : (
                    <span className={styles.fieldHint}>{t('databricks.setup.hostHint')}</span>
                  )}
                </label>

                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('databricks.setup.tokenLabel')}</span>
                  <Input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={TOKEN_PLACEHOLDER}
                    value={token}
                    disabled={settingUp}
                    onChange={(event) => setToken(event.target.value)}
                    data-testid="databricks-setup-token"
                  />
                  <span className={styles.fieldHint}>{t('databricks.setup.tokenHint')}</span>
                </label>

                {setupError ? (
                  <div className={styles.error} role="alert" data-testid="databricks-setup-error">
                    <Icon name="alert-triangle" size={14} />
                    <div>
                      <strong>{t('databricks.setup.failed')}</strong>
                      {setupError !== t('databricks.setup.failed') ? <p>{setupError}</p> : null}
                      <p>{t('databricks.setup.retryToken')}</p>
                    </div>
                  </div>
                ) : null}

                <div className={styles.setupActions}>
                  {docsUrl ? (
                    <Button variant="subtle" onClick={() => void openExternalUrl(docsUrl)}>
                      <Icon name="file" size={13} />
                      <span>{t('databricks.modal.docs')}</span>
                    </Button>
                  ) : null}
                  <Button
                    variant="primary"
                    type="submit"
                    disabled={settingUp || !host.trim() || !token}
                    data-testid="databricks-setup-submit"
                  >
                    <Icon name={settingUp ? 'spinner' : 'search'} size={13} />
                    <span>
                      {settingUp ? t('databricks.setup.submitting') : t('databricks.setup.submit')}
                    </span>
                  </Button>
                </div>
              </form>

              <p className={styles.note}>
                <Icon name="terminal" size={13} />
                <span>{t('databricks.setup.cliFootnote')}</span>
                {status?.cli === 'missing' && installUrl ? (
                  <button
                    type="button"
                    className={styles.quietAction}
                    onClick={() => void openExternalUrl(installUrl)}
                  >
                    <Icon name="download" size={12} />
                    <span>{t('databricks.modal.installCli')}</span>
                  </button>
                ) : null}
              </p>
            </section>
          ) : guided ? (
            <div className={styles.guided} role="status" data-testid="databricks-guided-state">
              <span className={styles.guidedGlyph} aria-hidden="true">
                <Icon name="terminal" size={18} />
              </span>
              <div className={styles.guidedText}>
                <strong>{guided.title}</strong>
                <p>{guided.body}</p>
                {guided.command ? <code className={styles.command}>{guided.command}</code> : null}
                {statusIssueTexts.length > 0 ? (
                  <ul className={styles.issueList}>
                    {statusIssueTexts.map((text, index) => (
                      <li key={`${index}:${text}`}>{text}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <div className={styles.guidedActions}>
                {installUrl ? (
                  <Button variant="subtle" onClick={() => void openExternalUrl(installUrl)}>
                    <Icon name="download" size={13} />
                    <span>{t('databricks.modal.installCli')}</span>
                  </Button>
                ) : null}
                {docsUrl ? (
                  <Button variant="subtle" onClick={() => void openExternalUrl(docsUrl)}>
                    <Icon name="file" size={13} />
                    <span>{t('databricks.modal.docs')}</span>
                  </Button>
                ) : null}
                <Button
                  variant="primary"
                  disabled={statusLoading}
                  onClick={() => void loadStatus()}
                  data-testid="databricks-check-again"
                >
                  <Icon name={statusLoading ? 'spinner' : 'reload'} size={13} />
                  <span>{t('databricks.modal.checkAgain')}</span>
                </Button>
              </div>
            </div>
          ) : (
            <>
              <section className={styles.section} aria-labelledby="databricks-profiles-label">
                <div className={styles.sectionHead}>
                  <span id="databricks-profiles-label" className={styles.label}>
                    {t('databricks.profiles.label')}
                  </span>
                  <div className={styles.quietActions}>
                    <button
                      type="button"
                      className={styles.quietAction}
                      onClick={() => setStepOverride('setup')}
                      data-testid="databricks-setup-open"
                    >
                      <Icon name="plus" size={12} />
                      <span>{t('databricks.setup.open')}</span>
                    </button>
                    <button
                      type="button"
                      className={styles.quietAction}
                      disabled={statusLoading}
                      onClick={() => void loadStatus()}
                      data-testid="databricks-check-again"
                    >
                      <Icon name={statusLoading ? 'spinner' : 'reload'} size={12} />
                      <span>{t('databricks.modal.checkAgain')}</span>
                    </button>
                  </div>
                </div>
                {profiles.length === 0 ? (
                  <p className={styles.hint}>{t('databricks.profiles.none')}</p>
                ) : (
                  <div className={styles.profiles} role="radiogroup" aria-label={t('databricks.profiles.label')}>
                    {profiles.map((profile) => {
                      const pressed = profile.id === selectedProfileId;
                      const probing = probingProfileId === profile.id;
                      const authText = probing
                        ? t('databricks.profiles.checking')
                        : profile.auth === 'authenticated'
                          ? t('databricks.profiles.authenticated')
                          : profile.auth === 'unchecked'
                            ? t('databricks.profiles.unchecked')
                            : t('databricks.profiles.authRequired');
                      const authTone = probing
                        ? 'checking'
                        : profile.auth === 'authenticated'
                          ? 'ok'
                          : profile.auth === 'unchecked'
                            ? 'unchecked'
                            : 'required';
                      const authClass =
                        authTone === 'ok'
                          ? styles.pillOk
                          : authTone === 'required'
                            ? styles.pillWarn
                            : styles.pill;
                      return (
                        <ToggleCard
                          key={profile.id}
                          className={styles.profileCard}
                          pressed={pressed}
                          pending={probing}
                          role="radio"
                          aria-checked={pressed}
                          data-testid={`databricks-profile-${profile.id}`}
                          onPressedChange={() => handleSelectProfile(profile)}
                        >
                          <span className={styles.profilePrimary}>
                            <span
                              className={styles.profileName}
                              data-testid={`databricks-profile-name-${profile.id}`}
                            >
                              {profile.label}
                            </span>
                            {profile.isDefault ? (
                              <span
                                className={styles.profileDefault}
                                data-testid={`databricks-profile-default-${profile.id}`}
                              >
                                {t('databricks.profiles.default')}
                              </span>
                            ) : null}
                            <span
                              className={`${styles.profileAuth} ${authClass}`}
                              data-auth={authTone}
                              data-testid={`databricks-profile-auth-${profile.id}`}
                            >
                              {authText}
                            </span>
                          </span>
                          <span
                            className={styles.profileWorkspace}
                            title={profile.workspaceLabel}
                            data-testid={`databricks-profile-workspace-${profile.id}`}
                          >
                            {profile.workspaceLabel}
                          </span>
                        </ToggleCard>
                      );
                    })}
                  </div>
                )}
              </section>

              <section className={styles.section} aria-labelledby="databricks-results-label">
                <div className={styles.sectionHead}>
                  <span id="databricks-results-label" className={styles.label}>
                    {t('databricks.results.title')}
                    <span className={styles.count} data-testid="databricks-registered-count">
                      {t('databricks.results.registeredCount', { n: registeredCount })}
                    </span>
                  </span>
                  <div className={styles.scanControls}>
                    {scanning ? (
                      <Button
                        variant="ghost"
                        className={styles.headButton}
                        onClick={cancelScan}
                        data-testid="databricks-scan-cancel"
                      >
                        {t('databricks.scan.cancel')}
                      </Button>
                    ) : null}
                    <Button
                      variant={scan ? 'default' : 'primary'}
                      className={styles.headButton}
                      disabled={!canScan}
                      title={!canScan && !scanning ? t('databricks.scan.signInFirst') : undefined}
                      onClick={() => void runScan()}
                      data-testid="databricks-scan-start"
                    >
                      <Icon name={scanning ? 'spinner' : scan ? 'reload' : 'search'} size={13} />
                      <span>{scan ? t('databricks.scan.rescan') : t('databricks.scan.start')}</span>
                    </Button>
                  </div>
                </div>

                {scanning || scan ? (
                  <div
                    className={styles.progress}
                    role="status"
                    aria-live="polite"
                    data-testid="databricks-scan-progress"
                  >
                    <Icon
                      name={scanning ? 'spinner' : scan?.state === 'failed' ? 'alert-triangle' : 'check'}
                      size={13}
                    />
                    <span>
                      {scanning
                        ? t('databricks.scan.running')
                        : scan?.state === 'failed'
                          ? t('databricks.scan.failed')
                          : scan?.state === 'cancelled'
                            ? t('databricks.scan.cancelled')
                            : t('databricks.scan.complete')}
                    </span>
                    {scan ? (
                      <span className={styles.progressCounters}>
                        {t('databricks.scan.progress', {
                          scopes: scan.counters.scopesChecked,
                          candidates: scan.counters.candidates,
                        })}
                      </span>
                    ) : null}
                  </div>
                ) : null}

                {partial && scan ? (
                  <div className={styles.warning} role="alert" data-testid="databricks-scan-partial">
                    <Icon name="alert-triangle" size={14} />
                    <div>
                      <strong>{t('databricks.scan.partialTitle')}</strong>
                      <p>
                        {scan.counters.scopesInaccessible > 0
                          ? t('databricks.scan.partialBody', {
                              inaccessible: scan.counters.scopesInaccessible,
                              checked: scan.counters.scopesChecked,
                            })
                          : t('databricks.scan.truncatedBody')}
                      </p>
                      {scan.issues.length > 0 ? (
                        <ul className={styles.issueList}>
                          {scan.issues
                            .map((issue) => issueActionText(t, issue))
                            .filter((text): text is string => text !== null)
                            .map((text, index) => (
                              <li key={`${index}:${text}`}>{text}</li>
                            ))}
                        </ul>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {scanError || (scan?.state === 'failed' && !scanning) ? (
                  <div className={styles.error} role="alert" data-testid="databricks-scan-error">
                    <Icon name="alert-triangle" size={14} />
                    <div>
                      <strong>{t('databricks.scan.failed')}</strong>
                      {scanError ? <p>{scanError}</p> : null}
                      {(scan?.issues ?? [])
                        .map((issue) => issueActionText(t, issue))
                        .filter((text): text is string => text !== null)
                        .map((text, index) => (
                          <p key={`${index}:${text}`}>{text}</p>
                        ))}
                    </div>
                  </div>
                ) : null}

                {rows.length === 0 ? (
                  scan && !scanning && scan.state !== 'failed' ? (
                    <p className={styles.hint}>{t('databricks.scan.empty')}</p>
                  ) : !scan && !scanning ? (
                    <p className={styles.hint}>
                      {canScan ? t('databricks.registeredNote') : t('databricks.scan.signInFirst')}
                    </p>
                  ) : null
                ) : (
                  <ul className={styles.rows} data-testid="databricks-endpoint-list">
                    {rows.map((endpoint) => {
                      const pending = pendingIds.has(endpoint.id);
                      const inScan = scanEndpoints.some((item) => item.id === endpoint.id);
                      const registrable =
                        endpoint.availability !== 'unavailable' && (endpoint.enabled || (inScan && Boolean(scan)));
                      const issueText = issueActionText(t, endpoint.issue);
                      return (
                        <li
                          key={endpoint.id}
                          className={endpoint.enabled ? styles.rowRegistered : styles.row}
                          data-testid={`databricks-endpoint-${endpoint.id}`}
                        >
                          <div className={styles.rowMain}>
                            <span className={styles.rowLabel} title={endpoint.label}>
                              {endpoint.label}
                            </span>
                            <span className={styles.pills}>
                              <span className={styles.pill}>{kindLabel(t, endpoint.kind)}</span>
                              <span className={styles.pill}>{apiLabel(t, endpoint.api)}</span>
                              <span className={styles.pill} data-limit="contextWindow" data-limit-state={endpoint.capabilities.contextWindow === null ? 'unknown' : 'known'}>
                                Context {endpoint.capabilities.contextWindow?.toLocaleString() ?? 'unknown'}
                              </span>
                              <span className={styles.pill} data-limit="maxTokens" data-limit-state={endpoint.capabilities.maxTokens === null ? 'unknown' : 'known'}>
                                Output {endpoint.capabilities.maxTokens?.toLocaleString() ?? 'unknown'}
                              </span>
                              <span
                                className={
                                  endpoint.availability === 'compatible'
                                    ? styles.pillOk
                                    : endpoint.availability === 'unavailable'
                                      ? styles.pillDanger
                                      : styles.pillWarn
                                }
                              >
                                {availabilityLabel(t, endpoint.availability)}
                              </span>
                              {endpoint.capabilities.tools === 'supported' ? (
                                <span className={styles.pill}>{t('databricks.capability.tools')}</span>
                              ) : null}
                              {endpoint.capabilities.images === 'supported' ? (
                                <span className={styles.pill}>{t('databricks.capability.images')}</span>
                              ) : null}
                            </span>
                            <small>{databricksProtocolDescription(endpoint)}</small>
                            <small>{databricksLimitDescription(endpoint)}</small>
                            {issueText ? <span className={styles.rowIssue}>{issueText}</span> : null}
                            {rowErrors[endpoint.id] ? (
                              <span className={styles.rowError} role="alert">
                                {rowErrors[endpoint.id]}
                              </span>
                            ) : null}
                          </div>
                          <Switch
                            className={styles.switch}
                            checked={endpoint.enabled}
                            pending={pending}
                            disabled={!registrable}
                            aria-label={`${t('databricks.results.register')}: ${endpoint.label}`}
                            stateText={
                              pending
                                ? t('databricks.results.pending')
                                : endpoint.enabled
                                  ? t('databricks.results.registered')
                                  : t('databricks.results.register')
                            }
                            data-testid={`databricks-endpoint-toggle-${endpoint.id}`}
                            onCheckedChange={(next) => void setRegistration(endpoint, next)}
                          />
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <p className={styles.note}>
                <Icon name="info" size={13} />
                <span>{t('databricks.registeredNote')}</span>
              </p>
            </>
          )}
        </div>

        <footer className={styles.foot}>
          {/* The setup form owns the primary action while it is showing. */}
          <Button
            variant={step === 'setup' ? 'default' : 'primary'}
            onClick={handleClose}
            data-testid="databricks-add-models-done"
          >
            {t('databricks.modal.done')}
          </Button>
        </footer>
      </motion.section>
    </motion.div>
  );
}
