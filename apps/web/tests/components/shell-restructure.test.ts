/**
 * App-chrome restructure contract.
 *
 * Four user requests are encoded here as source-level guards:
 *   1. the native title bar is gone (the desktop window is frameless),
 *   2. window controls are the app's own traffic lights,
 *   3. the top-right trio (run-status gear, help menu, avatar) is gone,
 *   4. the workspace top tab strip is gone and the collapsible left panel
 *      takes its place, collapsed by default.
 *
 * These are source assertions rather than render assertions because the
 * subject is the composition of the shell itself (which component mounts what,
 * and how the Electron window is created) — a render test of `App` would need
 * the entire daemon surface stubbed to prove a negative about chrome.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../../..');

function readSource(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

const appSource = readSource('apps/web/src/App.tsx');
const entryShellSource = readSource('apps/web/src/components/EntryShell.tsx');
const entryNavRailSource = readSource('apps/web/src/components/EntryNavRail.tsx');
const runtimeSource = readSource('apps/desktop/src/main/runtime.ts');
const preloadSource = readSource('apps/desktop/src/main/preload.cts');
const shellCssSource = readSource('apps/web/src/styles/shell.css');

describe('1. no native title bar', () => {
  it('creates the main desktop window without a native frame', () => {
    // macOS keeps `hiddenInset` (its own traffic lights stay in the inset bar);
    // every other platform is fully frameless.
    expect(runtimeSource).toContain('titleBarStyle: "hiddenInset"');
    expect(runtimeSource).toContain('frame: false as const');
  });

  it('keeps an intentional drag region with non-draggable controls inside it', () => {
    expect(appSource).toContain('app-window-chrome__drag');
    expect(shellCssSource).toMatch(/\.app-window-chrome\s*\{[^}]*-webkit-app-region:\s*drag/s);
    expect(shellCssSource).toMatch(/\.window-controls\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
  });
});

describe('2. traffic-light window controls', () => {
  it('exposes real window IPC from the main process', () => {
    for (const channel of [
      'window:minimize',
      'window:toggle-maximize',
      'window:close',
      'window:get-state',
    ]) {
      expect(runtimeSource).toContain(`ipcMain.handle("${channel}"`);
    }
    // State changes originating outside the renderer must be pushed back.
    expect(runtimeSource).toContain('window:state');
    expect(runtimeSource).toContain('window.on("maximize"');
    expect(runtimeSource).toContain('window.on("unmaximize"');
  });

  it('bridges those channels through the sandboxed preload', () => {
    expect(preloadSource).toContain("ipcRenderer.invoke('window:minimize')");
    expect(preloadSource).toContain("ipcRenderer.invoke('window:toggle-maximize')");
    expect(preloadSource).toContain("ipcRenderer.invoke('window:close')");
    expect(preloadSource).toContain("ipcRenderer.on('window:state'");
  });

  it('mounts the traffic lights in the app chrome', () => {
    expect(appSource).toContain('<WindowControls />');
    expect(appSource).toContain('app-window-chrome');
  });
});

describe('3. the top-right trio is gone', () => {
  it('removes the run-status settings gear from the entry topbar', () => {
    expect(entryShellSource).not.toContain('entry-run-status');
    expect(entryShellSource).not.toContain('entry-run-icon');
  });

  it('removes the avatar settings menu from the entry topbar', () => {
    expect(entryShellSource).not.toContain('<EntrySettingsMenu');
  });

  it('deletes the help menu from the product entirely', () => {
    expect(existsSync(resolve(repoRoot, 'apps/web/src/components/EntryHelpMenu.tsx'))).toBe(false);
    expect(entryShellSource).not.toContain('EntryHelpMenu');
    expect(entryNavRailSource).not.toContain('EntryHelpMenu');
  });

  it('keeps settings reachable from the hub rail footer gear', () => {
    const railFooter = readSource('apps/web/src/components/hub/HubRailFooter.tsx');
    expect(railFooter).toContain('hub-footer-settings');
    expect(railFooter).toContain('onOpenSettings');
    // And the hub still forwards a settings opener into that footer.
    expect(entryShellSource).toContain('onOpenSettings');
  });
});

describe('4. unified shell', () => {
  it('no longer renders the workspace top tab strip', () => {
    expect(appSource).not.toContain('<WorkspaceTabsBar');
  });

  it('drops the workspace top-right tab-search icon with the strip', () => {
    // The search icon lived in `.workspace-tabs-actions` inside the strip;
    // with the strip unmounted no workspace chrome renders a search glyph.
    expect(appSource).not.toContain('workspace-tabs-actions');
    expect(appSource).not.toContain('Search tabs');
  });

  it('mounts the collapsible left panel on the workspace, collapsed by default', () => {
    expect(appSource).toContain('<EntryNavRail');
    expect(appSource).toContain('workspace-rail-host');
    expect(appSource).toContain('workspace-rail-toggle');
    // Collapsed on a cold start.
    expect(appSource).toMatch(/useState<boolean>\(false\)/);
    // Shares the hub's persisted key so the two surfaces agree.
    expect(appSource).toContain('readable.entry.railOpen');
  });

  it('keeps the transition wrapper between the shell body and the view root', () => {
    // entry-layout.css selectors were deliberately loosened to descendant form
    // to survive this wrapper; do not regress it back to a direct child.
    expect(appSource).toContain('workspace-shell__body');
    expect(appSource).toContain('workspaceTransition.surface');
    expect(appSource).toContain('data-transition={surfaceTransition}');
  });
});

describe('removing the tab strip does not orphan the non-file workspace surfaces', () => {
  // The terminal, the side-chat and the Questions panel are hosted by the
  // in-project FILE tab strip (`FileWorkspace`), which is a different component
  // from the workspace tab strip removed above. Their permanent home is the
  // left panel's session tree; this guard only proves this change did not
  // foreclose that by breaking them in the meantime.
  const fileWorkspaceSource = readSource('apps/web/src/components/FileWorkspace.tsx');

  it('leaves FileWorkspace independent of the removed workspace tab strip', () => {
    expect(fileWorkspaceSource).not.toContain('WorkspaceTabsBar');
  });

  it('keeps the terminal, side-chat and Questions hosts wired', () => {
    expect(fileWorkspaceSource).toContain('QUESTIONS_TAB');
    expect(fileWorkspaceSource).toContain('isTerminalTabId');
    expect(fileWorkspaceSource).toContain('isSideChatTabId');
    // The launcher that opens a terminal / side-chat is still mounted.
    expect(fileWorkspaceSource).toContain('TabLauncherMenu');
    expect(fileWorkspaceSource).toContain('openWorkspaceTabLauncher');
  });
});
