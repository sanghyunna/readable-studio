import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createTabToTracking } from '@readable-studio/contracts/analytics';
import { isReadableStudioHostAvailable, pickHostWorkingDir } from '@readable-studio/host';
import type { ReadableStudioHostProjectImportSuccess } from '@readable-studio/host';
import { useAnalytics } from '../analytics/provider';
import {
  trackDesignSystemApplyResult,
  trackNewProjectModalElementClick,
  trackNewProjectModalSurfaceView,
  trackNewProjectModalTabClick,
} from '../analytics/events';
import type {
  TrackingDesignSystemApplyTargetKind,
  TrackingDesignSystemOrigin,
  TrackingDesignSystemStatusValue,
} from '@readable-studio/contracts/analytics';

import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import { openFolderDialog } from '../providers/registry';
import type {
  DesignSystemSummary,
  ProjectKind,
  ProjectMetadata,
  ProjectPlatform,
  ProjectTemplate,
  SkillSummary,
} from '../types';
import { formatPickAndImportFailure } from '../utils/pickAndImportError';
import { Icon } from './Icon';
import { Skeleton } from './Loading';
import { Toast } from './Toast';
import { useOpenFolderImport } from './useOpenFolderImport';

type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;

type NewProjectPlatform = Exclude<ProjectPlatform, 'auto'>;

const DESIGN_PLATFORMS: Array<{
  value: NewProjectPlatform;
  labelKey: keyof Dict;
  hintKey: keyof Dict;
}> = [
  {
    value: 'responsive',
    labelKey: 'newproj.platform.responsive.label',
    hintKey: 'newproj.platform.responsive.hint',
  },
  {
    value: 'web-desktop',
    labelKey: 'newproj.platform.webDesktop.label',
    hintKey: 'newproj.platform.webDesktop.hint',
  },
  {
    value: 'mobile-ios',
    labelKey: 'newproj.platform.mobileIos.label',
    hintKey: 'newproj.platform.mobileIos.hint',
  },
  {
    value: 'mobile-android',
    labelKey: 'newproj.platform.mobileAndroid.label',
    hintKey: 'newproj.platform.mobileAndroid.hint',
  },
  {
    value: 'tablet',
    labelKey: 'newproj.platform.tablet.label',
    hintKey: 'newproj.platform.tablet.hint',
  },
  {
    value: 'desktop-app',
    labelKey: 'newproj.platform.desktopApp.label',
    hintKey: 'newproj.platform.desktopApp.hint',
  },
];

export type CreateTab = 'prototype' | 'deck' | 'template' | 'other';

export interface CreateInput {
  name: string;
  skillId: string | null;
  designSystemId: string | null;
  metadata: ProjectMetadata;
  userWorkingDirToken?: string;
}

export type ImportClaudeDesignOutcome =
  | { ok: true }
  | { ok: false; message?: string; details?: string };

interface Props {
  skills: SkillSummary[];
  designSystems: DesignSystemSummary[];
  defaultDesignSystemId: string | null;
  templates: ProjectTemplate[];
  onDeleteTemplate?: (id: string) => Promise<boolean>;
  onCreate: (input: CreateInput & { requestId?: string }) => void;
  onImportClaudeDesign?: (
    file: File,
  ) => Promise<ImportClaudeDesignOutcome | void> | ImportClaudeDesignOutcome | void;
  // Local-server flow: the daemon-owned native folder picker returns the
  // selected baseDir, then the renderer POSTs `/api/import/folder`.
  onImportFolder?: (baseDir: string) => Promise<void> | void;
  // Host flow: the desktop main process owns the picker dialog and
  // the import call atomically (`pickAndImport` IPC). The renderer
  // never sees the path or the HMAC token; it only receives the
  // host-owned project identifiers and forwards them here so App-level
  // state can refresh through the daemon API.
  onImportFolderResponse?: (response: ReadableStudioHostProjectImportSuccess) => Promise<void> | void;
  loading?: boolean;
  initialTab?: CreateTab;
}

const TAB_LABEL_KEYS: Record<CreateTab, keyof Dict> = {
  prototype: 'newproj.tabPrototype',
  deck: 'newproj.tabDeck',
  template: 'newproj.tabTemplate',
  other: 'newproj.tabOther',
};

// Maps the New Project tab to the apply-result target kind enum.
function newProjectTabToApplyKind(
  tab: CreateTab,
): TrackingDesignSystemApplyTargetKind {
  switch (tab) {
    case 'prototype':
      return 'prototype';
    case 'deck':
      return 'slide_deck';
    case 'template':
    case 'other':
      return 'unknown';
  }
}

// Maps a `DesignSystemSummary.source` value to the DS origin enum used
// by `design_system_apply_result.design_system_source`. The summary
// shape only carries `'built-in' | 'installed' | 'user'`; we map them
// onto the doc's enum: user → manual_create, built-in → official_preset,
// installed → template.
function deriveDesignSystemOrigin(
  system: DesignSystemSummary | undefined,
): TrackingDesignSystemOrigin | undefined {
  if (!system) return undefined;
  switch (system.source) {
    case 'user':
      return 'manual_create';
    case 'built-in':
      return 'official_preset';
    case 'installed':
      return 'template';
    default:
      return 'unknown';
  }
}

function deriveDesignSystemStatusValue(
  system: DesignSystemSummary | undefined,
): TrackingDesignSystemStatusValue | undefined {
  if (!system) return undefined;
  switch (system.status) {
    case 'draft':
    case 'published':
      return system.status;
    default:
      return 'unknown';
  }
}


export function defaultDesignSystemSelection(
  defaultDesignSystemId: string | null,
  designSystems: DesignSystemSummary[],
): string[] {
  if (!defaultDesignSystemId) return [];
  return designSystems.some((d) => d.id === defaultDesignSystemId)
    ? [defaultDesignSystemId]
    : [];
}

export function buildDesignSystemCreateSelection(
  showDesignSystemPicker: boolean,
  selectedIds: string[],
): { primary: string | null; inspirations: string[] } {
  return showDesignSystemPicker
    ? {
        primary: selectedIds[0] ?? null,
        inspirations: selectedIds.slice(1),
      }
    : { primary: null, inspirations: [] };
}

