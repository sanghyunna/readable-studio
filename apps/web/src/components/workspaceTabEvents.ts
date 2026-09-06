import type { Route } from '../router';

const OPEN_WORKSPACE_TAB_EVENT = 'readable-studio:workspace-tabs:open';

/**
 * Announces route navigation to hosts that maintain an application-level tab
 * model. The in-project file tabs are owned and rendered by FileWorkspace.
 */
export function openWorkspaceTab(
  route: Route,
  options?: { reuseExisting?: boolean },
): void {
  window.dispatchEvent(
    new CustomEvent<{ route: Route; reuseExisting?: boolean }>(OPEN_WORKSPACE_TAB_EVENT, {
      detail: { route, ...(options?.reuseExisting ? { reuseExisting: true } : {}) },
    }),
  );
}
