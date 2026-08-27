// Hub -> workspace handoff.
//
// Opening a session from the entry hub reuses the existing project route and
// workspace-tab contract exactly: `navigate` drives the URL, and the tab bar
// listens for `OPEN_WORKSPACE_TAB_EVENT`. Nothing about ProjectView changes.

import { navigate } from '../../router';
import { openWorkspaceTab } from '../WorkspaceTabsBar';

function openProjectWorkspace(projectId: string, conversationId: string | null): void {
  const route = {
    kind: 'project' as const,
    projectId,
    conversationId,
    fileName: null,
  };
  // Reuse an existing tab for this project instead of stacking a new one:
  // the hub is a place users return to repeatedly.
  openWorkspaceTab(route, { reuseExisting: true });
  navigate(route);
}

export function openProjectRoute(projectId: string): void {
  openProjectWorkspace(projectId, null);
}

export function openSessionRoute(projectId: string, conversationId: string): void {
  openProjectWorkspace(projectId, conversationId);
}
