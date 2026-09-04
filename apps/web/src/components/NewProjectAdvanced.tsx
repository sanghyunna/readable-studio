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
// It is a small disclosure, not a modal gate: the main path never opens it.
// Deliberately, opening it reveals the FULL creation stack via NewProjectPanel
// rather than a trimmed subset — a power user who wants to configure everything
// on one screen in ten seconds keeps exactly that, while everyone else never
// sees it.

import { useEffect, useId, useRef, useState } from 'react';
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
    <section className="newproj-advanced" data-testid="new-project-advanced">
      <button
        type="button"
        className="newproj-advanced__toggle"
        data-testid="new-project-advanced-toggle"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon
          name="chevron-down"
          size={13}
          className="newproj-advanced__chevron"
          aria-hidden
        />
        <span className="newproj-advanced__label">{t('newprojAdvanced.toggle')}</span>
        <span className="newproj-advanced__hint">{t('newprojAdvanced.toggleHint')}</span>
      </button>
      {open ? (
        <div
          className="newproj-advanced__body"
          id={panelId}
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
    </section>
  );
}
