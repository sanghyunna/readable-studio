// Hub -> workspace handoff.
//
// Opening a session from the entry hub reuses the existing project route and
// host workspace-tab event contract: `navigate` drives the URL while an
// embedding host may mirror the route into its own application-level tabs.

import { navigate } from '../../router';
import { openWorkspaceTab } from '../workspaceTabEvents';

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
