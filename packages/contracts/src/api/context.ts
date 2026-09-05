export interface RunContextSelection {
  skillIds?: string[];
  pluginIds?: string[];
  mcpServerIds?: string[];
  workspaceItems?: WorkspaceContextItem[];
}

export type WorkspaceContextKind =
  | 'design-files'
  | 'design-system'
  | 'file'
  | 'folder'
  | 'browser'
  | 'terminal'
  | 'side-chat';

export interface WorkspaceContextItem {
  id: string;
  kind: WorkspaceContextKind;
  label: string;
  tabId?: string;
  path?: string;
  absolutePath?: string;
  url?: string;
  title?: string;
}

export interface ProjectContextPluginRef {
  id: string;
  title: string;
  description?: string;
}

/**
 * A replay-stable, content-clean design snapshot. Source plugin identity is
 * deliberately absent so example subject matter cannot become prompt context.
 */
export interface ProjectVisualReference {
  characteristics: string[];
}

export interface ProjectContextMcpServerRef {
  id: string;
  label?: string;
  transport?: string;
  url?: string;
  command?: string;
}

