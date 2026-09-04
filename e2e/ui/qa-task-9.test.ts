// QA for todo 9 — "Restore navigation destinations and the entry chrome".
//
// The regression under test: `EntryShell` suppresses the legacy icon rail on
// the home route, which left every entry destination unreachable from the
// start surface (defects #37-#46, #73-#75). The restoration follows the
// approved mockup — a rail-footer "library" menu plus a presentational user
// row, and a topbar carrying the run-status icon, help and the avatar — rather than
// reinstating the old always-visible rail.
//
// Two things this file deliberately does NOT do:
//   * it does not mock `/api/projects`, because the zero-session case has to
//     be proven against the real daemon store; and
//   * it does not accept a changed `window.location.pathname` as proof. A
//     pushState with a dead view would satisfy that. Every destination check
//     asserts the pathname AND that the destination's own content actually
//     mounted and became visible.

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { applyStandardMocks } from '@/playwright/mock-factory';

const DAEMON_PORT = Number(process.env.READABLE_PORT) || 17_456;
const DAEMON_BASE = `http://127.0.0.1:${DAEMON_PORT}`;
// Absolute on purpose. Playwright resolves a relative screenshot path against
// its own output directory, and a checkout-relative path would strand the
// evidence inside whichever worktree happened to run the spec — `.omo/` is
// gitignored, so that copy is invisible to everything downstream and dies with
// the worktree. `READABLE_EVIDENCE_DIR` lets a runner redirect it.
const EVIDENCE_DIR =
  process.env.READABLE_EVIDENCE_DIR ?? 'D:/readable-studio/.omo/evidence/task-9';

/**
 * One destination = one interaction from home. `mount` is the element that
 * only exists when that view has really rendered, so a route change with a
 * blank pane fails instead of passing.
 */
interface Destination {
  id: string;
  pathname: string;
  /** Performs the single interaction that reaches the destination. */
  reach: (page: Page) => Promise<void>;
  /** Content that proves the destination mounted. */
  mount: (page: Page) => Locator;
}

/** The library menu is one interaction: the trigger is the menu's own row. */
async function viaLibrary(page: Page, testId: string): Promise<void> {
  await page.getByTestId('hub-library').click();
  await expect(page.getByTestId('hub-library-menu')).toBeVisible();
  await page.getByTestId(testId).click();
}

const DESTINATIONS: Destination[] = [
  {
    id: 'projects',
    pathname: '/projects',
    reach: (page) => viaLibrary(page, 'hub-library-projects'),
    mount: (page) =>
      page.locator('[data-testid="entry-view-projects"] .entry-section__title'),
  },
  {
    id: 'tasks',
    pathname: '/automations',
    reach: (page) => viaLibrary(page, 'hub-library-tasks'),
    mount: (page) => page.getByTestId('tasks-view'),
  },
  {
    id: 'design-systems',
    pathname: '/design-systems',
    reach: (page) => viaLibrary(page, 'hub-library-design-systems'),
    mount: (page) => page.getByTestId('design-systems-tab'),
  },
  {
    id: 'plugins',
    pathname: '/plugins',
    reach: (page) => viaLibrary(page, 'hub-library-plugins'),
    mount: (page) => page.getByTestId('plugins-create-button'),
  },
  {
    id: 'integrations',
    pathname: '/integrations',
    reach: (page) => viaLibrary(page, 'hub-library-integrations'),
    mount: (page) => page.getByTestId('integrations-tab-mcp').first(),
  },
];

/**
 * The legacy icon rail still renders its own help launcher for the non-home
 * views it owns, but on home its grid track is 0-wide, clipped and
 * `pointer-events: none` — that unreachable copy is the defect, not the fix.
 * Every home assertion therefore addresses the topbar copy explicitly.
 */
function topbar(page: Page): Locator {
  return page.locator('.entry-main__topbar');
}

async function waitForLoadingToClear(page: Page): Promise<void> {
  await expect(page.locator('.readable-loading-shell')).toHaveCount(0, { timeout: 20_000 });
}

