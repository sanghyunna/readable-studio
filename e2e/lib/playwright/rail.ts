import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Expands the persistent project rail on Hub and workspace surfaces. */
export async function ensureRailOpen(page: Page): Promise<void> {
  const rail = page.locator('[data-project-rail]');
  // The toggle lives in the window-chrome portal, not inside the rail.
  const toggle = page.locator('[data-project-rail-toggle]');
  await expect(rail).toBeVisible();
  await expect(toggle).toBeVisible();
  if ((await rail.getAttribute('data-project-rail-state')) === 'collapsed') {
    await toggle.click();
  }
  await expect(rail).toHaveAttribute('data-project-rail-state', 'expanded');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}
