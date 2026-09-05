import { expect, test as base } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { gotoEntryHome, openSettingsDialog } from '@/playwright/amr';
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