async function gotoHome(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForLoadingToClear(page);
  const privacy = page
    .getByRole('dialog')
    .filter({ hasText: 'Help us improve Readable Studio' });
  if (await privacy.isVisible().catch(() => false)) {
    await privacy
      .getByRole('button', { name: /I get it|not now|got it|don't share/i })
      .click();
  }
  await expect(page.getByTestId('hub-nav')).toBeVisible();
}

/**
 * Seed a project through the daemon that really has NO conversation — the
 * shape defect #38 could not open. `POST /api/projects` always seeds one
 * default conversation "so the UI always has somewhere to write"
 * (`apps/daemon/src/project-routes.ts`), so the session-less state is reached
 * by deleting it, which the daemon permits even for the last one
 * (`apps/daemon/src/server.ts` `DELETE /api/projects/:id/conversations/:cid`).
 * This is a real reachable user state: delete your only session and the
 * project must still be openable. The id is client-supplied so the assertions
 * can address the row directly instead of guessing.
 */
async function seedProjectWithoutSessions(
  page: Page,
  id: string,
  name: string,
): Promise<void> {
  const response = await page.request.post(`${DAEMON_BASE}/api/projects`, {
    data: { id, name, skipDiscoveryBrief: true },
  });
  expect(
    response.ok(),
    `seeding ${id} failed: ${response.status()} ${await response.text()}`,
  ).toBe(true);

  const seeded = await page.request.get(`${DAEMON_BASE}/api/projects/${id}/conversations`);
  expect(seeded.ok()).toBe(true);
  const seededBody = (await seeded.json()) as { conversations?: { id: string }[] };
  for (const conversation of seededBody.conversations ?? []) {
    const removed = await page.request.delete(
      `${DAEMON_BASE}/api/projects/${id}/conversations/${conversation.id}`,
    );
    expect(removed.ok()).toBe(true);
  }

  const after = await page.request.get(`${DAEMON_BASE}/api/projects/${id}/conversations`);
  expect(after.ok()).toBe(true);
  const body = (await after.json()) as { conversations?: unknown[] };
  // The premise of the test: this project really has zero sessions.
  expect(body.conversations ?? []).toHaveLength(0);
}

async function deleteProject(page: Page, id: string): Promise<void> {
  await page.request.delete(`${DAEMON_BASE}/api/projects/${id}`).catch(() => undefined);
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await applyStandardMocks(page);
});

test('[P0] every entry destination is reachable from home in one interaction and actually mounts', async ({
  page,
}) => {
  await gotoHome(page);

  // The footer surfaces are part of the acceptance, not incidental chrome.
  await expect(page.getByTestId('hub-rail-footer')).toBeVisible();
  await expect(page.getByTestId('hub-workspace-row')).toBeVisible();
  await expect(page.getByTestId('hub-library')).toBeVisible();

  for (const destination of DESTINATIONS) {
    await expect(
      page.getByTestId('hub-nav'),
      `${destination.id}: must start from home`,
    ).toBeVisible();

    await destination.reach(page);

    await expect(async () => {
      expect(new URL(page.url()).pathname).toBe(destination.pathname);
    }).toPass({ timeout: 10_000 });

    // misleading_success_output guard: the URL alone is not the assertion.
    // The destination's own content must be visible, and the home surface
    // must have yielded the pane.
    await expect(
      destination.mount(page),
      `${destination.id}: destination did not mount`,
    ).toBeVisible();
    await expect(page.getByTestId('hub-nav')).toBeHidden();

    // Captured AFTER the mount assertion, so the image is of a destination
    // that demonstrably rendered rather than of a bare route change.
    await page.screenshot({
      path: `${EVIDENCE_DIR}/destination-${destination.id}.png`,
    });

    // stale_state guard: return home through the browser's own history so a
    // cached route cannot leave a previously-mounted destination on screen
    // while a later one silently fails to render.
    await page.goBack();
    await expect(page.getByTestId('hub-nav')).toBeVisible();
    await expect(destination.mount(page)).toBeHidden();
    expect(new URL(page.url()).pathname).toBe('/');
  }

  // Help is the sixth destination. It is a topbar menu in the mockup rather
  // than a route, so it is proven by the menu opening with its items.
  const helpTrigger = topbar(page).getByTestId('entry-help-trigger');
  await expect(helpTrigger).toBeVisible();
  await helpTrigger.click();
  const helpMenu = topbar(page).getByTestId('entry-help-menu');
  await expect(helpMenu).toBeVisible();
  await expect(helpMenu.getByTestId('entry-help-help')).toBeVisible();
  await expect(helpMenu.getByTestId('entry-help-feature')).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE_DIR}/destination-help.png` });
  await page.keyboard.press('Escape');
  await expect(helpMenu).toBeHidden();
  await expect(helpTrigger).toBeFocused();
});

test('[P0] a project with zero sessions opens from the tree', async ({ page }) => {
  const projectId = 'qa-task-9-no-sessions';
  await seedProjectWithoutSessions(page, projectId, 'QA task 9 no sessions');

  try {
    await gotoHome(page);

    const row = page.getByTestId(`hub-project-${projectId}`);
    await expect(row).toBeVisible();
    // The row must have no session children — otherwise this is not the
    // defect-#38 case at all. Scope the count to this project's own group so
    // other seeded projects' sessions cannot mask an empty-tree bug.
    await expect(
      page
        .locator(`.hub-tree__node:has([data-testid="hub-project-${projectId}"])`)
        .locator('[data-testid^="hub-session-"]'),
    ).toHaveCount(0);
    await page.screenshot({ path: `${EVIDENCE_DIR}/sessionless-project-in-tree.png` });

    await row.click();

    await expect(async () => {
      expect(new URL(page.url()).pathname).toBe(`/projects/${projectId}`);
    }).toPass({ timeout: 10_000 });
    // Prove the workspace mounted rather than trusting the route.
    await expect(page.getByTestId('hub-nav')).toBeHidden();
    await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('file-workspace')).toBeVisible();
    await page.screenshot({ path: `${EVIDENCE_DIR}/sessionless-project-opened.png` });
  } finally {
    await deleteProject(page, projectId);
  }
});

test('[P0] home renders the mockup rail footer and topbar chrome', async ({ page }) => {
  await gotoHome(page);

  // Rail footer: library menu + presentational identity row.
  const footer = page.getByTestId('hub-rail-footer');
  await expect(footer).toBeVisible();
  const profile = page.getByTestId('hub-workspace-row');
  await expect(profile).toBeVisible();
  await expect(page.getByTestId('hub-footer-settings')).toBeVisible();

  await page.getByTestId('hub-library').click();
  const libraryMenu = page.getByTestId('hub-library-menu');
  await expect(libraryMenu).toBeVisible();
  for (const id of ['tasks', 'design-systems', 'plugins', 'integrations']) {
    await expect(page.getByTestId(`hub-library-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId('hub-workspace-folder')).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE_DIR}/rail-footer-library-menu.png` });
  await page.keyboard.press('Escape');
  await expect(libraryMenu).toBeHidden();
  await expect(page.getByTestId('hub-library')).toBeFocused();

  // Identity is informative, not a disguised control: it has no interactive
  // semantics and clicking it cannot resurrect the deleted profile menu.
  await expect(profile).toHaveJSProperty('tagName', 'DIV');
  await expect(profile).not.toHaveAttribute('role');
  await expect(profile).not.toHaveAttribute('aria-haspopup');
  await expect(profile).not.toHaveAttribute('aria-expanded');
  await expect(profile).not.toHaveAttribute('aria-controls');
  await expect(profile).not.toHaveAttribute('tabindex');
  await profile.click();
  await expect(page.getByTestId('hub-workspace-menu')).toHaveCount(0);
  await expect(page.getByRole('menu')).toHaveCount(0);

  // The workspace-folder action moved into Library and still reaches the
  // project-locations settings section, rather than merely closing its menu.
  await page.getByTestId('hub-library').click();
  await expect(libraryMenu).toBeVisible();
  await page.getByTestId('hub-workspace-folder').click();
  const settingsDialog = page.getByRole('dialog', { name: /.+/ });
  await expect(settingsDialog).toBeVisible();
  await expect(settingsDialog.locator('.project-locations-section')).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE_DIR}/workspace-folder-settings.png` });
  await settingsDialog.locator('.settings-close').click();
  await expect(settingsDialog).toBeHidden();

  // Topbar: icon-form run status, help, avatar.
  const runIcon = page.getByTestId('entry-run-status');
  await expect(runIcon).toBeVisible();
  await expect(runIcon).toHaveClass(/(?:^|\s)entry-run-icon(?:\s|$)/);
  await expect(runIcon).toHaveAttribute('data-live', /true|false/);
  await expect(runIcon).toHaveAttribute('aria-label', /.+/);
  await expect(runIcon).toHaveAttribute('data-tooltip', /.+/);
  await expect(runIcon.locator('.entry-run-icon__dot')).toBeVisible();
  await expect(topbar(page).getByTestId('entry-help-trigger')).toBeVisible();
  await expect(topbar(page).getByTestId('entry-settings-menu-trigger')).toBeVisible();

  await page.screenshot({ path: `${EVIDENCE_DIR}/home-chrome.png`, fullPage: false });
  await page
    .locator('.hub__nav')
    .screenshot({ path: `${EVIDENCE_DIR}/rail-footer.png` });
  await page
    .locator('.entry-main__topbar')
    .screenshot({ path: `${EVIDENCE_DIR}/topbar.png` });
});
