import { expect, test as base } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { createProjectViaApi, gotoEntryHome, gotoProject, openSettingsDialog } from '@/playwright/amr';
import { applyStandardMocks, STORAGE_KEY } from '@/playwright/mock-factory';
import {
  clearReachabilityHistory,
  expectPageInteractivesReachable,
  installReachabilitySentinel,
} from '@/playwright/reachability';

const test = base.extend<{ reachabilitySentinel: void }>({
  reachabilitySentinel: [async ({ page }, use) => {
    await installReachabilitySentinel(page);
    await use();
  }, { auto: true }],
});

type Theme = 'light' | 'dark';

async function seedTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript(({ key, themeValue }) => {
    const raw = localStorage.getItem(key);
    const config: Record<string, unknown> = raw ? JSON.parse(raw) : {};
    config.theme = themeValue;
    localStorage.setItem(key, JSON.stringify(config));
  }, { key: STORAGE_KEY, themeValue: theme });
}

async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

async function auditTransition(page: Page, testInfo: TestInfo): Promise<void> {
  await nextPaint(page);
  await expectPageInteractivesReachable(page, { phase: 'observed-transition', testInfo });
}

const SURFACE_MATRIX: readonly {
  readonly theme: Theme;
  readonly viewport: { readonly width: number; readonly height: number };
}[] = [
  { theme: 'light', viewport: { width: 1280, height: 900 } },
  { theme: 'dark', viewport: { width: 760, height: 720 } },
];

