import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Expands the navigation rail rendered by the current entry view. Home owns
 * the Hub rail; the other entry views use the legacy entry rail.
 */
export async function ensureRailOpen(page: Page): Promise<void> {
  const hubRail = page.getByTestId('hub-nav');
  if (await hubRail.isVisible()) {
    const toggle = page.getByTestId('hub-rail-toggle');
    if ((await toggle.getAttribute('aria-pressed')) === 'true') {
      await toggle.click();
    }
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(hubRail).toBeVisible();
    await expect(page.locator('.hub__new-project')).toBeVisible();
    return;
  }

  const toggle = page.getByTestId('entry-rail-toggle');
  if (await toggle.isVisible()) {
    await toggle.click();
  }
  await expect(page.locator('.entry-nav-rail')).toBeVisible();
}