export function NewProjectPanel({
  skills,
  designSystems,
  defaultDesignSystemId,
  templates,
  onDeleteTemplate,
  onCreate,
  onImportClaudeDesign,
  onImportFolder,
  onImportFolderResponse,
  loading = false,
  initialTab = 'prototype',
}: Props) {
  const t = useT();
  const analytics = useAnalytics();
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const [importZipError, setImportZipError] = useState<
    { message: string; details?: string } | null
  >(null);
  const [workingDir, setWorkingDir] = useState<string | null>(null);
  const [workingDirToken, setWorkingDirToken] = useState<string | null>(null);
  const [workingDirPicking, setWorkingDirPicking] = useState(false);
  const [workingDirError, setWorkingDirError] = useState<
    { message: string; details?: string } | null
  >(null);
  const [tab, setTab] = useState<CreateTab>(initialTab);
  // P0 analytics — fire surface_view once per (panel mount, tab) pair so the
  // funnel sees both initial open and tab switches without double-counting on
  // unrelated re-renders. Ref keys on a tab string because the panel is a
  // long-lived component the modal mounts/unmounts as the user opens/closes it.
  const newProjectViewedTabRef = useRef<string | null>(null);
  useEffect(() => {
    if (newProjectViewedTabRef.current === tab) return;
    newProjectViewedTabRef.current = tab;
    trackNewProjectModalSurfaceView(analytics.track, {
      page_name: 'home',
      area: 'new_project_modal',
      tab_name: createTabToTracking(tab),
    });
  }, [tab, analytics.track]);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const [tabScroll, setTabScroll] = useState({ left: false, right: false });
  const [name, setName] = useState('');
  // Design-system selection is now an *array* internally so the same
  // component can drive both single-select and multi-select modes without
  // duplicating state. Single-select coerces to length 0/1.
  const initialDefaultDsSelection = useMemo(
    () => defaultDesignSystemSelection(defaultDesignSystemId, designSystems),
    [defaultDesignSystemId, designSystems],
  );
  const [selectedDsIds, setSelectedDsIds] = useState<string[]>(
    () => initialDefaultDsSelection,
  );
  const [dsSelectionTouched, setDsSelectionTouched] = useState(false);
  const [dsMulti, setDsMulti] = useState(false);

  // Per-tab metadata. Tracked independently so switching tabs preserves
  // each tab's pick rather than resetting to defaults.
  const [fidelity, setFidelity] = useState<'wireframe' | 'high-fidelity'>(
    'high-fidelity',
  );
  const [platformTargets, setPlatformTargets] = useState<NewProjectPlatform[]>(['responsive']);
  const [includeLandingPage, setIncludeLandingPage] = useState(false);
  const [includeOsWidgets, setIncludeOsWidgets] = useState(false);
  const [speakerNotes, setSpeakerNotes] = useState(false);
  const [animations, setAnimations] = useState(false);
  const [templateId, setTemplateId] = useState<string | null>(null);

  // Keep this list explicit so future tabs declare whether they use design systems.
  const tabSupportsDesignSystem =
    tab === 'prototype' ||
    tab === 'deck' ||
    tab === 'template' ||
    tab === 'other';
  const tabDefaultSkillForcesNoDs = false;
  const showDesignSystemPicker =
    tabSupportsDesignSystem && !tabDefaultSkillForcesNoDs;

  useEffect(() => {
    if (dsSelectionTouched) return;
    setSelectedDsIds(initialDefaultDsSelection);
  }, [dsSelectionTouched, initialDefaultDsSelection]);

  // Fires `design_system_apply_result` with `auto_select` when the
  // picker mounts/refreshes and pre-selects the user's default DS
  // without an explicit click. Only emits once per default-id while
  // the picker is showing, and only while the user hasn't manually
  // changed the selection (so the dashboard separates auto vs manual
  // attribution). The picker visibility guard skips media tabs where
  // the DS picker isn't rendered.
  const autoSelectFiredForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!showDesignSystemPicker) return;
    if (dsSelectionTouched) return;
    const primary = initialDefaultDsSelection[0];
    if (!primary) return;
    if (autoSelectFiredForRef.current === primary) return;
    autoSelectFiredForRef.current = primary;
    const picked = designSystems.find((d) => d.id === primary);
    trackDesignSystemApplyResult(analytics.track, {
      page_name: 'home',
      area: 'design_system_picker',
      action: 'auto_select',
      result: 'success',
      target_project_kind: newProjectTabToApplyKind(tab),
      design_system_id: primary,
      design_system_source: deriveDesignSystemOrigin(picked),
      design_system_status: deriveDesignSystemStatusValue(picked),
      design_system_applied: true,
      design_system_selection_mode: 'default',
      is_default: true,
      is_auto_selected: true,
      available_design_system_count: designSystems.length,
      duration_ms: 0,
    });
  }, [
    analytics.track,
    designSystems,
    dsSelectionTouched,
    initialDefaultDsSelection,
    showDesignSystemPicker,
    tab,
  ]);

  // When entering the template tab, snap to the first user-saved template
  // if there is one (and we don't already have a valid pick). The template
  // tab no longer offers a built-in fallback — the entire point is to
  // start from a template *the user* created via Share.
  useEffect(() => {
    if (tab !== 'template') return;
    if (templates.length === 0) {
      setTemplateId(null);
      return;
    }
    if (templateId == null || !templates.some((t) => t.id === templateId)) {
      setTemplateId(templates[0]!.id);
    }
  }, [tab, templates, templateId]);

  // The skill the request still routes through — kept so prototype/deck
  // pick a default-rendered skill (so the agent gets the right SKILL.md
  // body) without requiring the user to choose one explicitly.
  const skillIdForTab = useMemo(() => {
    if (tab === 'other') return null;
    if (tab === 'prototype') {
      const list = skills.filter((s) => s.mode === 'prototype');
      return list.find((s) => s.defaultFor.includes('prototype'))?.id
        ?? list[0]?.id
        ?? null;
    }
    if (tab === 'deck') {
      const list = skills.filter((s) => s.mode === 'deck');
      return list.find((s) => s.defaultFor.includes('deck'))?.id
        ?? list[0]?.id
        ?? null;
    }
    return null;
  }, [tab, skills]);

  const canCreate =
    !loading && (tab !== 'template' || templateId != null);

  function updateTabScrollState() {
    const el = tabsRef.current;
    if (!el) return;
    const maxLeft = el.scrollWidth - el.clientWidth;
    setTabScroll({
      left: el.scrollLeft > 2,
      right: el.scrollLeft < maxLeft - 2,
    });
  }

  function scrollTabs(direction: -1 | 1) {
    const el = tabsRef.current;
    if (!el) return;
    el.scrollBy({
      left: direction * Math.max(120, el.clientWidth * 0.65),
      behavior: 'smooth',
    });
  }

  function handleDesignSystemChange(ids: string[]) {
    setDsSelectionTouched(true);
    setSelectedDsIds(ids);
    const previousPrimary = selectedDsIds[0] ?? null;
    const nextPrimary = ids[0] ?? null;
    // Only emit when the primary actually changed; secondary reorders
    // inside multi-select don't count as a fresh apply.
    if (previousPrimary === nextPrimary) return;
    const targetKind = newProjectTabToApplyKind(tab);
    if (ids.length === 0) {
      trackDesignSystemApplyResult(analytics.track, {
        page_name: 'home',
        area: 'design_system_picker',
        action: 'clear_selection',
        result: 'success',
        target_project_kind: targetKind,
        design_system_applied: false,
        design_system_selection_mode: 'none',
        is_default: false,
        is_auto_selected: false,
        available_design_system_count: designSystems.length,
        duration_ms: 0,
      });
      return;
    }
    if (!nextPrimary) return;
    const picked = designSystems.find((d) => d.id === nextPrimary);
    const isDefault = nextPrimary === defaultDesignSystemId;
    trackDesignSystemApplyResult(analytics.track, {
      page_name: 'home',
      area: 'design_system_picker',
      action: 'select_design_system',
      result: 'success',
      target_project_kind: targetKind,
      design_system_id: nextPrimary,
      design_system_source: deriveDesignSystemOrigin(picked),
      design_system_status: deriveDesignSystemStatusValue(picked),
      design_system_applied: true,
      design_system_selection_mode: isDefault ? 'default' : 'manual',
      is_default: isDefault,
      // `is_auto_selected` reports whether this row was picked by the
      // app (initial default selection from `initialDefaultDsSelection`)
      // rather than by the user. Once `dsSelectionTouched` is set we
      // know any subsequent change came from a click.
      is_auto_selected: false,
      available_design_system_count: designSystems.length,
      duration_ms: 0,
    });
  }

  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    updateTabScrollState();
    const onScroll = () => updateTabScrollState();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(updateTabScrollState);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    const el = tabsRef.current;
    const active = el?.querySelector<HTMLButtonElement>('.newproj-tab.active');
    active?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
    window.setTimeout(updateTabScrollState, 180);
  }, [tab]);

  function handleCreate() {
    if (!canCreate) return;
    const { primary: primaryDs, inspirations } =
      buildDesignSystemCreateSelection(showDesignSystemPicker, selectedDsIds);
    const trimmedName = name.trim();
    const metadata = buildMetadata({
      tab,
      fidelity,
      platformTargets,
      includeLandingPage,
      includeOsWidgets,
      speakerNotes,
      animations,
      templateId,
      templates,
      inspirationIds: inspirations,
    });
    // Generate the click→result correlation id here so the home_click and
    // the eventual project_create_result share request_id.
    const requestId = analytics.newRequestId();
    // v2 emits ui_click element=create on the New project modal; the
    // project_create_result correlated through `requestId` carries the
    // project_kind / fidelity payload, so we no longer duplicate them
    // on the click event.
    trackNewProjectModalElementClick(
      analytics.track,
      {
        page_name: 'home',
        area: 'new_project_modal',
        element: 'create',
        tab_name: createTabToTracking(tab),
      },
      { requestId },
    );
    onCreate({
      name: trimmedName || autoName(tab, t),
      skillId: skillIdForTab,
      designSystemId: primaryDs,
      metadata: {
        ...metadata,
        nameSource: trimmedName ? 'user' : 'generated',
        ...(workingDir ? { userWorkingDir: workingDir } : {}),
      },
      ...(workingDirToken ? { userWorkingDirToken: workingDirToken } : {}),
      requestId,
    });
  }

  async function handlePickWorkingDir() {
    if (workingDirPicking) return;
    setWorkingDirPicking(true);
    setWorkingDirError(null);
    try {
      if (isReadableStudioHostAvailable()) {
        const result = await pickHostWorkingDir();
        if (result.ok) {
          setWorkingDir(result.baseDir);
          setWorkingDirToken(result.token);
          return;
        }
        if ('canceled' in result && result.canceled) return;
        setWorkingDirError({
          message: `Couldn't open the folder picker (${'reason' in result ? result.reason : 'host unavailable'}). Please update Readable Studio and try again.`,
        });
        return;
      }
      const picked = await openFolderDialog();
      if (picked) {
        setWorkingDir(picked);
        setWorkingDirToken(null);
      }
    } finally {
      setWorkingDirPicking(false);
    }
  }

  async function handleImportPicked(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file || !onImportClaudeDesign) return;
    setImporting(true);
    setImportZipError(null);
    try {
      const result = await onImportClaudeDesign(file);
      if (result?.ok === false) {
        setImportZipError({
          message: result.message ? `Import failed: ${result.message}` : 'Import failed',
          details: result.details,
        });
      }
    } catch (err) {
      setImportZipError({
        message: err instanceof Error ? `Import failed: ${err.message}` : 'Import failed',
      });
    } finally {
      setImporting(false);
    }
  }

  const folderImport = useOpenFolderImport({
    skillId: skillIdForTab,
    onImportFolder,
    onImportFolderResponse,
  });

  return (
    <div className="newproj" data-testid="new-project-panel">
      <div className={`newproj-tabs-shell${tabScroll.left ? ' can-left' : ''}${tabScroll.right ? ' can-right' : ''}`}>
        <button
          type="button"
          className={`newproj-tabs-arrow left${tabScroll.left ? '' : ' hidden'}`}
          onClick={() => scrollTabs(-1)}
          aria-label="Scroll project types left"
          tabIndex={tabScroll.left ? 0 : -1}
        >
          <Icon name="chevron-left" size={16} strokeWidth={2} />
        </button>
        <div className="newproj-tabs" role="tablist" ref={tabsRef}>
          {(Object.keys(TAB_LABEL_KEYS) as CreateTab[]).map((entry) => (
            <button
              key={entry}
              role="tab"
              data-testid={`new-project-tab-${entry}`}
              aria-selected={tab === entry}
              className={`newproj-tab ${tab === entry ? 'active' : ''}`}
              onClick={() => {
                if (entry !== tab) {
                  trackNewProjectModalTabClick(analytics.track, {
                    page_name: 'home',
                    area: 'new_project_modal',
                    element: 'tab',
                    tab_name: createTabToTracking(entry),
                  });
                }
                setTab(entry);
              }}
            >
              {t(TAB_LABEL_KEYS[entry])}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`newproj-tabs-arrow right${tabScroll.right ? '' : ' hidden'}`}
          onClick={() => scrollTabs(1)}
          aria-label="Scroll project types right"
          tabIndex={tabScroll.right ? 0 : -1}
        >
          <Icon name="chevron-right" size={16} strokeWidth={2} />
        </button>
      </div>
      <div className="newproj-body">
        <h3 className="newproj-title">
          <span className="newproj-title-text">{titleForTab(tab, t)}</span>
        </h3>

        <div className="newproj-name-row">
          <input
            className="newproj-name"
            data-testid="new-project-name"
            placeholder={t('newproj.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="newproj-working-dir-row">
          <button
            type="button"
            className={`ghost newproj-working-dir readable-tooltip${workingDir ? ' picked' : ''}`}
            onClick={() => void handlePickWorkingDir()}
            disabled={workingDirPicking}
            title={workingDir ?? t('projectFolderPicker.homeTitle')}
            data-tooltip={workingDir ?? t('projectFolderPicker.homeTitle')}
          >
            <Icon name="folder" size={13} />
            <span>
              {workingDirPicking
                ? t('projectFolderPicker.processing')
                : workingDir
                  ? displayFolderName(workingDir)
                  : t('projectFolderPicker.select')}
            </span>
          </button>
          {workingDir ? (
            <button
              type="button"
              className="newproj-working-dir-clear"
              onClick={() => {
                setWorkingDir(null);
                setWorkingDirToken(null);
              }}
              aria-label={t('projectFolderPicker.clearAria')}
            >
              <Icon name="close" size={10} />
            </button>
          ) : null}
        </div>

        {showDesignSystemPicker ? (
          <DesignSystemPicker
            designSystems={designSystems}
            defaultDesignSystemId={defaultDesignSystemId}
            selectedIds={selectedDsIds}
            multi={dsMulti}
            onChangeMulti={setDsMulti}
            onChange={handleDesignSystemChange}
            loading={loading}
          />
        ) : null}




        {tab === 'prototype' || tab === 'template' || tab === 'other' ? (
          <PlatformPicker value={platformTargets} onChange={setPlatformTargets} />
        ) : null}

        {tab === 'prototype' || tab === 'template' || tab === 'other' ? (
          <SurfaceOptions
            includeLandingPage={includeLandingPage}
            includeOsWidgets={includeOsWidgets}
            onIncludeLandingPage={setIncludeLandingPage}
            onIncludeOsWidgets={setIncludeOsWidgets}
          />
        ) : null}

        {tab === 'prototype' ? (
          <FidelityPicker value={fidelity} onChange={setFidelity} />
        ) : null}

        {tab === 'deck' ? (
          <ToggleRow
            label={t('newproj.toggleSpeakerNotes')}
            hint={t('newproj.toggleSpeakerNotesHint')}
            checked={speakerNotes}
            onChange={setSpeakerNotes}
          />
        ) : null}

        {tab === 'template' ? (
          <>
            <TemplatePicker
              templates={templates}
              value={templateId}
              onChange={setTemplateId}
              onDelete={onDeleteTemplate}
            />
            <ToggleRow
              label={t('newproj.toggleAnimations')}
              hint={t('newproj.toggleAnimationsHint')}
              checked={animations}
              onChange={setAnimations}
            />
          </>
        ) : null}




        <button
          className="primary newproj-create"
          data-testid="create-project"
          onClick={handleCreate}
          disabled={!canCreate}
          title={
            tab === 'template' && templateId == null
              ? t('newproj.createDisabledTitle')
              : undefined
          }
        >
          <Icon name="plus" size={13} />
          <span>
            {tab === 'template'
              ? t('newproj.createFromTemplate')
              : t('newproj.create')}
          </span>
        </button>
        {onImportClaudeDesign ? (
          <>
            <input
              ref={importInputRef}
              type="file"
              accept=".zip,application/zip"
              hidden
              onChange={handleImportPicked}
            />
            <button
              type="button"
              className="ghost newproj-import"
              disabled={loading || importing}
              title={t('newproj.importClaudeZipTitle')}
              onClick={() => importInputRef.current?.click()}
            >
              <Icon name="import" size={13} />
              <span>
                {importing
                  ? t('newproj.importingClaudeZip')
                  : t('newproj.importClaudeZip')}
              </span>
            </button>
          </>
        ) : null}
        {folderImport.available ? (
          <div className="newproj-open-folder">
            <button
              type="button"
              className="ghost newproj-import"
              disabled={folderImport.importing}
              onClick={() => void folderImport.openFolder()}
            >
              <Icon name="folder" size={13} />
              <span>{folderImport.importing ? 'Opening...' : 'Open folder'}</span>
            </button>
          </div>
        ) : null}
      </div>
      <div className="newproj-footer">{t('newproj.privacyFooter')}</div>
      {importZipError ? (
        <Toast
          message={importZipError.message}
          details={importZipError.details ?? null}
          ttlMs={6000}
          onDismiss={() => setImportZipError(null)}
        />
      ) : null}
      {folderImport.error ? (
        <Toast
          message={folderImport.error.message}
          details={folderImport.error.details ?? null}
          ttlMs={6000}
          onDismiss={folderImport.clearError}
        />
      ) : null}
      {workingDirError ? (
        <Toast
          message={workingDirError.message}
          details={workingDirError.details ?? null}
          ttlMs={6000}
          onDismiss={() => setWorkingDirError(null)}
        />
      ) : null}
    </div>
  );
}

function displayFolderName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

function PlatformPicker({
  value,
  onChange,
}: {
  value: NewProjectPlatform[];
  onChange: (v: NewProjectPlatform[]) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  function togglePlatform(next: NewProjectPlatform) {
    const active = value.includes(next);
    const updated = active
      ? value.filter((item) => item !== next)
      : [...value, next];
    onChange(updated.length > 0 ? updated : ['responsive']);
  }

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    // Defer listener registration by a tick so the very click that opened
    // the popover doesn't get re-interpreted as an outside-click on the
    // mousedown that follows in the same event cycle.
    const tid = window.setTimeout(() => {
      document.addEventListener('mousedown', onPointer);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(tid);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const primary = DESIGN_PLATFORMS.find((o) => o.value === value[0]) ?? null;
  const extraCount = Math.max(0, value.length - 1);

  return (
    <div
      className="newproj-section ds-picker platform-picker"
      ref={wrapRef}
    >
      <label className="newproj-label">Target platforms</label>
      <button
        type="button"
        className={`ds-picker-trigger${open ? ' open' : ''}${primary ? '' : ' empty'}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
      >
        <span className="ds-picker-meta">
          <span className="ds-picker-title">
            {primary ? t(primary.labelKey) : 'Pick a platform'}
            {extraCount > 0 ? (
              <span className="ds-picker-extra-pill">+{extraCount}</span>
            ) : null}
          </span>
        </span>
        <Icon
          name="chevron-down"
          size={14}
          className="ds-picker-chevron"
          style={{ transform: open ? 'rotate(180deg)' : undefined }}
        />
      </button>
      {open ? (
        <div
          className="ds-picker-popover"
          id={listboxId}
          role="listbox"
          aria-label="Target platforms"
          aria-multiselectable="true"
        >
          <div className="ds-picker-list">
            {DESIGN_PLATFORMS.map((option) => {
              const active = value.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`ds-picker-item${active ? ' active' : ''}`}
                  onClick={() => togglePlatform(option.value)}
                >
                  <span className="ds-picker-item-text">
                    <span className="ds-picker-item-title">{t(option.labelKey)}</span>
                    <span className="ds-picker-item-sub">{t(option.hintKey)}</span>
                  </span>
                  <span
                    className={`ds-picker-mark check${active ? ' active' : ''}`}
                    aria-hidden
                  >
                    {active ? '✓' : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SurfaceOptions({
  includeLandingPage,
  includeOsWidgets,
  onIncludeLandingPage,
  onIncludeOsWidgets,
}: {
  includeLandingPage: boolean;
  includeOsWidgets: boolean;
  onIncludeLandingPage: (v: boolean) => void;
  onIncludeOsWidgets: (v: boolean) => void;
}) {
  const t = useT();
  return (
    <div className="newproj-section surface-options">
      <label className="newproj-label">{t('newproj.surfaceOptionsLabel')}</label>
      <div className="compact-toggle-list">
        <CompactToggle
          label={t('newproj.includeLandingPage')}
          hint={t('newproj.includeLandingPageHint')}
          checked={includeLandingPage}
          onChange={onIncludeLandingPage}
        />
        <CompactToggle
          label={t('newproj.includeOsWidgets')}
          hint={t('newproj.includeOsWidgetsHint')}
          checked={includeOsWidgets}
          onChange={onIncludeOsWidgets}
        />
      </div>
    </div>
  );
}

// Lightweight inline toggle row. The hint moves to a native tooltip so the
// row stays one line tall — used by SurfaceOptions where the toggles are
// secondary controls and the full card treatment of ToggleRow felt too heavy.
function CompactToggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`compact-toggle${checked ? ' on' : ''}${disabled ? ' disabled' : ''}`}
      onClick={() => { if (!disabled) onChange(!checked); }}
      aria-pressed={checked}
      disabled={disabled}
      title={hint}
    >
      <span className="compact-toggle-label">{label}</span>
      <span className="compact-toggle-switch" aria-hidden />
    </button>
  );
}

function FidelityPicker({
  value,
  onChange,
}: {
  value: 'wireframe' | 'high-fidelity';
  onChange: (v: 'wireframe' | 'high-fidelity') => void;
}) {
  const t = useT();
  return (
    <div className="newproj-section">
      <label className="newproj-label">{t('newproj.fidelityLabel')}</label>
      <div className="fidelity-grid">
        <FidelityCard
          active={value === 'wireframe'}
          onClick={() => onChange('wireframe')}
          label={t('newproj.fidelityWireframe')}
          variant="wireframe"
        />
        <FidelityCard
          active={value === 'high-fidelity'}
          onClick={() => onChange('high-fidelity')}
          label={t('newproj.fidelityHigh')}
          variant="high-fidelity"
        />
      </div>
    </div>
  );
}

function FidelityCard({
  active,
  onClick,
  label,
  variant,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  variant: 'wireframe' | 'high-fidelity';
}) {
  return (
    <button
      type="button"
      className={`fidelity-card${active ? ' active' : ''}`}
      onClick={onClick}
      aria-pressed={active}
    >
      <span className={`fidelity-thumb fidelity-thumb-${variant}`} aria-hidden>
        {variant === 'wireframe' ? <WireframeArt /> : <HighFidelityArt />}
      </span>
      <span className="fidelity-label">{label}</span>
    </button>
  );
}

function WireframeArt() {
  return (
    <svg viewBox="0 0 120 70" width="100%" height="100%" aria-hidden>
      <rect x="6" y="8" width="46" height="6" rx="2" fill="#d8d4cb" />
      <rect x="6" y="20" width="34" height="4" rx="2" fill="#ebe8e1" />
      <rect x="6" y="28" width="38" height="4" rx="2" fill="#ebe8e1" />
      <rect x="6" y="36" width="30" height="4" rx="2" fill="#ebe8e1" />
      <circle cx="22" cy="56" r="6" fill="none" stroke="#d8d4cb" strokeWidth="1.4" />
      <rect x="64" y="8" width="50" height="54" rx="3" fill="none" stroke="#d8d4cb" strokeWidth="1.4" />
      <rect x="70" y="14" width="38" height="4" rx="2" fill="#ebe8e1" />
      <rect x="70" y="22" width="32" height="4" rx="2" fill="#ebe8e1" />
      <rect x="70" y="30" width="38" height="4" rx="2" fill="#ebe8e1" />
    </svg>
  );
}

function HighFidelityArt() {
  return (
    <svg viewBox="0 0 120 70" width="100%" height="100%" aria-hidden>
      <rect x="6" y="8" width="34" height="6" rx="2" fill="#1a1916" />
      <rect x="6" y="20" width="46" height="4" rx="2" fill="#74716b" />
      <rect x="6" y="28" width="42" height="4" rx="2" fill="#b3b0a8" />
      <rect x="6" y="40" width="22" height="9" rx="2" fill="#c96442" />
      <rect x="64" y="8" width="50" height="54" rx="4" fill="#fbeee5" />
      <rect x="70" y="14" width="38" height="4" rx="2" fill="#c96442" />
      <rect x="70" y="22" width="32" height="3" rx="1.5" fill="#74716b" />
      <rect x="70" y="29" width="36" height="3" rx="1.5" fill="#b3b0a8" />
      <rect x="70" y="36" width="20" height="6" rx="2" fill="#c96442" />
    </svg>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`toggle-row${checked ? ' on' : ''}${disabled ? ' disabled' : ''}`}
      onClick={() => { if (!disabled) onChange(!checked); }}
      aria-pressed={checked}
      disabled={disabled}
    >
      <div className="toggle-row-text">
        <span className="toggle-row-label">{label}</span>
        {hint ? <span className="toggle-row-hint">{hint}</span> : null}
      </div>
      <span className="toggle-row-switch" aria-hidden />
    </button>
  );
}

function TemplatePicker({
  templates,
  value,
  onChange,
  onDelete,
}: {
  templates: ProjectTemplate[];
  value: string | null;
  onChange: (id: string | null) => void;
  onDelete?: (id: string) => Promise<boolean>;
}) {
  const t = useT();
  const [confirmDelete, setConfirmDelete] = useState<
    { id: string; name: string } | null
  >(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);

  function closeConfirm() {
    setConfirmDelete(null);
    setDeleting(false);
    setDeleteError(false);
  }

  async function runDelete() {
    if (!confirmDelete || !onDelete) return;
    setDeleting(true);
    setDeleteError(false);
    let ok = false;
    try {
      ok = await onDelete(confirmDelete.id);
    } catch {
      ok = false;
    }
    if (ok) {
      if (value === confirmDelete.id) onChange(null);
      closeConfirm();
    } else {
      setDeleting(false);
      setDeleteError(true);
    }
  }

  return (
    <div className="newproj-section">
      <label className="newproj-label">{t('newproj.templateLabel')}</label>
      {templates.length === 0 ? (
        <div className="template-howto">
          <span className="template-howto-title">
            {t('newproj.noTemplatesTitle')}
          </span>
          <span className="template-howto-body">
            {t('newproj.noTemplatesBody')}
          </span>
        </div>
      ) : (
        <div className="template-list">
          {templates.map((tpl) => {
            const fallbackDesc = `${t('newproj.savedTemplate')} · ${tpl.files.length} ${
              tpl.files.length === 1
                ? t('newproj.fileSingular')
                : t('newproj.filePlural')
            }`;
            return (
              <TemplateOption
                key={tpl.id}
                active={value === tpl.id}
                onClick={() => onChange(tpl.id)}
                onDelete={onDelete ? () => setConfirmDelete({ id: tpl.id, name: tpl.name }) : () => {}}
                name={tpl.name}
                description={tpl.description ?? fallbackDesc}
              />
            );
          })}
        </div>
      )}
      {confirmDelete ? (
        <div
          className="modal-backdrop"
          onClick={deleting ? undefined : closeConfirm}
        >
          <div
            className="modal modal-confirm"
            onClick={(e) => e.stopPropagation()}
            role="alertdialog"
            aria-modal="true"
          >
            <h2>{t('newproj.deleteTemplateTitle')}</h2>
            <p className="modal-confirm-message">
              {t('newproj.deleteTemplateConfirm', { name: confirmDelete.name })}
            </p>
            {deleteError ? (
              <p className="modal-confirm-error" role="alert">
                {t('newproj.deleteTemplateError')}
              </p>
            ) : null}
            <div className="row">
              <button type="button" onClick={closeConfirm} disabled={deleting}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="primary danger"
                autoFocus
                disabled={deleting}
                onClick={runDelete}
              >
                {t('newproj.deleteTemplateConfirmCta')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TemplateOption({
  active,
  onClick,
  onDelete,
  name,
  description,
}: {
  active: boolean;
  onClick: () => void;
  onDelete: () => void;
  name: string;
  description: string;
}) {
  return (
    <div className={`template-option${active ? ' active' : ''}`}>
      <button
        type="button"
        className="template-option-select"
        onClick={onClick}
        aria-pressed={active}
      >
        <span className={`template-radio${active ? ' active' : ''}`} aria-hidden />
        <span className="template-option-text">
          <span className="template-option-name">{name}</span>
          <span className="template-option-desc">{description}</span>
        </span>
      </button>
      <button
        type="button"
        className="template-option-delete"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        title="Delete template"
        aria-label={`Delete template ${name}`}
      >
        ✕
      </button>
    </div>
  );
}

/* ============================================================
   Design system picker — custom popover (replaces native <select>).
   - Single-select by default. Toggle in the popover header switches to
     multi-select, which lets users blend up to a few inspirations
     (first pick is the primary; the rest go into metadata).
   - Trigger card mirrors the claude.ai/design treatment: a tiny brand
     swatch strip + title + "Default" subtitle + chevron.
   ============================================================ */
function DesignSystemPicker({
  designSystems,
  defaultDesignSystemId,
  selectedIds,
  multi,
  onChange,
  onChangeMulti,
  loading,
}: {
  designSystems: DesignSystemSummary[];
  defaultDesignSystemId: string | null;
  selectedIds: string[];
  multi: boolean;
  onChange: (ids: string[]) => void;
  onChangeMulti: (v: boolean) => void;
  loading: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const byId = useMemo(() => {
    const map = new Map<string, DesignSystemSummary>();
    for (const d of designSystems) map.set(d.id, d);
    return map;
  }, [designSystems]);

  // Sort: selected first (in pick order), then default DS, then alpha
  // by category then title. Keeps the popover scannable while honoring
  // the user's existing picks.
  const ordered = useMemo(() => {
    const picked = selectedIds
      .map((id) => byId.get(id))
      .filter((d): d is DesignSystemSummary => Boolean(d));
    const pickedSet = new Set(picked.map((d) => d.id));
    const rest = designSystems
      .filter((d) => !pickedSet.has(d.id))
      .sort((a, b) => {
        if (a.id === defaultDesignSystemId) return -1;
        if (b.id === defaultDesignSystemId) return 1;
        const ca = a.category || 'Other';
        const cb = b.category || 'Other';
        if (ca !== cb) return ca.localeCompare(cb);
        return a.title.localeCompare(b.title);
      });
    return [...picked, ...rest];
  }, [designSystems, byId, selectedIds, defaultDesignSystemId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter((d) => {
      return (
        d.title.toLowerCase().includes(q) ||
        (d.summary || '').toLowerCase().includes(q) ||
        (d.category || '').toLowerCase().includes(q)
      );
    });
  }, [ordered, query]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => searchRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    // Defer listener registration by a tick so the very click that opened
    // the popover doesn't get re-interpreted as an outside-click on the
    // mousedown that follows in the same event cycle (StrictMode also
    // double-invokes the effect, which can race the same event).
    const t = window.setTimeout(() => {
      document.addEventListener('mousedown', onPointer);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggle(id: string) {
    if (multi) {
      // Multi-select: tapping toggles membership; the *first* id in the
      // array is treated as the primary across the rest of the app.
      const has = selectedIds.includes(id);
      if (has) {
        onChange(selectedIds.filter((x) => x !== id));
      } else {
        onChange([...selectedIds, id]);
      }
    } else {
      onChange([id]);
      setOpen(false);
    }
  }

  function clearAll() {
    onChange([]);
    if (!multi) setOpen(false);
  }

  const primaryId = selectedIds[0] ?? null;
  const primary = primaryId ? byId.get(primaryId) ?? null : null;
  const extraCount = Math.max(0, selectedIds.length - 1);
  const isDefault = !!primary && primary.id === defaultDesignSystemId;

  if (loading && designSystems.length === 0) {
    return (
      <div className="newproj-section">
        <label className="newproj-label">{t('newproj.designSystem')}</label>
        <Skeleton height={56} width="100%" radius={8} />
      </div>
    );
  }

  return (
    <div className="newproj-section ds-picker" data-testid="design-system-picker" ref={wrapRef}>
      <label className="newproj-label">{t('newproj.designSystem')}</label>
      <button
        type="button"
        data-testid="design-system-trigger"
        className={`ds-picker-trigger${open ? ' open' : ''}${primary ? '' : ' empty'}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <DesignSystemAvatar system={primary} extraCount={extraCount} />
        <span className="ds-picker-meta">
          <span className="ds-picker-title">
            {primary ? primary.title : t('newproj.dsNoneFreeform')}
            {extraCount > 0 ? (
              <span className="ds-picker-extra-pill">+{extraCount}</span>
            ) : null}
          </span>
          <span className="ds-picker-sub">
            {primary
              ? isDefault
                ? t('common.default')
                : primary.category || t('newproj.dsCategoryFallback')
              : t('newproj.dsNoneSubtitleEmpty')}
          </span>
        </span>
        <Icon
          name="chevron-down"
          size={14}
          className="ds-picker-chevron"
          style={{ transform: open ? 'rotate(180deg)' : undefined }}
        />
      </button>
      {open ? (
        <div className="ds-picker-popover" role="listbox">
          <div className="ds-picker-head">
            <input
              ref={searchRef}
              data-testid="design-system-search"
              className="ds-picker-search"
              placeholder={t('newproj.dsSearch')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div
              className="ds-picker-mode"
              role="tablist"
              aria-label={t('newproj.dsModeAria')}
            >
              <button
                type="button"
                role="tab"
                aria-selected={!multi}
                className={`ds-picker-mode-btn${!multi ? ' active' : ''}`}
                onClick={() => {
                  onChangeMulti(false);
                  if (selectedIds.length > 1) onChange(selectedIds.slice(0, 1));
                }}
              >
                {t('newproj.dsModeSingle')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={multi}
                className={`ds-picker-mode-btn${multi ? ' active' : ''}`}
                onClick={() => onChangeMulti(true)}
              >
                {t('newproj.dsModeMulti')}
              </button>
            </div>
          </div>
          <div className="ds-picker-list ds-picker-list-design-systems">
            <DsPickerItem
              active={selectedIds.length === 0}
              multi={multi}
              onClick={clearAll}
              avatar={<NoneAvatar />}
              title={t('newproj.dsNoneTitle')}
              subtitle={t('newproj.dsNoneSub')}
            />
            {filtered.length === 0 ? (
              <div className="ds-picker-empty">
                {t('newproj.dsEmpty', { query })}
              </div>
            ) : (
              filtered.map((d) => {
                const active = selectedIds.includes(d.id);
                const order = active ? selectedIds.indexOf(d.id) : -1;
                return (
                  <DsPickerItem
                    key={d.id}
                    active={active}
                    multi={multi}
                    order={order}
                    onClick={() => toggle(d.id)}
                    avatar={<DesignSystemAvatar system={d} />}
                    title={d.title}
                    badge={
                      d.id === defaultDesignSystemId
                        ? t('newproj.dsBadgeDefault')
                        : undefined
                    }
                    subtitle={d.summary || d.category || ''}
                  />
                );
              })
            )}
          </div>
          {multi && selectedIds.length > 1 ? (
            <div className="ds-picker-foot">
              <span className="ds-picker-foot-text">
                <strong>{primary?.title ?? t('newproj.dsPrimaryFallback')}</strong>{' '}
                {extraCount === 1
                  ? t('newproj.dsFootSingular')
                  : t('newproj.dsFootPlural')}
              </span>
              <button
                type="button"
                className="ds-picker-clear"
                onClick={clearAll}
              >
                {t('newproj.dsFootClear')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DsPickerItem({
  active,
  multi,
  order,
  onClick,
  avatar,
  title,
  subtitle,
  badge,
}: {
  active: boolean;
  multi: boolean;
  order?: number;
  onClick: () => void;
  avatar: React.ReactNode;
  title: string;
  subtitle: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={`ds-picker-item${active ? ' active' : ''}`}
      onClick={onClick}
    >
      <span className="ds-picker-item-avatar">{avatar}</span>
      <span className="ds-picker-item-text">
        <span className="ds-picker-item-title">
          {title}
          {badge ? <span className="ds-picker-item-badge">{badge}</span> : null}
        </span>
        <span className="ds-picker-item-sub">{subtitle}</span>
      </span>
      <span
        className={`ds-picker-mark ${multi ? 'check' : 'radio'}${active ? ' active' : ''}`}
        aria-hidden
      >
        {multi ? (
          active ? (order != null && order >= 0 ? order + 1 : '✓') : ''
        ) : null}
      </span>
    </button>
  );
}

function DesignSystemAvatar({
  system,
  extraCount = 0,
}: {
  system: DesignSystemSummary | null;
  extraCount?: number;
}) {
  if (!system) return <NoneAvatar />;
  const swatches = system.swatches && system.swatches.length > 0
    ? system.swatches.slice(0, 4)
    : fallbackSwatches(system.title);
  return (
    <span className="ds-avatar" aria-hidden>
      <span className="ds-avatar-grid">
        {swatches.map((c, i) => (
          <span key={i} className="ds-avatar-cell" style={{ background: c }} />
        ))}
      </span>
      {extraCount > 0 ? (
        <span className="ds-avatar-stack">+{extraCount}</span>
      ) : null}
    </span>
  );
}

function NoneAvatar() {
  return (
    <span className="ds-avatar ds-avatar-none" aria-hidden>
      <svg viewBox="0 0 24 24" width="16" height="16">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <line x1="6" y1="18" x2="18" y2="6" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    </span>
  );
}

// Deterministic fallback swatches for design systems whose DESIGN.md doesn't
// expose its tokens via the bold-and-hex format. Keeps the avatar visually
// distinct per-system without extra metadata fetches.
function fallbackSwatches(seed: string): string[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const base = h % 360;
  return [
    `hsl(${base}, 18%, 96%)`,
    `hsl(${(base + 90) % 360}, 22%, 78%)`,
    `hsl(${(base + 180) % 360}, 30%, 32%)`,
    `hsl(${(base + 30) % 360}, 70%, 52%)`,
  ];
}






function buildMetadata(input: {
  tab: CreateTab;
  fidelity: 'wireframe' | 'high-fidelity';
  platformTargets: NewProjectPlatform[];
  includeLandingPage: boolean;
  includeOsWidgets: boolean;
  speakerNotes: boolean;
  animations: boolean;
  templateId: string | null;
  templates: ProjectTemplate[];
  inspirationIds: string[];
}): ProjectMetadata {
  const kind: ProjectKind = input.tab;
  const selectedPlatforms = normalizeSelectedPlatforms(input.platformTargets);
  const concreteTargets = platformTargetsFor(selectedPlatforms);
  const canIncludeOsWidgets = platformTargetsSupportOsWidgets(concreteTargets);
  const surfaceOptions = {
    ...(input.includeLandingPage ? { includeLandingPage: true } : {}),
    ...(input.includeOsWidgets && canIncludeOsWidgets ? { includeOsWidgets: true } : {}),
  };
  const base = {
    platform: selectedPlatforms[0],
    platformTargets: concreteTargets,
    ...surfaceOptions,
  };
  const inspirations = input.inspirationIds.length > 0
    ? { inspirationDesignSystemIds: input.inspirationIds }
    : {};
  if (input.tab === 'prototype') {
    return {
      kind,
      ...base,
      fidelity: input.fidelity,
      ...inspirations,
    };
  }
  if (input.tab === 'deck') {
    return { kind, speakerNotes: input.speakerNotes, ...inspirations };
  }
  if (input.tab === 'template') {
    if (input.templateId == null) {
      return { kind, ...base, animations: input.animations, ...inspirations };
    }
    const tpl = input.templates.find((x) => x.id === input.templateId);
    // The fallback label is consumed by the agent prompt rather than the
    // UI, so we keep it in English to match the rest of the prompt corpus.
    return {
      kind,
      ...base,
      animations: input.animations,
      templateId: input.templateId,
      templateLabel: tpl?.name ?? 'Saved template',
      ...inspirations,
    };
  }
  return { kind: 'other', ...base, ...inspirations };
}

function normalizeSelectedPlatforms(platforms: NewProjectPlatform[]): NewProjectPlatform[] {
  const seen = new Set<NewProjectPlatform>();
  for (const platform of platforms) {
    if (DESIGN_PLATFORMS.some((option) => option.value === platform)) {
      seen.add(platform);
    }
  }
  return seen.size > 0 ? [...seen] : ['responsive'];
}

function platformTargetsSupportOsWidgets(platforms: ProjectPlatform[] | NewProjectPlatform[]): boolean {
  return platforms.some((platform) =>
    platform === 'mobile-ios'
    || platform === 'mobile-android'
    || platform === 'tablet',
  );
}

function platformTargetsFor(platforms: NewProjectPlatform[]): ProjectPlatform[] {
  const targets = new Set<ProjectPlatform>();
  for (const platform of platforms) {
    switch (platform) {
      case 'responsive':
        targets.add('responsive');
        break;
      case 'web-desktop':
        targets.add('web-desktop');
        break;
      case 'mobile-ios':
        targets.add('mobile-ios');
        break;
      case 'mobile-android':
        targets.add('mobile-android');
        break;
      case 'tablet':
        targets.add('tablet');
        break;
      case 'desktop-app':
        targets.add('desktop-app');
        break;
      default: {
        const exhaustive: never = platform;
        targets.add(exhaustive);
      }
    }
  }
  return targets.size > 0 ? [...targets] : ['responsive'];
}


function titleForTab(
  tab: CreateTab,
  t: TranslateFn,
): string {
  switch (tab) {
    case 'prototype':
      return t('newproj.titlePrototype');
    case 'deck':
      return t('newproj.titleDeck');
    case 'template':
      return t('newproj.titleTemplate');
    case 'other':
      return t('newproj.titleOther');
  }
}

function autoName(
  tab: CreateTab,
  t: TranslateFn,
): string {
  const stamp = new Date().toLocaleDateString();
  const labelKey: keyof Dict = TAB_LABEL_KEYS[tab];
  return `${t(labelKey)} · ${stamp}`;
}