for (const { theme, viewport } of SURFACE_MATRIX) {
  test(`[P0] discovered controls remain pointer-reachable on Home and overlays (${theme}, ${viewport.width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await applyStandardMocks(page);
    await seedTheme(page, theme);
    await gotoEntryHome(page);
    await expect(page.getByTestId('hub-nav')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    // The list of controls is intentionally not encoded here. Every semantic
    // interactive currently painted on each reached surface is discovered.
    await clearReachabilityHistory(page);
    const home = await expectPageInteractivesReachable(page, { phase: 'settled', testInfo });
    expect(home.audited, 'Home must expose controls or the discovery guard is vacuous').toBeGreaterThan(0);

    await clearReachabilityHistory(page);
    await page.getByTestId('hub-library').click();
    await expect(page.getByTestId('hub-library-projects')).toBeVisible();
    await expectPageInteractivesReachable(page, { phase: 'immediate', testInfo });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('hub-library-projects')).toBeHidden();
    await auditTransition(page, testInfo);

    await clearReachabilityHistory(page);
    await page.getByTestId('hub-new-project').click();
    const newProject = page.getByTestId('new-project-modal');
    await expect(newProject).toBeVisible();
    await expectPageInteractivesReachable(page, { phase: 'settled', testInfo });
    await page.keyboard.press('Escape');
    await expect(newProject).toHaveCount(0);
    await auditTransition(page, testInfo);

    // On the narrow case this also puts the Settings close chrome into the
    // top drag-band geometry identified by the audit. DOM hit testing covers
    // ordinary overlays; native Electron app-region behavior remains a
    // separate packaged-app check.
    await clearReachabilityHistory(page);
    const settings = await openSettingsDialog(page);
    await expectPageInteractivesReachable(page, { phase: 'settled', testInfo });
    await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);
    await auditTransition(page, testInfo);
  });
}
    const kanbanProjectId = `reachability-kanban-${theme}-${viewport.width}-${Date.now()}`;
    const kanbanProjectName = `Reachability kanban card ${theme} ${viewport.width} ${kanbanProjectId}`;
    await createProjectViaApi(page, kanbanProjectId, kanbanProjectName);
    // The broad Home audit cannot discover hover-only row actions while they
    // correctly have pointer-events:none. Drive the real disclosure and
    // overflow path, then audit the portalled menu while it arbitrates input.
    // This catches stacking contexts from the rail (including the row's action
    // layer) covering an Open item that remains visibly painted above them.
    const hubProject = page.getByTestId(`hub-project-${kanbanProjectId}`);
    await expect(hubProject).toBeVisible();
    const servedHubSignature = await page.evaluate(() => [...document.styleSheets].some((sheet) => {
      try { return [...sheet.cssRules].some((rule) => rule.cssText.includes('.hub-row__actions')); }
      catch { return false; }
    }));
    expect(servedHubSignature, 'cold served CSS must contain the hub action signature').toBe(true);
    const projectMenuTrigger = page.getByTestId(`hub-menu-project-${kanbanProjectId}`);
    const railCollapsed = await page.locator('.hub').getAttribute('data-rail-collapsed');
    if (railCollapsed === 'true') {
      await hubProject.hover();
      const projectFlyout = page.getByTestId('hub-project-flyout');
      await expect(projectFlyout).toBeVisible();
      await clearReachabilityHistory(page);
      const flyoutAudit = await expectPageInteractivesReachable(page, { phase: 'settled', testInfo });
      expect(flyoutAudit.audited, 'Collapsed project flyout must expose controls or the guard is vacuous').toBeGreaterThan(0);
      await page.getByTestId('hub-project-flyout-new-session').click();
      await expect(page).toHaveURL(new RegExp(`/projects/${kanbanProjectId}`));
    } else {
      const title = hubProject.locator(':scope > .hub-row__title');
      if (await hubProject.getAttribute('aria-expanded') !== 'true') await title.click();
      await expect(hubProject).toHaveAttribute('aria-expanded', 'true');
      await title.hover();
      await projectMenuTrigger.click();
      const projectMenu = page.getByTestId('hub-row-menu');
      const projectOpen = page.getByTestId('hub-row-menu-open');
      await expect(projectMenu).toBeVisible();
      await expect(projectOpen).toBeVisible();
      await clearReachabilityHistory(page);
      const rowMenu = await expectPageInteractivesReachable(page, { phase: 'settled', testInfo });
      expect(rowMenu.audited, 'Project row menu must expose controls or the guard is vacuous').toBeGreaterThan(0);
      await projectOpen.click();
      await expect(page).toHaveURL(new RegExp(`/projects/${kanbanProjectId}`));
    }

    // Project cards were previously outside discovery, so an opaque card title
    // and the native drag chrome could both cover the kanban delete control
    // while the broad guard remained green. Audit both the fresh board and the
    // real return path: opening a far-right status card and coming back causes
    // actionability/focus scrolling that a direct `/projects` visit never does.
    // Do not pre-hover the close action: that was the old guard's blind spot,
    // because it repaired the pointer-disabled state before auditing it.
    await page.goto('/projects');
    await expect(page.locator('.design-grid')).toBeVisible();
    await page.getByTestId('designs-view-kanban').click();
    const kanbanCard = page.locator('.design-kanban-card', { hasText: kanbanProjectName });
    await expect(kanbanCard).toBeVisible();
    await expect(kanbanCard.locator('.design-card-close')).toBeVisible();
    await clearReachabilityHistory(page);
    const projects = await expectPageInteractivesReachable(page, { phase: 'settled', testInfo });
    expect(projects.audited, 'Projects must expose controls or the discovery guard is vacuous').toBeGreaterThan(0);

    await kanbanCard.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${kanbanProjectId}`));
    await page.getByRole('button', { name: /back to projects/i }).click();
    await expect(page.locator('.design-kanban-board')).toBeVisible();
    const returnedCard = page.locator('.design-kanban-card', { hasText: kanbanProjectName });
    const returnedDelete = returnedCard.locator('.design-card-close');
    await expect(returnedDelete).toBeVisible();
    await clearReachabilityHistory(page);
    const returnedProjects = await expectPageInteractivesReachable(page, { phase: 'settled', testInfo });
    expect(returnedProjects.audited, 'Returned Projects must expose controls or the guard is vacuous').toBeGreaterThan(0);
    await returnedDelete.click();
    const deleteDialog = page.locator('.modal-confirm');
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole('button', { name: /^cancel$/i }).click();

    await gotoEntryHome(page);
