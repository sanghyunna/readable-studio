// Project-creation contracts shared by the Hub composer, the imports in its "+"
// menu and App's create handlers. The New Project modal that used to own these
// is gone: a brief typed into the Hub composer is how a project starts, and the
// modal's imports / saved-template start live in the composer's "+" menu.

import type { ChangeEvent, MutableRefObject } from 'react';
import type { ChatSessionMode } from '@readable-studio/contracts';
import type { ReadableStudioHostProjectImportSuccess } from '@readable-studio/host';

import type { ProjectMetadata, ProjectTemplate } from '../types';

export interface CreateInput {
  name: string;
  skillId: string | null;
  designSystemId: string | null;
  metadata: ProjectMetadata;
  userWorkingDirToken?: string;
  /** Session mode the project's first conversation starts in. */
  conversationMode?: ChatSessionMode;
}

export type ImportClaudeDesignOutcome =
  | { ok: true }
  | { ok: false; message?: string; details?: string };

export type ImportClaudeDesignHandler = (
  file: File,
) => Promise<ImportClaudeDesignOutcome | void> | ImportClaudeDesignOutcome | void;

/** App-owned handlers the Hub composer's "+" menu relocations call into. */
export interface ProjectImportHandlers {
  /** Start a project from a template the user saved via Share. */
  onCreateFromTemplate?: (template: ProjectTemplate) => Promise<boolean> | boolean | void;
  onImportClaudeDesign?: ImportClaudeDesignHandler;
  // Local-server flow: the daemon-owned native folder picker returns the
  // selected baseDir, then the renderer POSTs `/api/import/folder`.
  onImportFolder?: (baseDir: string) => Promise<void> | void;
  // Host flow: the desktop main process owns the picker dialog and the import
  // call atomically (`pickAndImport` IPC); the renderer only receives the
  // host-owned project identifiers.
  onImportFolderResponse?: (response: ReadableStudioHostProjectImportSuccess) => Promise<void> | void;
}

/** Ready-to-render state for the "+" menu rows; HomeView owns the hooks. */
export interface ComposerProjectImports {
  openFolder: { available: boolean; busy: boolean; run: () => void };
  claudeZip: {
    available: boolean;
    busy: boolean;
    pick: () => void;
    inputRef: MutableRefObject<HTMLInputElement | null>;
    onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  };
  templates: {
    items: ProjectTemplate[];
    busy: boolean;
    pick: (template: ProjectTemplate) => void;
  };
}

/**
 * The exact request the modal's Template tab sent with its defaults: no name
 * typed (auto-named), responsive target, no companion surfaces, no animations,
 * the workspace default design system, first conversation in design mode.
 */
export function buildTemplateCreateInput(
  template: ProjectTemplate,
  defaultDesignSystemId: string | null,
  name: string,
): CreateInput {
  return {
    name,
    skillId: null,
    designSystemId: defaultDesignSystemId,
    metadata: {
      kind: 'template',
      platform: 'responsive',
      platformTargets: ['responsive'],
      animations: false,
      templateId: template.id,
      // Consumed by the agent prompt, so it stays English like the rest of it.
      templateLabel: template.name || 'Saved template',
      nameSource: 'generated',
    },
    conversationMode: 'design',
  };
}
