// Advanced / Import disclosure on the Hub's project panel.
//
// Creation itself is a composer send now: the chip carries the kind and the
// Brief card carries every setting that has a safe default. What lands here is
// only what is *genuinely pre-creation* and therefore cannot be corrected after
// the fact:
//
//   - the working-directory picker (a project cannot move once its files exist)
//   - Claude ZIP / open-folder imports (they bring their own files)
//   - the template picker (it seeds the initial file set)
//
// It is a small disclosure, not a modal gate: the main path never opens it. It
// is closed by default and driven by a real button — an obvious glass control
// with a chevron, not clickable text — and it animates open and closed with the
// repo's canonical `grid-template-rows: 0fr -> 1fr` reveal.
//
// Deliberately, opening it reveals the FULL creation stack via NewProjectPanel
// rather than a trimmed subset — a power user who wants to configure everything
// on one screen in ten seconds keeps exactly that, while everyone else never
// sees it.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReadableStudioHostProjectImportSuccess } from '@readable-studio/host';
import { useT } from '../i18n';
import type {
  DesignSystemSummary,
  ProjectTemplate,
  SkillSummary,
} from '../types';
import { Icon } from './Icon';
import {
  NewProjectPanel,
  type CreateInput,
  type CreateTab,
  type ImportClaudeDesignOutcome,
} from './NewProjectPanel';

interface Props {
  skills: SkillSummary[];
  designSystems: DesignSystemSummary[];
  defaultDesignSystemId: string | null;
  templates: ProjectTemplate[];
  onDeleteTemplate?: (id: string) => Promise<boolean>;
  loading?: boolean;
  onCreate: (input: CreateInput & { requestId?: string }) => Promise<boolean> | boolean | void;
  onImportClaudeDesign?: (
    file: File,
  ) => Promise<ImportClaudeDesignOutcome | void> | ImportClaudeDesignOutcome | void;
  onImportFolder?: (baseDir: string) => Promise<void> | void;
  onImportFolderResponse?: (response: ReadableStudioHostProjectImportSuccess) => Promise<void> | void;
  /** Opens the disclosure already expanded on a given tab (template deep-link). */
  requestedTab?: CreateTab | null;
  onRequestedTabHandled?: () => void;
}

export function NewProjectAdvanced({
  skills,
  designSystems,
  defaultDesignSystemId,
  templates,
  onDeleteTemplate,
  loading,
  onCreate,
  onImportClaudeDesign,
  onImportFolder,
  onImportFolderResponse,
  requestedTab = null,
  onRequestedTabHandled,
}: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [tab, setTab] = useState<CreateTab>('prototype');
  const panelId = useId();
  const regionRef = useRef<HTMLDivElement | null>(null);
  // React's handling of the HTML `inert` attribute differs by renderer/version:
  // this app's client renderer drops both the empty-string and boolean JSX
  // forms. Set the native DOM property during commit instead. Chromium reflects
  // it as the canonical empty attribute and enforces focus/accessibility-tree
  // exclusion for the retained subtree.
  const setRevealRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    node.inert = !open;
    node.toggleAttribute('inert', !open);
  }, [open]);
  // The disclosure animates, so the region stays mounted once it has been
  // opened: a conditional mount would swap the node out mid-transition and the
  // collapse would never play. Before the first open there is nothing to
  // animate, so the heavy creation stack is not paid for on the main path.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  // A template deep-link (the hero's "start from a template" affordance) opens
  // the disclosure on the template tab instead of a modal. The tab is remounted
  // through `key` so the panel picks the requested tab up as its initial tab.
  useEffect(() => {
    if (!requestedTab) return;
    setTab(requestedTab);
    setOpen(true);
    onRequestedTabHandled?.();
  }, [requestedTab, onRequestedTabHandled]);

  useEffect(() => {
    if (!open || !requestedTab) return;
    regionRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open, requestedTab]);

  async function handleCreate(input: CreateInput & { requestId?: string }) {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const result = await onCreate(input);
      if (result === false) {
        setCreateError(t('newprojAdvanced.createError'));
        return;
      }
      setOpen(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : t('newprojAdvanced.createError'));
    } finally {
      setCreating(false);
    }
  }

  return (
    <section
      className={`newproj-advanced${open ? ' is-open' : ''}`}
      data-testid="new-project-advanced"
    >
      <button
        type="button"
        className="newproj-advanced__toggle"
        data-testid="new-project-advanced-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="newproj-advanced__toggle-text">
          <span className="newproj-advanced__label">{t('newprojAdvanced.toggle')}</span>
          <span className="newproj-advanced__hint">{t('newprojAdvanced.toggleHint')}</span>
        </span>
        <Icon
          name="chevron-down"
          size={14}
          className="newproj-advanced__chevron"
          aria-hidden
        />
      </button>
      <div
        className="newproj-advanced__reveal"
        id={panelId}
        ref={setRevealRef}
        data-testid="new-project-advanced-reveal"
        data-state={open ? 'open' : 'closed'}
        // The collapsed region must be out of the tab order and off the
        // accessibility tree while it is still mounted for the animation.
        aria-hidden={open ? undefined : true}
      >
        <div className="newproj-advanced__reveal-inner">
          {mounted ? (
            <div
              className="newproj-advanced__body"
              ref={regionRef}
              data-testid="new-project-advanced-body"
            >
              <NewProjectPanel
                key={tab}
                skills={skills}
                designSystems={designSystems}
                defaultDesignSystemId={defaultDesignSystemId}
                templates={templates}
                {...(onDeleteTemplate ? { onDeleteTemplate } : {})}
                loading={Boolean(loading) || creating}
                onCreate={(input) => {
                  void handleCreate(input);
                }}
                {...(onImportClaudeDesign ? { onImportClaudeDesign } : {})}
                {...(onImportFolder ? { onImportFolder } : {})}
                {...(onImportFolderResponse ? { onImportFolderResponse } : {})}
                initialTab={tab}
                showDesignSystem
              />
              {creating ? (
                <div className="newproj-advanced__status" role="status">
                  {t('newprojAdvanced.creating')}
                </div>
              ) : null}
              {createError ? (
                <div className="newproj-advanced__status error" role="alert">
                  {createError}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
